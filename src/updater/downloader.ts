/**
 * Background downloader for the auto-updater.
 *
 * Pulls the binary asset (or source tarball) for a `ReleaseInfo` into a
 * staging directory under `~/.localcode/updates/<version>/`.
 *
 * Atomicity: bytes are streamed to a `<dest>.tmp` file (in the same
 * directory so `rename` is a single inode operation) and only swapped
 * onto the final path after the optional SHA-256 verification succeeds.
 *
 * Errors never throw; every public function returns a structured
 * `{ ok, error? }` result so the scheduler can record diagnostics
 * without an unhandled rejection.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';

import type { ReleaseInfo } from './types';

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000; // 5 min for the full body

export interface DownloadProgress {
  readonly bytesDownloaded: number;
  readonly totalBytes: number | null;
}

export interface DownloadOptions {
  /** Override fetch (tests). */
  readonly fetchFn?: typeof globalThis.fetch;
  /** Progress callback invoked every chunk; safe to omit. */
  readonly onProgress?: (p: DownloadProgress) => void;
  /** Total request timeout. */
  readonly timeoutMs?: number;
  /** AbortController factory (tests). */
  readonly abortControllerCtor?: typeof AbortController;
}

export interface DownloadResult {
  readonly ok: boolean;
  /** Final on-disk path of the downloaded artefact (only when `ok`). */
  readonly path?: string;
  /** Verified digest, e.g. `sha256:<hex>`. Null when no digest was published. */
  readonly digest?: string | null;
  /** Diagnostic message when `ok=false`. */
  readonly error?: string;
}

/**
 * Resolve the staging directory we use for a target version, e.g.
 * `~/.localcode/updates/0.20.0/`. Exported so the applier + tests can
 * share the same path computation.
 */
export function getStagingDir(version: string): string {
  return join(homedir(), '.localcode', 'updates', version);
}

/**
 * Return the absolute path to the pending-update manifest. Sat next to
 * the staging dirs, used by the apply-on-restart flow.
 */
export function getPendingManifestPath(): string {
  return join(homedir(), '.localcode', 'updates', 'pending.json');
}

/**
 * Pick the best asset for the current platform. Prefers files whose
 * name contains both the OS family and CPU arch; falls back to
 * "looks like a bundled JS / tarball" matches in that order, and
 * ultimately the GitHub-generated source `tarball_url` when no asset is
 * suitable.
 *
 * Exported so the CLI subcommand can preview what would be downloaded.
 */
export function pickDownloadTarget(release: ReleaseInfo): {
  url: string;
  name: string;
  sizeBytes: number;
  digest: string | null;
} {
  const platform = process.platform; // 'darwin' | 'linux' | 'win32' | ...
  const arch = process.arch;
  const platformAliases: Record<string, readonly string[]> = {
    darwin: ['darwin', 'mac', 'macos', 'osx'],
    linux: ['linux'],
    win32: ['win', 'win32', 'windows'],
  };
  const archAliases: Record<string, readonly string[]> = {
    arm64: ['arm64', 'aarch64'],
    x64: ['x64', 'x86_64', 'amd64'],
  };
  const platMatches = platformAliases[platform] ?? [platform];
  const archMatches = archAliases[arch] ?? [arch];

  const score = (name: string): number => {
    const lower = name.toLowerCase();
    let s = 0;
    if (platMatches.some((p) => lower.includes(p))) s += 10;
    if (archMatches.some((a) => lower.includes(a))) s += 5;
    // Bun-built single-file bundles tend to be plain `.js` or unsuffixed.
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) s += 2;
    if (lower.endsWith('.zip')) s += 1;
    if (lower.endsWith('.js')) s += 3;
    return s;
  };

  const sortedAssets = [...release.assets].sort(
    (a, b) => score(b.name) - score(a.name),
  );
  const best = sortedAssets[0];
  if (best !== undefined && score(best.name) > 0) {
    return {
      url: best.downloadUrl,
      name: best.name,
      sizeBytes: best.sizeBytes,
      digest: best.digest,
    };
  }

  // Fall back to the GitHub-generated source archive. No digest is
  // published for these — caller treats undefined digest as "trust the
  // download" (acceptable for a network operation gated on user
  // confirmation; we still warn in the CLI subcommand).
  return {
    url: release.tarballUrl,
    name: `${release.tagName}.tar.gz`,
    sizeBytes: 0,
    digest: null,
  };
}

/**
 * Download the chosen asset for `release` into `destPath`. Returns
 * `{ ok: true, path, digest }` on success or `{ ok: false, error }` on
 * any failure.
 */
export async function downloadTarball(
  release: ReleaseInfo,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const target = pickDownloadTarget(release);
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const AbortCtor = opts.abortControllerCtor ?? AbortController;

  try {
    await mkdir(dirname(destPath), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `Failed to prepare staging dir: ${formatError(err)}`,
    };
  }

  const ctrl = new AbortCtor();
  const timer = setTimeout(() => {
    try {
      ctrl.abort();
    } catch {
      /* swallow */
    }
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(target.url, {
      headers: {
        'User-Agent': 'localcode-updater',
        Accept: 'application/octet-stream',
      },
      signal: ctrl.signal,
      // GitHub redirects to S3 — follow.
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: `Network error: ${formatError(err)}` };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return {
      ok: false,
      error: `HTTP ${response.status} ${response.statusText}`,
    };
  }
  if (response.body === null) {
    return { ok: false, error: 'Empty response body' };
  }

  const tmp = `${destPath}.${randomUUID()}.tmp`;
  const hash = createHash('sha256');
  let bytesDownloaded = 0;
  const total = parseContentLength(response) ?? (target.sizeBytes > 0 ? target.sizeBytes : null);

  // Tee the response body into the file sink AND the hash. We avoid
  // `Readable.fromWeb` (the Bun + Node lib type narrows disagree on
  // the source class) by driving the reader directly + writing chunks
  // to a Node WriteStream.
  const sink = createWriteStream(tmp);
  const onProgress = opts.onProgress;

  const writeChunk = (chunk: Uint8Array): Promise<void> =>
    new Promise<void>((resolveCb, rejectCb) => {
      const ok = sink.write(chunk, (err) => {
        if (err) rejectCb(err);
        else if (ok) resolveCb();
      });
      if (!ok) {
        sink.once('drain', resolveCb);
      }
    });

  try {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          hash.update(value);
          bytesDownloaded += value.byteLength;
          if (onProgress !== undefined) {
            try {
              onProgress({ bytesDownloaded, totalBytes: total });
            } catch {
              /* swallow */
            }
          }
          await writeChunk(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* swallow */
      }
    }
    await new Promise<void>((resolveCb, rejectCb) => {
      sink.end((err?: unknown) => {
        if (err !== undefined && err !== null) rejectCb(err);
        else resolveCb();
      });
    });
  } catch (err) {
    try {
      sink.destroy();
    } catch {
      /* swallow */
    }
    await safeUnlink(tmp);
    return { ok: false, error: `Write failed: ${formatError(err)}` };
  }
  // Touch pipeline so the import stays in case future implementations
  // switch back to the streaming pipeline helper.
  void pipeline;

  const digestHex = hash.digest('hex');
  const computed = `sha256:${digestHex}`;

  if (target.digest !== null && target.digest.length > 0) {
    if (!digestMatches(computed, target.digest)) {
      await safeUnlink(tmp);
      return {
        ok: false,
        error: `SHA-256 mismatch: expected ${target.digest}, got ${computed}`,
      };
    }
  }

  try {
    await rename(tmp, destPath);
  } catch (err) {
    await safeUnlink(tmp);
    return { ok: false, error: `Rename failed: ${formatError(err)}` };
  }

  // Sanity-check the file actually exists with non-zero size.
  try {
    const s = await stat(destPath);
    if (s.size === 0) {
      return { ok: false, error: 'Downloaded file is empty' };
    }
  } catch (err) {
    return { ok: false, error: `Stat failed: ${formatError(err)}` };
  }

  return {
    ok: true,
    path: destPath,
    digest: target.digest !== null ? target.digest : computed,
  };
}

function parseContentLength(response: Response): number | null {
  const v = response.headers.get('content-length');
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch {
    /* swallow */
  }
}

function digestMatches(computed: string, expected: string): boolean {
  // Expected may be `sha256:<hex>` or a bare hex digest. Normalise both
  // sides to lower-case `sha256:<hex>` before comparing.
  const norm = (s: string): string => {
    const lower = s.trim().toLowerCase();
    if (lower.startsWith('sha256:')) return lower;
    return `sha256:${lower}`;
  };
  return norm(computed) === norm(expected);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
