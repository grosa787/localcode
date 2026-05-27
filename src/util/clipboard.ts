/**
 * Cross-platform clipboard image reader.
 *
 * Why: when a user copies an image (Cmd+C in macOS Preview, Ctrl+C in a
 * screenshot tool on Linux/Windows, etc.) the bytes live on the system
 * clipboard. Terminals do NOT propagate image clipboard contents to a
 * TUI on paste — they only propagate text. To attach a screenshot to a
 * chat turn the TUI must reach out to the OS clipboard directly.
 *
 * This module provides a single async helper, {@link readClipboardImage},
 * that returns `{ bytes, mime }` when the clipboard currently holds an
 * image, and `null` for every "no image / tool missing / unsupported
 * platform / error" case. Production callers should treat any non-null
 * result as a one-shot read (the bytes belong to the caller) and any
 * null result as "fall through to your default paste behaviour".
 *
 * Platform implementations:
 *   - darwin: spawn `osascript` to write the clipboard PNG to a tmp
 *     file via AppleScript's `«class PNGf»` coercion, then read the
 *     file. `osascript` ships with every macOS install — no extra deps.
 *   - linux: spawn `xclip -selection clipboard -t image/png -o`. xclip
 *     is the de-facto standard on X11. Falls back gracefully when xclip
 *     isn't installed (returns null). Wayland users will need to install
 *     xclip via xwayland or use a wl-clipboard wrapper — not detected
 *     here on purpose, to keep the dependency surface minimal.
 *   - win32: spawn `powershell` to use the System.Windows.Forms
 *     Clipboard API. Saves to %TEMP%\localcode-clipboard.png then we
 *     read the file. powershell is always available on modern Windows.
 *
 * MIME detection: we use {@link sniffImageMimeFromBytes} on the captured
 * bytes rather than trusting the platform's reported type — many tools
 * lie (e.g. a screenshot saved as JPEG but exposed as PNG via the OS
 * clipboard API). We only return `image/png` or `image/jpeg` because
 * those are the formats every vision model accepts and that every
 * platform's "save clipboard image" API can produce reliably.
 *
 * Safety rails:
 *   - 10 MB cap (matches MAX_IMAGE_BYTES elsewhere in the codebase).
 *   - Empty buffer → null.
 *   - Sniff fails (no recognised magic number) → null.
 *   - All spawn failures swallowed → null (caller falls through).
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sniffImageMime } from '@/util/mime-sniff';

/** 10 MB cap, matching MAX_IMAGE_BYTES in InputBar / fetch_image. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Subset of MIME types we are willing to surface to the caller. */
export type ClipboardImageMime = 'image/png' | 'image/jpeg';

export interface ClipboardImage {
  readonly bytes: Uint8Array;
  readonly mime: ClipboardImageMime;
}

/**
 * Hook so tests can stub the subprocess + filesystem layer without
 * monkey-patching `child_process` / `fs`. Production callers pass no
 * args and receive the real implementations.
 */
export interface ClipboardDeps {
  /** Run a one-shot subprocess synchronously. */
  spawn?: typeof spawnSync;
  /** Read a file synchronously. */
  readFile?: (p: string) => Buffer;
  /** Remove a file synchronously, swallowing errors. */
  unlink?: (p: string) => void;
  /** Override the platform identifier (tests). */
  platform?: NodeJS.Platform;
  /** Override the OS temp dir (tests). */
  tmpDir?: string;
}

const DEFAULT_DEPS: Required<ClipboardDeps> = {
  spawn: spawnSync,
  readFile: (p) => fs.readFileSync(p),
  unlink: (p) => {
    try {
      fs.unlinkSync(p);
    } catch {
      /* best-effort cleanup */
    }
  },
  platform: process.platform,
  tmpDir: os.tmpdir(),
};

/**
 * Convert a sniffed MIME (from `sniffImageMime`) into the narrower
 * union we surface to callers. PNG/JPEG pass through; anything else is
 * rejected as null. GIF / WEBP / HEIC are intentionally NOT supported
 * here even though the sniffer recognises them — the platform clipboard
 * APIs we drive only round-trip PNG/JPEG reliably.
 */
function narrowMime(sniffed: ReturnType<typeof sniffImageMime>): ClipboardImageMime | null {
  if (sniffed === 'image/png') return 'image/png';
  if (sniffed === 'image/jpeg') return 'image/jpeg';
  return null;
}

/**
 * Build the {@link ClipboardImage} from a raw byte buffer. Validates
 * size + sniffs MIME. Returns null when the bytes don't look like a
 * supported image.
 */
function buildResultFromBytes(buf: Buffer): ClipboardImage | null {
  if (buf.length === 0) return null;
  if (buf.length > MAX_IMAGE_BYTES) return null;
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const sniffed = sniffImageMime(u8);
  const mime = narrowMime(sniffed);
  if (mime === null) return null;
  return { bytes: u8, mime };
}

/**
 * darwin: read the clipboard via AppleScript's PNGf coercion, written
 * to a temp file. Returns null on any failure (no image on clipboard,
 * osascript missing, AppleScript error, etc).
 *
 * The AppleScript:
 *   - tries to coerce the clipboard to PNG bytes (`«class PNGf»`),
 *   - opens the output file for write,
 *   - writes the bytes,
 *   - prints the POSIX path on success / empty string on failure.
 *
 * macOS does not expose JPEG-as-clipboard easily without third-party
 * tools, so we always request PNG. The byte sniffer still validates the
 * payload, so a malformed result still returns null.
 */
function readDarwin(d: Required<ClipboardDeps>): ClipboardImage | null {
  const outPath = path.join(d.tmpDir, `localcode-clipboard-${randomId()}.png`);
  // Use a here-doc to keep the AppleScript readable and let osascript
  // parse it as a single program. Escape only the output path (we
  // control it, but defence in depth).
  const script = `try
  set theData to the clipboard as «class PNGf»
  set fileRef to open for access POSIX file ${quoteAppleScriptString(outPath)} with write permission
  set eof of fileRef to 0
  write theData to fileRef
  close access fileRef
  return "ok"
on error errMsg
  try
    close access POSIX file ${quoteAppleScriptString(outPath)}
  end try
  return "err:" & errMsg
end try`;
  const result = safeSpawn(d.spawn, 'osascript', ['-e', script]);
  if (result === null) return null;
  if (result.status !== 0) {
    d.unlink(outPath);
    return null;
  }
  const stdout = result.stdout.toString('utf8').trim();
  if (!stdout.startsWith('ok')) {
    d.unlink(outPath);
    return null;
  }
  let buf: Buffer;
  try {
    buf = d.readFile(outPath);
  } catch {
    d.unlink(outPath);
    return null;
  }
  d.unlink(outPath);
  return buildResultFromBytes(buf);
}

/**
 * linux: read via xclip. We try PNG first; if xclip is missing or the
 * clipboard doesn't hold an image, we return null. xclip writes the raw
 * binary payload to stdout — no temp file required.
 */
function readLinux(d: Required<ClipboardDeps>): ClipboardImage | null {
  const result = safeSpawn(d.spawn, 'xclip', [
    '-selection',
    'clipboard',
    '-t',
    'image/png',
    '-o',
  ]);
  if (result === null) return null;
  if (result.status !== 0) return null;
  return buildResultFromBytes(result.stdout);
}

/**
 * win32: powershell + System.Windows.Forms.Clipboard. Saves the image
 * to %TEMP%\localcode-clipboard-<id>.png then we read + delete the
 * file. Returns null when the clipboard has no image or the subprocess
 * fails for any reason.
 */
function readWin32(d: Required<ClipboardDeps>): ClipboardImage | null {
  const outPath = path.join(d.tmpDir, `localcode-clipboard-${randomId()}.png`);
  // Single-line script; escape backslashes in the path so PowerShell
  // sees them literally. We use single-quoted strings inside the
  // script so the only escapes that matter are doubled single quotes
  // — outPath comes from `os.tmpdir()` which won't contain those.
  const escaped = outPath.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    "if ($img -eq $null) { exit 1 }",
    `$img.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    'exit 0',
  ].join('; ');
  const result = safeSpawn(d.spawn, 'powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ]);
  if (result === null) return null;
  if (result.status !== 0) {
    d.unlink(outPath);
    return null;
  }
  let buf: Buffer;
  try {
    buf = d.readFile(outPath);
  } catch {
    d.unlink(outPath);
    return null;
  }
  d.unlink(outPath);
  return buildResultFromBytes(buf);
}

/**
 * Wrap `spawn` so an ENOENT (binary missing on PATH) or any thrown
 * error becomes a null return. Production callers don't care WHY the
 * subprocess failed — only whether to fall through.
 */
function safeSpawn(
  spawn: typeof spawnSync,
  cmd: string,
  args: readonly string[],
): SpawnSyncReturns<Buffer> | null {
  let result: SpawnSyncReturns<Buffer>;
  try {
    result = spawn(cmd, args as string[]);
  } catch {
    return null;
  }
  // spawnSync returns the error in `.error` rather than throwing for
  // most failure modes (ENOENT included). Treat any non-null .error
  // as "subprocess unusable".
  if (result.error !== undefined && result.error !== null) return null;
  return result;
}

/**
 * Escape a string for inclusion in an AppleScript string literal.
 * AppleScript uses double-quoted strings with `\\` and `\"` escapes.
 */
function quoteAppleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Generate a short URL-safe id for filenames. We avoid `crypto.randomUUID`
 * dashes to keep the resulting path tidy in error messages.
 */
function randomId(): string {
  // 12 hex chars is plenty for tmp-file disambiguation; collision odds
  // across a single CLI session are vanishingly small.
  const bytes = new Uint8Array(6);
  // crypto.getRandomValues is available on every supported runtime
  // (Node 18+, Bun 1+). Fall back to a Math.random hash if missing.
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] ?? 0;
    out += v.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Read the system clipboard. Returns the image bytes + sniffed MIME
 * when the clipboard holds a supported image; returns null for every
 * other case (empty / not an image / tool missing / unsupported
 * platform / spawn error / decode error).
 *
 * The function is async to leave room for a future Wayland / wl-paste
 * implementation that genuinely needs to await — every current branch
 * is synchronous under the hood (`spawnSync` + `readFileSync`) because
 * keystroke handlers cannot tolerate microtask jitter.
 */
export async function readClipboardImage(
  deps?: ClipboardDeps,
): Promise<ClipboardImage | null> {
  const d: Required<ClipboardDeps> = {
    spawn: deps?.spawn ?? DEFAULT_DEPS.spawn,
    readFile: deps?.readFile ?? DEFAULT_DEPS.readFile,
    unlink: deps?.unlink ?? DEFAULT_DEPS.unlink,
    platform: deps?.platform ?? DEFAULT_DEPS.platform,
    tmpDir: deps?.tmpDir ?? DEFAULT_DEPS.tmpDir,
  };
  switch (d.platform) {
    case 'darwin':
      return readDarwin(d);
    case 'linux':
      return readLinux(d);
    case 'win32':
      return readWin32(d);
    default:
      return null;
  }
}
