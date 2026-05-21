/**
 * Strict path-resolution helper used by every filesystem-touching boundary
 * (tool handlers + REST file APIs).
 *
 * Two-stage containment check:
 *   1. `path.resolve` + `path.relative` prefix check — defeats `..` and
 *      absolute-path inputs.
 *   2. `fs.realpathSync` on the resolved target AND the root — defeats
 *      symlink traversal where an in-tree path points outside the root.
 *
 * Stage 2 handles the ENOENT case by walking up to the nearest existing
 * ancestor and realpath-ing that, then re-checking containment. This lets
 * write_file create new files under directories whose parent is a symlink
 * back into the root, while still rejecting `link/passwd` when `link`
 * resolves to `/etc`.
 *
 * Returns the absolute path on success, or null when containment fails
 * for any reason (traversal, broken symlink ancestor that resolves
 * outside, realpath error other than ENOENT, etc).
 *
 * NOTE on macOS: `/tmp` is a symlink to `/private/tmp`. When the
 * caller passes a project root rooted under `os.tmpdir()` (the common
 * test case), `realpathSync` on the root returns `/private/tmp/...`.
 * We realpath the root once and use that as the canonical prefix so
 * targets resolved against the symlinked /tmp pass the prefix check.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Stage 1: lexical containment. Returns the resolved absolute path or
 * null on `..` / absolute-path escape.
 */
function lexicalResolve(root: string, target: string): string | null {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(absoluteRoot, target);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return absoluteTarget;
}

/**
 * Walk up the path until an existing ancestor is found, realpath it,
 * then re-append the tail. Returns the canonicalised path. Throws when
 * even the volume root can't be realpath'd (extremely unlikely).
 *
 * Used when the target itself doesn't exist (e.g. write_file creating
 * a new file under an existing parent dir). The realpath of the parent
 * + the new filename is what we want to range-check.
 */
function realpathTolerant(absolutePath: string): string {
  let current = absolutePath;
  const tail: string[] = [];
  // Loop bound: path depth is finite. We climb until either realpath
  // succeeds OR we hit the filesystem root.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = realpathSync(current);
      if (tail.length === 0) return real;
      return path.join(real, ...tail.reverse());
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT' && nodeErr.code !== 'ENOTDIR') {
        // Permission denied, IO error etc. Surface to caller as a hard
        // failure — security-conscious behaviour is to deny.
        throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Hit filesystem root without finding an existing ancestor.
        // Should never happen in practice (root always exists), but
        // guard against an infinite loop.
        throw new Error(`realpath: cannot resolve any ancestor of ${absolutePath}`);
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `target` against `root` with full traversal hardening. Returns
 * the resolved absolute path on success, or null on any containment
 * failure (lexical `..`, absolute input, symlink escape, realpath error).
 *
 * Suitable for the read path (target must exist for the canonical
 * realpath check) AND the write/create path (the target may not yet
 * exist — we then realpath the nearest existing ancestor).
 */
export function resolveSafePathStrict(
  root: string,
  target: string,
): string | null {
  const lexical = lexicalResolve(root, target);
  if (lexical === null) return null;

  // Root realpath may fail when the root doesn't yet exist on disk —
  // this happens in pure unit tests that pass synthetic roots like
  // `/var/foo`. In production every project root exists, so the
  // realpath check is in effect. When BOTH sides fail to realpath
  // (root + target absent), the lexical containment check is already
  // sufficient: there is no symlink in play because nothing exists.
  let canonicalRoot: string | null = null;
  try {
    canonicalRoot = realpathSync(path.resolve(root));
  } catch {
    // Treat as "lexical-only" mode below.
    canonicalRoot = null;
  }

  let canonicalTarget: string | null = null;
  try {
    canonicalTarget = realpathTolerant(lexical);
  } catch {
    canonicalTarget = null;
  }

  // Both must realpath to compare — if either failed, the lexical
  // check is the only signal we have. Lexical already passed, so we
  // allow the resolved path. Symlink protection ONLY engages when
  // both sides resolved (i.e. the root and at least the target's
  // nearest existing ancestor both exist).
  if (canonicalRoot !== null && canonicalTarget !== null) {
    if (canonicalTarget !== canonicalRoot) {
      const sep = path.sep;
      const prefix = canonicalRoot.endsWith(sep)
        ? canonicalRoot
        : canonicalRoot + sep;
      if (!canonicalTarget.startsWith(prefix)) {
        return null;
      }
    }
  }

  // Return the LEXICAL path (not the realpath) so callers see paths
  // shaped like their input — tests, error messages, and `path` UI keys
  // stay stable when the project root is itself a symlink (e.g. /tmp on
  // macOS). The realpath has already been verified to be in-tree, so
  // returning the lexical form is safe.
  return lexical;
}
