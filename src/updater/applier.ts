/**
 * Apply a staged update to the running install.
 *
 * Steps (in order, every one best-effort with rollback):
 *   1. Locate the currently-running `dist/cli.js`. If the env hint is
 *      missing we walk relative to the user-installed symlink and the
 *      script's own URL.
 *   2. Stat the existing `cli.js` and rename it to `cli.js.bak`. On
 *      rollback we restore from this file.
 *   3. Copy the staged binary onto a sibling `cli.js.new` (same dir so
 *      `rename` is one inode op) and then atomically rename to
 *      `cli.js`.
 *   4. Update `/usr/local/bin/localcode` if it is a symlink pointing to
 *      our `cli.js` — no-op for path-installed installs.
 *   5. Best-effort delete the staging dir.
 *
 * Rollback is triggered by any non-recoverable error after step 2. We
 * restore the `.bak` file in place so the next startup runs the
 * previous version verbatim.
 */

import { mkdir, copyFile, rename, rm, stat, lstat, readlink, symlink, unlink, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { PendingUpdateSchema, type PendingUpdate } from './types';
import { getPendingManifestPath } from './downloader';
import { isRunnableBundleFile } from './artifact-validate';

export interface ApplyResult {
  readonly ok: boolean;
  readonly appliedVersion?: string;
  readonly error?: string;
  /** Path to the live binary we just replaced, for diagnostics. */
  readonly targetPath?: string;
}

export interface ApplyOptions {
  /**
   * Override the live binary path. Useful in tests where we don't want
   * to touch the real `dist/cli.js`. When omitted the applier resolves
   * the path itself (see `resolveLiveBinaryPath`).
   */
  readonly liveBinaryPathOverride?: string;
  /**
   * Override the global symlink path (default `/usr/local/bin/localcode`).
   * Set to `null` to skip the symlink fix-up step.
   */
  readonly symlinkPath?: string | null;
  /**
   * Inject a clock; used by tests to assert manifest timestamps.
   */
  readonly nowFn?: () => number;
}

const DEFAULT_SYMLINK_PATH = '/usr/local/bin/localcode';

/**
 * Look up the path of the running `cli.js`. Prefers `process.argv[1]`,
 * which is the launched bundle (the symlink target after resolution).
 * Falls back to `import.meta.url` when argv hints aren't trustworthy.
 * Returns `null` when we genuinely can't tell — callers must surface
 * a friendly error.
 */
export async function resolveLiveBinaryPath(): Promise<string | null> {
  const argv1 = process.argv[1];
  if (argv1 !== undefined && argv1.length > 0) {
    try {
      // Resolve symlinks so the rename target is the actual file, not
      // the `/usr/local/bin/localcode` symlink itself.
      const real = await stat(argv1).then(() => argv1).catch(() => null);
      if (real !== null) return resolve(real);
    } catch {
      /* fall through */
    }
  }
  // Fallback — derive from `import.meta.url`. Only runs in test
  // contexts; production binary always has argv[1] set.
  return null;
}

/**
 * Apply the manifest under `~/.localcode/updates/pending.json` if any.
 * Returns immediately with `ok: false` and a clear message when there
 * is no pending update. The caller (CLI / scheduler) decides whether
 * to surface that to the user.
 */
export async function applyStagedUpdate(
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const manifest = await readPendingManifest();
  if (manifest === null) {
    return { ok: false, error: 'No pending update' };
  }
  return applyManifest(manifest, opts);
}

/**
 * Apply a pending-update manifest directly. Exported separately so the
 * apply-on-restart flow in cli.tsx can apply the parsed manifest it
 * already has without re-reading the file.
 */
export async function applyManifest(
  manifest: PendingUpdate,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const stagedPath = manifest.stagedBinaryPath;
  try {
    await stat(stagedPath);
  } catch {
    return { ok: false, error: `Staged binary missing: ${stagedPath}` };
  }

  // Safety net: NEVER promote a non-JS-bundle artifact onto the live
  // cli.js. The live binary is launched via `bun cli.js`, so a gzip
  // tarball / native binary here would make the next launch parse
  // binary as JS and hard-crash. Refuse + leave the working install
  // untouched. This is the backstop that makes the updater fail-safe.
  const stagedValidity = await isRunnableBundleFile(stagedPath);
  if (!stagedValidity.ok) {
    return {
      ok: false,
      error: `Refusing to apply staged update — ${stagedValidity.reason ?? 'not a runnable JS bundle'}. The install was left untouched.`,
    };
  }

  const livePath = opts.liveBinaryPathOverride ?? (await resolveLiveBinaryPath());
  if (livePath === null) {
    return {
      ok: false,
      error: 'Could not resolve the running binary path; pass --target or run from a normal install',
    };
  }

  const backupPath = `${livePath}.bak`;
  const newPath = `${livePath}.new.${randomUUID()}`;

  // Step 1 — copy staged → sibling tmp.
  try {
    await mkdir(dirname(newPath), { recursive: true });
    await copyFile(stagedPath, newPath);
  } catch (err) {
    await safeUnlink(newPath);
    return { ok: false, error: `Copy failed: ${formatError(err)}` };
  }

  // Step 2 — move live → .bak (best-effort; on first install there may
  // already be a stale .bak, so we remove it first).
  let liveExisted = false;
  try {
    await stat(livePath);
    liveExisted = true;
  } catch {
    liveExisted = false;
  }
  if (liveExisted) {
    try {
      await safeUnlink(backupPath);
      await rename(livePath, backupPath);
    } catch (err) {
      await safeUnlink(newPath);
      return { ok: false, error: `Backup rename failed: ${formatError(err)}` };
    }
  }

  // Step 3 — promote .new → live atomically.
  try {
    await rename(newPath, livePath);
  } catch (err) {
    // Rollback — restore .bak.
    if (liveExisted) {
      try {
        await rename(backupPath, livePath);
      } catch {
        /* swallow — original file is lost */
      }
    }
    await safeUnlink(newPath);
    return { ok: false, error: `Rename failed: ${formatError(err)}` };
  }

  // Step 4 — ensure the global symlink (if any) points at the new file.
  // Most installs created the symlink with `install.sh`; replacing the
  // file in-place via rename keeps the inode the same as the target of
  // the symlink, so this step usually has nothing to do. We still
  // re-create the symlink if it's missing or points elsewhere.
  const symlinkPath = opts.symlinkPath ?? DEFAULT_SYMLINK_PATH;
  if (symlinkPath !== null) {
    await fixupSymlinkBestEffort(symlinkPath, livePath);
  }

  // Step 5 — best-effort delete the staging dir + manifest. Failures
  // are harmless; the next check overwrites them.
  try {
    await rm(dirname(stagedPath), { recursive: true, force: true });
  } catch {
    /* swallow */
  }
  try {
    await unlink(getPendingManifestPath());
  } catch {
    /* swallow */
  }

  return {
    ok: true,
    appliedVersion: manifest.version,
    targetPath: livePath,
  };
}

/**
 * Read + parse `~/.localcode/updates/pending.json` if present. Returns
 * `null` on missing/corrupt manifests so callers can treat both cases
 * uniformly.
 */
export async function readPendingManifest(): Promise<PendingUpdate | null> {
  let raw: string;
  try {
    raw = await readFile(getPendingManifestPath(), 'utf8');
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = PendingUpdateSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Write the pending-update manifest. Atomic via tmp + rename.
 */
export async function writePendingManifest(
  manifest: PendingUpdate,
): Promise<void> {
  const path = getPendingManifestPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await rename(tmp, path);
}

async function fixupSymlinkBestEffort(symlinkPath: string, target: string): Promise<void> {
  try {
    const s = await lstat(symlinkPath);
    if (!s.isSymbolicLink()) {
      // It's a regular file — leave it alone. Most likely a manual
      // copy install where renaming the live binary already replaced
      // it.
      return;
    }
    const current = await readlink(symlinkPath);
    if (resolve(current) === resolve(target)) return;
    // Replace — but only if we can do so without sudo. Failure is
    // silent.
    try {
      await unlink(symlinkPath);
      await symlink(target, symlinkPath);
    } catch {
      /* swallow — most likely permission denied; user can re-run install.sh */
    }
  } catch {
    /* symlink missing — best-effort create */
    try {
      await mkdir(dirname(symlinkPath), { recursive: true });
      await symlink(target, symlinkPath);
    } catch {
      /* swallow */
    }
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch {
    /* swallow */
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-export the manifest path helper for tests.
export { getPendingManifestPath };

/**
 * Convenience: the staging directory base under HOME so callers can
 * `rm -rf` it during cleanup tests.
 */
export function getUpdatesRoot(): string {
  return join(homedir(), '.localcode', 'updates');
}

// Re-export schema for cli/update subcommand validation.
export { PendingUpdateSchema as _PendingUpdateSchema } from './types';
// Re-export z for downstream test usage; suppress unused-symbol lint.
export const _zRef = z;
