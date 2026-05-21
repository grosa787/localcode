/**
 * Smart image-path detector for the composer.
 *
 * Goal: when a user pastes a raw filesystem path that points at an image
 * file, we promote it into an image attachment instead of submitting the
 * path string as plain text. This module is the PURE parser — no file
 * I/O, no React, no side effects — so it can be unit-tested cheaply and
 * reused by both the TUI InputBar and the web Composer.
 *
 * Path shapes recognised (all on a single line):
 *
 *   - Absolute POSIX paths  (`/Users/me/pic.png`)
 *   - Home-relative paths   (`~`, `~/pic.png`)
 *   - Relative paths        (`./pic.png`, `../sib/pic.png`)
 *   - Windows drive paths   (`C:\\photos\\pic.png`, `D:/x/y.png`)
 *   - Quoted paths          (`'/path with spaces.png'`,
 *                            `"C:\\foo bar\\pic.jpeg"`)
 *   - URI-encoded paths     (`/Users/me/My%20Pic.png` →
 *                            `/Users/me/My Pic.png`)
 *
 * Auto-promote rule: we only auto-attach when a line is JUST the path
 * (optionally surrounded by whitespace and one matched pair of quotes).
 * Multiple paths on the same line — each promoted separately when the
 * line is whitespace-separated tokens that ALL look like paths. Paths
 * embedded in longer prose are NOT promoted; the user types prose and a
 * single bare path on its own line counts as "I want to attach this".
 *
 * Caps:
 *   - ≤ 5 paths per line.
 *   - ≤ 10 MB per file (size check happens upstream — this module only
 *     does extension + path-shape detection).
 *   - Supported extensions: .png .jpg .jpeg .webp .gif .heic.
 */

import * as path from 'node:path';

/** Allowed image extensions (lower-case, with leading dot). */
export const SUPPORTED_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.heic',
] as const;

export type SupportedImageExtension = (typeof SUPPORTED_IMAGE_EXTENSIONS)[number];

/** Maximum number of distinct paths we'll auto-promote from a single line. */
export const MAX_PATHS_PER_LINE = 5;

/** Maximum byte size for an image we will accept. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Detected image-path match inside an input line. */
export interface DetectedImagePath {
  /** Start offset within the original line (inclusive). */
  readonly start: number;
  /** End offset within the original line (exclusive). */
  readonly end: number;
  /** Resolved absolute path (or absolute-style path on Windows). */
  readonly absolutePath: string;
  /** MIME type derived from the extension. */
  readonly mimeType: string;
}

/**
 * Cheap pre-check used to short-circuit the more expensive parser. Returns
 * true when the line APPEARS to contain a bare image path (or a small
 * number of them). We only inspect the first ~32 characters and look for
 * one of the known path prefixes followed eventually by a supported
 * image extension somewhere on the line. Designed to be O(n) with a
 * tight constant — InputBar may call this on every keystroke.
 */
export function looksLikeBareImagePath(line: string): boolean {
  if (typeof line !== 'string' || line.length === 0) return false;
  const trimmed = line.trim();
  if (trimmed.length < 4) return false;
  if (trimmed.length > 4096) return false;
  // First non-space char must look like a path-start: `/`, `~`, `.`,
  // `'`, `"`, or a drive letter (`C:`).
  const first = trimmed.charAt(0);
  const isPathStart =
    first === '/' ||
    first === '~' ||
    first === '.' ||
    first === "'" ||
    first === '"' ||
    /[A-Za-z]/.test(first);
  if (!isPathStart) return false;
  const lower = trimmed.toLowerCase();
  // Must end (after stripping a trailing quote) with one of the
  // supported extensions, OR contain `%2E` followed by an extension
  // (URI-encoded dots — rare but real on macOS Finder drops).
  for (const ext of SUPPORTED_IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
    if (lower.endsWith(`${ext}'`) || lower.endsWith(`${ext}"`)) return true;
    if (lower.includes(`${ext} `)) return true; // multi-path line
  }
  return false;
}

/**
 * Detect image-paths in a single line. Returns an array of matches in
 * left-to-right order. Empty array when the line is not a "JUST paths"
 * line (whitespace + N path tokens) or when no token resolves to a
 * supported extension.
 *
 * `cwd` is used to resolve relative paths into absolute paths; pass
 * `process.cwd()` when calling from real code. The detector itself does
 * NOT touch the filesystem — callers are responsible for confirming the
 * file exists and is within size limits.
 */
export function detectImagePathsInLine(
  line: string,
  cwd: string,
): DetectedImagePath[] {
  if (typeof line !== 'string' || line.length === 0) return [];
  // Auto-promote rule: only when the line is whitespace + one-or-more
  // path tokens. Anything with embedded prose stays as plain text.
  const tokens = splitWhitespaceTokens(line);
  if (tokens.length === 0) return [];
  if (tokens.length > MAX_PATHS_PER_LINE) return [];

  const out: DetectedImagePath[] = [];
  for (const tok of tokens) {
    const detected = detectSingleToken(tok.text, tok.start, cwd);
    if (detected === null) return []; // any non-path token → bail
    out.push(detected);
  }
  return out;
}

interface Token {
  readonly text: string;
  readonly start: number;
}

/**
 * Split a line into whitespace-separated tokens, honouring a single
 * matched pair of surrounding quotes per token so that quoted paths with
 * spaces survive as one token. Records each token's start offset within
 * the original line for `DetectedImagePath.start/end`.
 *
 * Bash-style backslash-escape (`\<space>`) is honoured for unquoted
 * tokens — the backslash + following char are slurped into the same
 * token, so `/Users/me/My\ Pic.png` survives as one token. The
 * downstream `detectSingleToken` strips the literal backslash before
 * resolution.
 */
function splitWhitespaceTokens(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    // Skip leading whitespace.
    while (i < line.length && isWhitespace(line.charCodeAt(i))) i += 1;
    if (i >= line.length) break;
    const start = i;
    const first = line.charAt(i);
    if (first === '"' || first === "'") {
      // Quoted token — slurp until matching quote (or end of line).
      const close = line.indexOf(first, i + 1);
      if (close === -1) {
        // Unmatched quote — bail; we don't auto-promote ambiguous lines.
        return [];
      }
      tokens.push({ text: line.slice(start, close + 1), start });
      i = close + 1;
      continue;
    }
    // Unquoted token — slurp until next UNESCAPED whitespace. A `\`
    // followed by anything (including a space) is one literal pair
    // within the token; this matches how a shell drag-drop escapes
    // a filename containing spaces.
    let j = i;
    while (j < line.length) {
      const ch = line.charCodeAt(j);
      if (ch === 92 /* '\\' */ && j + 1 < line.length) {
        j += 2;
        continue;
      }
      if (isWhitespace(ch)) break;
      j += 1;
    }
    tokens.push({ text: line.slice(start, j), start });
    i = j;
  }
  return tokens;
}

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/**
 * Parse a single token. Returns null when the token is not a supported
 * image path. Handles quoting, `~` expansion, URI-encoding, Windows
 * drive letters and POSIX absolute / relative paths.
 */
function detectSingleToken(
  raw: string,
  start: number,
  cwd: string,
): DetectedImagePath | null {
  if (raw.length < 5) return null;
  if (raw.length > 4096) return null;
  let inner = raw;
  // Strip a single matched pair of surrounding quotes.
  if (inner.length >= 2) {
    const f = inner.charAt(0);
    const l = inner.charAt(inner.length - 1);
    if ((f === "'" && l === "'") || (f === '"' && l === '"')) {
      inner = inner.slice(1, -1);
    }
  }
  // Bash-style backslash escapes (`\<space>`, `\'`, `\"`). We MUST
  // skip this transform for Windows drive paths (`C:\foo\bar.png`),
  // where the backslash is a real path separator. Detection:
  // `<letter>:\` at the start of the token means Windows. Everything
  // else gets the shell-style un-escape so a Finder drag-drop with
  // spaces resolves correctly.
  const isWindowsPath = /^[A-Za-z]:[\\]/.test(inner);
  if (!isWindowsPath) {
    inner = inner.replace(/\\([ '"\\])/g, (_match, ch: string) => ch);
  }
  // URI-decode (`%20` → space, etc.). decodeURIComponent throws on
  // malformed sequences — fall back to the original string in that
  // case (the path may still be valid, just not URI-encoded).
  inner = safeDecodeURIComponent(inner);

  if (inner.length === 0) return null;

  const ext = matchSupportedExtension(inner);
  if (ext === null) return null;

  // Path-shape guard. We accept any of:
  //   `/...`         POSIX absolute
  //   `~` or `~/...` home-relative
  //   `./...`        explicit relative
  //   `../...`       explicit parent-relative
  //   `<letter>:\`   Windows drive
  //   `<letter>:/`   Windows drive (forward-slash form)
  const looksLikePath =
    inner.startsWith('/') ||
    inner === '~' ||
    inner.startsWith('~/') ||
    inner.startsWith('~\\') ||
    inner.startsWith('./') ||
    inner.startsWith('.\\') ||
    inner.startsWith('../') ||
    inner.startsWith('..\\') ||
    /^[A-Za-z]:[\\/]/.test(inner);

  if (!looksLikePath) return null;

  // Resolve into an absolute path.
  let absolute = inner;
  if (inner === '~') {
    absolute = getHomeDir();
  } else if (inner.startsWith('~/') || inner.startsWith('~\\')) {
    absolute = path.join(getHomeDir(), inner.slice(2));
  } else if (
    inner.startsWith('./') ||
    inner.startsWith('.\\') ||
    inner.startsWith('../') ||
    inner.startsWith('..\\')
  ) {
    absolute = path.resolve(cwd, inner);
  }
  // POSIX and Windows-drive paths are already absolute — leave them as-is.

  return {
    start,
    end: start + raw.length,
    absolutePath: absolute,
    mimeType: mimeTypeForExtension(ext),
  };
}

function safeDecodeURIComponent(s: string): string {
  // Fast bail when there are no percent-escapes — avoids paying the
  // decode cost on every keystroke when the user is typing a plain path.
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Return the supported image extension at the end of a token, or null.
 * Case-insensitive; checks the lower-cased trailing segment so `.PNG`
 * matches `.png`. We compare against the canonical lower-cased list.
 */
function matchSupportedExtension(token: string): SupportedImageExtension | null {
  const lower = token.toLowerCase();
  for (const ext of SUPPORTED_IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  return null;
}

/** Map an extension to the matching MIME type. */
export function mimeTypeForExtension(ext: SupportedImageExtension): string {
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.heic':
      return 'image/heic';
    case '.jpg':
    case '.jpeg':
    default:
      return 'image/jpeg';
  }
}

/**
 * `os.homedir()` is the production path. Wrapped so tests can inject a
 * deterministic value via the indirection without monkey-patching node.
 * Lazily evaluated so tests that never trigger the `~`-path branch don't
 * pay the cost of `os.homedir()` (which calls into native code).
 */
let homeDirOverride: string | null = null;
function getHomeDir(): string {
  if (homeDirOverride !== null) return homeDirOverride;
  // Avoid `import * as os` at the top because that pulls in node's
  // event-loop on web targets. Use `require` at call time, falling
  // back to env vars if not available.
  // node-built-in: dynamic import not possible synchronously; resolve
  // via process.env which is consistent across darwin/linux/windows.
  const env = typeof process !== 'undefined' ? process.env : undefined;
  if (env) {
    if (typeof env.HOME === 'string' && env.HOME.length > 0) return env.HOME;
    if (typeof env.USERPROFILE === 'string' && env.USERPROFILE.length > 0) {
      return env.USERPROFILE;
    }
  }
  return '';
}

/** Test helper — override `os.homedir()` for deterministic resolution. */
export function __setHomeDirForTests(override: string | null): void {
  homeDirOverride = override;
}
