/**
 * Validate that an updater artifact is a runnable localcode JS bundle —
 * the thing `bun cli.js` executes — and NOT a gzip tarball, native
 * binary, zip, or any other archive.
 *
 * This is the load-bearing safety net for the auto-updater. The update
 * target is ALWAYS a `cli.js` launched via `bun` (see the re-spawn in
 * `src/cli.tsx`, which runs `process.execPath cli.js`). Release assets,
 * however, are platform `localcode-<os>-<arch>.tar.gz` archives wrapping
 * a native standalone binary. If such an archive (or the native binary
 * inside it) is ever written over `cli.js`, the next launch makes `bun`
 * parse gzip/Mach-O as JavaScript and the install hard-crashes with
 * "Unexpected …" at `cli.js:1:1` — exactly the corruption this guards.
 *
 * Both the downloader (before a download is allowed to stage) and the
 * applier (before a staged file is promoted onto the live binary) gate
 * on this, so a mismatched artifact can never reach the live `cli.js`.
 */

import { open } from 'node:fs/promises';

export interface BundleCheck {
  readonly ok: boolean;
  /** Human-readable reason when `ok === false`. */
  readonly reason?: string;
}

/**
 * Inspect the first bytes of a candidate artifact. Returns `ok: false`
 * with a specific reason for known archive / native-binary signatures
 * or non-text content; `ok: true` for something that looks like a
 * runnable JS bundle.
 *
 * The localcode bundle starts with `#!/usr/bin/env bun\n// @bun\n…`, so
 * the fast path accepts a shebang or the `// @bun` marker outright. The
 * fallback requires the head to be printable text (a JS bundle is
 * text), which alone rejects gzip (`1f 8b`), ELF (`7f 45 4c 46`), and
 * Mach-O (`fe ed fa …` / `cf fa ed fe` / `ca fe ba be`) — all of which
 * carry non-printable bytes up front. Zip (`50 4b` = "PK", both
 * printable) is rejected explicitly.
 */
export function isRunnableBundleHead(head: Uint8Array): BundleCheck {
  if (head.length === 0) return { ok: false, reason: 'empty file' };

  // Explicit archive magics (clearer messages than the generic text check).
  if (head[0] === 0x1f && head[1] === 0x8b) {
    return { ok: false, reason: 'gzip archive (.tar.gz/.tgz) — not a JS bundle' };
  }
  if (head[0] === 0x50 && head[1] === 0x4b) {
    return { ok: false, reason: 'zip archive — not a JS bundle' };
  }
  if (
    head.length >= 4 &&
    head[0] === 0x7f &&
    head[1] === 0x45 &&
    head[2] === 0x4c &&
    head[3] === 0x46
  ) {
    return { ok: false, reason: 'ELF binary — not a JS bundle' };
  }

  // Fast path: the known-good localcode bundle shape.
  const ascii = (n: number): string =>
    String.fromCharCode(...head.subarray(0, Math.min(n, head.length)));
  const prefix = ascii(16);
  if (prefix.startsWith('#!') || prefix.startsWith('// @bun')) {
    return { ok: true };
  }

  // Fallback: a JS bundle is printable text. Any non-printable byte in
  // the head means a binary artifact (native exe, Mach-O, etc.).
  for (const b of head) {
    const printable =
      b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e);
    if (!printable) {
      return { ok: false, reason: 'binary content — not a runnable JS bundle' };
    }
  }
  return { ok: true };
}

/**
 * Read the first 64 bytes of `path` and validate it via
 * {@link isRunnableBundleHead}. Returns `ok: false` (never throws) when
 * the file can't be opened.
 */
export async function isRunnableBundleFile(path: string): Promise<BundleCheck> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cannot open artifact: ${msg}` };
  }
  try {
    const buf = new Uint8Array(64);
    const { bytesRead } = await fh.read(buf, 0, 64, 0);
    return isRunnableBundleHead(buf.subarray(0, bytesRead));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cannot read artifact: ${msg}` };
  } finally {
    await fh.close().catch(() => {
      /* swallow */
    });
  }
}
