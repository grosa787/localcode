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
import { mkdir, rename, unlink, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';

import type { ReleaseInfo, ReleaseAssetInfo } from './types';
import { isRunnableBundleFile } from './artifact-validate';
// DELTA-PATCH-SECTION — imports
import {
  applyPatch,
  isBspatchAvailable,
  BspatchUnavailableError,
  BspatchExecutionError,
  type BspatchRunner,
} from './patcher';
// DELTA-PATCH-SECTION-END

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
    // A runnable `.js` bundle is THE artifact this updater installs (the
    // live binary is launched via `bun cli.js`). Strongly prefer it over
    // platform `.tar.gz`/`.zip` archives, which wrap a NATIVE binary that
    // would corrupt a bun-script install if written over cli.js.
    if (lower.endsWith('.js')) s += 50;
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) s += 2;
    if (lower.endsWith('.zip')) s += 1;
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

  // Refuse to stage a non-JS-bundle artifact for a cli.js target. Release
  // assets are platform `.tar.gz` archives wrapping a native binary;
  // writing one over cli.js corrupts the install (bun then parses gzip as
  // JS → crash). When only such archives are published the updater simply
  // skips this version rather than staging a broken artifact.
  const bundleCheck = await isRunnableBundleFile(destPath);
  if (!bundleCheck.ok) {
    await safeUnlink(destPath);
    return {
      ok: false,
      error: `Downloaded asset "${target.name}" is ${bundleCheck.reason ?? 'not a runnable JS bundle'}; this install needs a cli.js artifact. Skipping.`,
    };
  }

  return {
    ok: true,
    path: destPath,
    digest: target.digest !== null ? target.digest : computed,
  };
}

// DELTA-PATCH-SECTION — public API for binary delta updates.
//
// Flow:
//   1. `findDeltaPatchAsset(release, fromVersion)` scans the release's
//      assets for one named like
//      `localcode-<os>-<arch>-from-<prev>-to-<new>.patch` matching the
//      current platform + previous version. Returns `null` when no
//      such asset is published (every release before delta-patch was
//      shipped, plus releases where the workflow couldn't produce a
//      patch for this platform).
//   2. `downloadDeltaPatch(release, currentBinary, destBinary, opts)`
//      downloads the patch file into the staging dir, runs `bspatch`
//      against the user's currently-installed binary, verifies the
//      resulting SHA-256 matches the new release's full-binary digest,
//      and renames into place atomically. Returns the same
//      `DownloadResult` shape as `downloadTarball` so the caller can
//      treat them interchangeably.
//
// Every failure path (network, missing bspatch, mismatched hash, ...)
// returns `{ ok: false, error }` so the caller can fall back to the
// full-download path without a try/catch. The only thrown error from
// this section is for genuine programmer mistakes (e.g. passing an
// empty path).

/**
 * Suffix the workflow emits for delta-patch assets. Keep in sync with
 * `.github/workflows/release.yml` (`DELTA-PATCH-STEP`).
 */
const DELTA_PATCH_NAME_RE =
  /^localcode-([^-]+)-([^-]+)-from-([^-]+)-to-([^-]+)\.patch$/;

/**
 * Aliases used in asset names. Mirrors `pickDownloadTarget`'s tables so
 * `darwin`/`mac`, `arm64`/`aarch64`, etc. all resolve the same way.
 */
const PLATFORM_ASSET_ALIASES: Record<string, readonly string[]> = {
  darwin: ['darwin', 'mac', 'macos', 'osx'],
  linux: ['linux'],
  win32: ['win', 'win32', 'windows'],
};
const ARCH_ASSET_ALIASES: Record<string, readonly string[]> = {
  arm64: ['arm64', 'aarch64'],
  x64: ['x64', 'x86_64', 'amd64'],
};

export interface DeltaPatchAssetMatch {
  readonly asset: ReleaseAssetInfo;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly platform: string;
  readonly arch: string;
}

/**
 * Find the patch asset that maps `fromVersion` (the currently-installed
 * version) onto the new release. Returns `null` when no asset matches
 * the running platform/arch and version pair.
 *
 * Both `fromVersion` and the asset's `from` token are normalised to
 * `stripVersionPrefix` form (no leading `v`) before comparison.
 */
export function findDeltaPatchAsset(
  release: ReleaseInfo,
  fromVersion: string,
  platform: string = process.platform,
  arch: string = process.arch,
): DeltaPatchAssetMatch | null {
  if (fromVersion.length === 0) return null;
  const normFrom = fromVersion.replace(/^v/i, '');
  const platMatches = PLATFORM_ASSET_ALIASES[platform] ?? [platform];
  const archMatches = ARCH_ASSET_ALIASES[arch] ?? [arch];
  for (const asset of release.assets) {
    const m = DELTA_PATCH_NAME_RE.exec(asset.name);
    if (m === null) continue;
    const assetPlat = (m[1] ?? '').toLowerCase();
    const assetArch = (m[2] ?? '').toLowerCase();
    const assetFrom = (m[3] ?? '').replace(/^v/i, '');
    const assetTo = (m[4] ?? '').replace(/^v/i, '');
    if (!platMatches.includes(assetPlat)) continue;
    if (!archMatches.includes(assetArch)) continue;
    if (assetFrom !== normFrom) continue;
    if (assetTo !== release.version) continue;
    return {
      asset,
      fromVersion: assetFrom,
      toVersion: assetTo,
      platform: assetPlat,
      arch: assetArch,
    };
  }
  return null;
}

/**
 * Resolve the SHA-256 digest the new full binary should hash to after
 * patching. We look for an asset matching the platform-archive name
 * (`localcode-<os>-<arch>.tar.gz` or any asset whose digest is set and
 * whose name contains both the platform + arch). Returns `null` when
 * no anchored digest can be found — caller skips verification in that
 * case and surfaces a warning rather than silently trusting.
 */
function findFullBinaryDigest(
  release: ReleaseInfo,
  platform: string,
  arch: string,
): string | null {
  const platMatches = PLATFORM_ASSET_ALIASES[platform] ?? [platform];
  const archMatches = ARCH_ASSET_ALIASES[arch] ?? [arch];
  for (const asset of release.assets) {
    if (asset.digest === null || asset.digest.length === 0) continue;
    const lower = asset.name.toLowerCase();
    // Exclude the patch asset itself.
    if (lower.endsWith('.patch')) continue;
    if (!platMatches.some((p) => lower.includes(p))) continue;
    if (!archMatches.some((a) => lower.includes(a))) continue;
    return asset.digest;
  }
  return null;
}

export interface DeltaPatchOptions extends DownloadOptions {
  /**
   * Inject a `bspatch` runner. Production callers omit and the default
   * `execa('bspatch', ...)` is used. Tests stub this to avoid needing
   * the real binary on PATH.
   */
  readonly bspatchRunner?: BspatchRunner;
}

/**
 * Download `match.asset` into the staging dir + apply the patch on top
 * of `currentBinaryPath`, producing `destBinaryPath`. Verifies the
 * resulting SHA-256 against the new release's published digest when one
 * is available. Returns `{ ok: false, error }` on any failure so the
 * caller can fall back to a full download without an exception.
 */
export async function downloadDeltaPatch(
  release: ReleaseInfo,
  match: DeltaPatchAssetMatch,
  currentBinaryPath: string,
  destBinaryPath: string,
  opts: DeltaPatchOptions = {},
): Promise<DownloadResult> {
  if (currentBinaryPath.length === 0) {
    return { ok: false, error: 'currentBinaryPath is empty' };
  }
  // 1. Make sure bspatch is available before we waste bytes on the
  // network. Cheap PATH probe; cached after the first call.
  const runner = opts.bspatchRunner;
  try {
    const ok = runner !== undefined
      ? await isBspatchAvailable(runner)
      : await isBspatchAvailable();
    if (!ok) {
      return { ok: false, error: 'bspatch not available on PATH' };
    }
  } catch (err) {
    return { ok: false, error: `bspatch probe failed: ${formatError(err)}` };
  }

  // 2. Make sure the source binary exists + is readable. Without it we
  // can't apply the patch.
  try {
    const s = await stat(currentBinaryPath);
    if (s.size === 0) {
      return { ok: false, error: `Current binary is empty: ${currentBinaryPath}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Cannot read current binary ${currentBinaryPath}: ${formatError(err)}`,
    };
  }

  // 3. Download the patch into the staging dir (tmp + rename).
  const patchDest = join(dirname(destBinaryPath), `${match.asset.name}`);
  const patchDownload = await downloadAssetByName(
    release,
    match.asset,
    patchDest,
    opts,
  );
  if (!patchDownload.ok || patchDownload.path === undefined) {
    return {
      ok: false,
      ...(patchDownload.error !== undefined ? { error: patchDownload.error } : {}),
    };
  }

  // 4. Apply the patch into a sibling tmp file so we never half-write
  // over `destBinaryPath`.
  const tmpOut = `${destBinaryPath}.${randomUUID()}.patch.tmp`;
  try {
    if (runner !== undefined) {
      await applyPatch(currentBinaryPath, patchDownload.path, tmpOut, runner);
    } else {
      await applyPatch(currentBinaryPath, patchDownload.path, tmpOut);
    }
  } catch (err) {
    await safeUnlink(tmpOut);
    if (err instanceof BspatchUnavailableError) {
      return { ok: false, error: `bspatch unavailable: ${err.message}` };
    }
    if (err instanceof BspatchExecutionError) {
      return {
        ok: false,
        error: `bspatch failed (exit ${err.exitCode}): ${err.stderr.slice(0, 200)}`,
      };
    }
    return { ok: false, error: `Patch apply failed: ${formatError(err)}` };
  }

  // 5. Verify SHA-256 against the published new-binary digest when we
  // can resolve one. Mismatch is a hard fail — fall back to full DL.
  const expectedDigest = findFullBinaryDigest(release, match.platform, match.arch);
  let computed: string | null = null;
  try {
    const bytes = await readFile(tmpOut);
    const hash = createHash('sha256').update(bytes).digest('hex');
    computed = `sha256:${hash}`;
    if (bytes.byteLength === 0) {
      await safeUnlink(tmpOut);
      return { ok: false, error: 'Patched binary is empty' };
    }
  } catch (err) {
    await safeUnlink(tmpOut);
    return { ok: false, error: `Post-patch hash failed: ${formatError(err)}` };
  }
  if (expectedDigest !== null && !digestMatches(computed, expectedDigest)) {
    await safeUnlink(tmpOut);
    return {
      ok: false,
      error: `Post-patch SHA-256 mismatch: expected ${expectedDigest}, got ${computed}`,
    };
  }

  // 6. Atomic rename into place.
  try {
    await mkdir(dirname(destBinaryPath), { recursive: true });
    await rename(tmpOut, destBinaryPath);
  } catch (err) {
    await safeUnlink(tmpOut);
    return { ok: false, error: `Rename failed: ${formatError(err)}` };
  }

  return {
    ok: true,
    path: destBinaryPath,
    digest: expectedDigest ?? computed,
  };
}

/**
 * Internal — download a single named asset (not chosen by
 * `pickDownloadTarget`, but explicitly resolved by the delta-patch
 * matcher). Mirrors `downloadTarball`'s atomicity + verification
 * behaviour but skips the platform-asset scoring loop.
 */
async function downloadAssetByName(
  release: ReleaseInfo,
  asset: ReleaseAssetInfo,
  destPath: string,
  opts: DownloadOptions,
): Promise<DownloadResult> {
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
    response = await fetchFn(asset.downloadUrl, {
      headers: {
        'User-Agent': 'localcode-updater',
        Accept: 'application/octet-stream',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: `Network error: ${formatError(err)}` };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status} ${response.statusText}` };
  }
  if (response.body === null) {
    return { ok: false, error: 'Empty response body' };
  }

  const tmp = `${destPath}.${randomUUID()}.tmp`;
  const hash = createHash('sha256');
  const sink = createWriteStream(tmp);

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

  const computed = `sha256:${hash.digest('hex')}`;
  if (asset.digest !== null && asset.digest.length > 0) {
    if (!digestMatches(computed, asset.digest)) {
      await safeUnlink(tmp);
      return {
        ok: false,
        error: `Patch SHA-256 mismatch: expected ${asset.digest}, got ${computed}`,
      };
    }
  }

  try {
    await rename(tmp, destPath);
  } catch (err) {
    await safeUnlink(tmp);
    return { ok: false, error: `Rename failed: ${formatError(err)}` };
  }

  return {
    ok: true,
    path: destPath,
    digest: asset.digest !== null && asset.digest.length > 0 ? asset.digest : computed,
  };
}
// DELTA-PATCH-SECTION-END

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
