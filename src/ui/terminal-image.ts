/**
 * Terminal-image renderer with protocol auto-detection.
 *
 * Different terminals support different inline-image protocols. Terminals
 * can't render raw JPEG bytes directly — they have to be transcoded into
 * one of the well-known wire protocols. We detect which protocol the
 * current terminal supports via the environment and produce an ANSI
 * payload that `ink`'s `<Text>` can write verbatim.
 *
 * Detection precedence (most specific → most generic):
 *   1. iTerm2 inline images protocol (OSC 1337) — iTerm2, WezTerm
 *      (advertise via `TERM_PROGRAM=iTerm.app` or
 *      `TERM_PROGRAM=WezTerm`).
 *   2. Kitty graphics protocol — Kitty terminal (advertises via
 *      `TERM=xterm-kitty` / `KITTY_WINDOW_ID`).
 *   3. Sixel — xterm with `--enable-sixel-graphics`, mlterm, mintty,
 *      foot, and several others. Heuristically detected via
 *      `COLORTERM=truecolor` + `TERM` substring match. Without active
 *      probing (which would require writing to /dev/tty and parsing the
 *      response synchronously) we err on the side of "not sixel" — false
 *      positives produce visible garbage in the terminal, false negatives
 *      just fall back to the text placeholder.
 *   4. Fallback — return an ASCII placeholder so the user knows a
 *      screencast frame is available but can't be rendered inline.
 *
 * The encoded payload is opaque ANSI; ink will pass it through to stdout
 * unchanged because `<Text>` doesn't try to parse its children for layout.
 *
 * SECURITY NOTE: we do NOT decode the JPEG. The protocols accept the
 * base64-encoded JPEG directly, so the only thing this module does is
 * wrap the input string in the protocol's framing bytes. A malformed
 * frame just renders as broken pixels in the terminal — never executes
 * code.
 */

/**
 * Protocols this module knows how to emit. `none` is the fallback that
 * produces a text placeholder.
 */
export type TerminalImageProtocol = 'iterm2' | 'kitty' | 'sixel' | 'none';

/**
 * Read-only snapshot of the environment variables this detector cares
 * about. Tests inject a partial record so the detection logic stays a
 * pure function of (env) → protocol.
 */
export interface TerminalEnvSnapshot {
  readonly TERM_PROGRAM?: string;
  readonly TERM?: string;
  readonly COLORTERM?: string;
  readonly LC_TERMINAL?: string;
  readonly KITTY_WINDOW_ID?: string;
  readonly WT_SESSION?: string;
  /**
   * Explicit override — when set to a known protocol id, skips the
   * detection entirely. Useful when the user knows their terminal
   * supports a protocol our heuristics miss, or to force the text
   * fallback for screenshots / log capture.
   */
  readonly LOCALCODE_IMAGE_PROTOCOL?: string;
}

/**
 * Detect which inline-image protocol the host terminal supports. Pure
 * function of `env`; no I/O.
 */
export function detectTerminalImageProtocol(
  env: TerminalEnvSnapshot,
): TerminalImageProtocol {
  // Explicit override beats every heuristic — required so an operator
  // can pin the protocol in CI (where TERM_PROGRAM is unreliable) or
  // disable graphics outright when piping output to a file.
  const override = env.LOCALCODE_IMAGE_PROTOCOL?.toLowerCase().trim();
  if (
    override === 'iterm2' ||
    override === 'kitty' ||
    override === 'sixel' ||
    override === 'none'
  ) {
    return override;
  }

  const program = env.TERM_PROGRAM?.toLowerCase() ?? '';
  const lcTerminal = env.LC_TERMINAL?.toLowerCase() ?? '';
  const term = env.TERM?.toLowerCase() ?? '';

  // iTerm2 explicitly advertises itself. WezTerm advertises BOTH a
  // dedicated `WezTerm` program id AND implements the iTerm2 protocol.
  if (
    program === 'iterm.app' ||
    program === 'iterm2' ||
    program === 'wezterm' ||
    lcTerminal === 'iterm2'
  ) {
    return 'iterm2';
  }

  // Kitty uses its own protocol; it sets KITTY_WINDOW_ID on launch and
  // TERM=xterm-kitty.
  if (
    typeof env.KITTY_WINDOW_ID === 'string' &&
    env.KITTY_WINDOW_ID.length > 0
  ) {
    return 'kitty';
  }
  if (term.includes('kitty')) {
    return 'kitty';
  }

  // Sixel — heuristic detection only. The most reliable signal is
  // `TERM` substring matching one of the known sixel-capable terminals.
  // `xterm-256color` does NOT imply sixel (xterm builds without the
  // `--enable-sixel-graphics` flag are common). The Windows Terminal
  // (advertised via `WT_SESSION`) supports sixel since 1.22.
  if (
    term.includes('mlterm') ||
    term.includes('foot') ||
    term.includes('mintty') ||
    term.includes('sixel')
  ) {
    return 'sixel';
  }
  if (typeof env.WT_SESSION === 'string' && env.WT_SESSION.length > 0) {
    return 'sixel';
  }

  return 'none';
}

/**
 * Input frame — base64 JPEG plus geometry hints. Matches the shape
 * emitted by `BrowserSession`'s `lastFrame` exactly (see
 * `src/browser/types.ts` → `BrowserScreencastFrame`). We re-declare it
 * here as a structural duck-type so this module doesn't pull in a
 * runtime dependency on the browser session types.
 */
export interface TerminalImageFrame {
  /** Base64-encoded JPEG payload (no `data:` prefix). */
  readonly jpegBase64: string;
  /** Width hint in CSS pixels. Optional — only some protocols use it. */
  readonly width?: number;
  /** Height hint in CSS pixels. Optional. */
  readonly height?: number;
}

/**
 * Render an image frame to an ANSI-encoded string suitable for
 * `<Text>{result}</Text>`. Returns a single line of text; callers wrap
 * it in their own `<Box>` for layout.
 *
 * The fallback ("none") returns a short status string so the user knows
 * the screencast bus has data but the terminal can't display it inline.
 */
export function renderTerminalImage(
  frame: TerminalImageFrame,
  protocol: TerminalImageProtocol,
): string {
  if (protocol === 'iterm2') {
    return renderIterm2(frame);
  }
  if (protocol === 'kitty') {
    return renderKitty(frame);
  }
  if (protocol === 'sixel') {
    // Sixel encoding from a base64 JPEG would require a JPEG decoder
    // and a sixel encoder — both are non-trivial. We instead emit a
    // text placeholder for sixel-capable terminals (still better than
    // nothing) and document the limitation. Operators who want true
    // inline sixel can set LOCALCODE_IMAGE_PROTOCOL=none and pipe the
    // frames out-of-band.
    return '[screencast frame available — sixel encoder not bundled]';
  }
  return '[screencast frame available — open the web UI for live view]';
}

/**
 * iTerm2 inline images protocol (OSC 1337).
 *
 * Format: `\x1b]1337;File=inline=1;width=Npx;height=Npx:<base64>\x07`
 *
 * `inline=1` says "render at this cursor position rather than save to
 * disk". `width`/`height` are accepted as `<N>px`, `<N>%`, `<N>ch`, or
 * `auto`. We pass pixels when supplied so the frame doesn't blow up the
 * line height; otherwise `auto` lets iTerm pick a sensible size.
 */
function renderIterm2(frame: TerminalImageFrame): string {
  const params: string[] = ['inline=1'];
  if (typeof frame.width === 'number' && Number.isFinite(frame.width)) {
    params.push(`width=${Math.max(1, Math.floor(frame.width))}px`);
  }
  if (typeof frame.height === 'number' && Number.isFinite(frame.height)) {
    params.push(`height=${Math.max(1, Math.floor(frame.height))}px`);
  }
  // `preserveAspectRatio=1` keeps iTerm from squashing the frame when
  // only one dimension is provided.
  params.push('preserveAspectRatio=1');
  // BEL (0x07) is the standard string-terminator iTerm honours for
  // OSC 1337. ESC \ (0x1b 0x5c) is also accepted but BEL roundtrips
  // through tmux better.
  return `\x1b]1337;File=${params.join(';')}:${frame.jpegBase64}\x07`;
}

/**
 * Kitty graphics protocol — APC payload framing.
 *
 * Format: `\x1b_Gf=100,a=T,t=d,...;<base64>\x1b\\`
 *
 * Parameters used:
 *   - `f=100` — format is JPEG (PNG is `f=32`, RGB raw is `f=24`).
 *   - `a=T`   — action: transmit AND display the image.
 *   - `t=d`   — payload is direct (base64), not a file path.
 *   - `r=N`/`c=N` — height/width in cells (optional).
 *
 * Large payloads should chunk via `m=1` continuations, but practical
 * screencast frames at q=70 land well under the 4096-byte limit before
 * chunking is required at the protocol layer (Kitty raises a warning
 * but renders fine). For correctness we still emit one chunk; callers
 * that drive very large frames should pre-resize.
 */
function renderKitty(frame: TerminalImageFrame): string {
  const params: string[] = ['f=100', 'a=T', 't=d'];
  // Kitty `r` and `c` parameters are cells, not pixels. Without an
  // accurate cell-pixel ratio we leave them off — Kitty auto-sizes by
  // decoding the JPEG header.
  return `\x1b_G${params.join(',')};${frame.jpegBase64}\x1b\\`;
}

/**
 * Convenience wrapper — detect, then render. Returns both the protocol
 * (so the caller can label the UI accordingly) and the encoded payload.
 */
export function detectAndRenderFrame(
  frame: TerminalImageFrame,
  env: TerminalEnvSnapshot,
): { readonly protocol: TerminalImageProtocol; readonly payload: string } {
  const protocol = detectTerminalImageProtocol(env);
  return { protocol, payload: renderTerminalImage(frame, protocol) };
}

// INLINE-IMAGE-SECTION (start) — Wave 16C: inline rendering of
// agent-produced images (fetch_image output) in the TUI transcript.
//
// The original `renderTerminalImage` above was written for the browser
// screencast bus (always JPEG). Inline rendering of `fetch_image`
// results has to handle PNG / GIF / WebP too, AND it has a hard
// correctness constraint the screencast path did not: the Kitty
// graphics protocol's `f=100` parameter means **PNG**, not JPEG — Kitty
// does not natively decode JPEG/GIF/WebP, only PNG (and raw RGB/RGBA).
// Feeding a JPEG to Kitty with `f=100` renders garbage. So the inline
// path is mime-aware and degrades to the text fallback for protocols
// that can't display the given format.

/**
 * An image to render inline. Distinct from `TerminalImageFrame` (which
 * is JPEG-only and geometry-hinted for the screencast bus) — this
 * carries the source MIME type so the renderer can decide whether the
 * detected protocol can actually display it.
 */
export interface InlineImage {
  /** Base64 payload, no `data:` prefix. */
  readonly base64: string;
  /** Source MIME type, e.g. `image/png`. Drives protocol applicability. */
  readonly mimeType: string;
  /** Decoded byte length (for the text fallback label). */
  readonly byteLength?: number;
}

/**
 * Result of an inline-image render attempt. `kind: 'escape'` carries the
 * raw terminal escape sequence (write verbatim into a `<Text>`).
 * `kind: 'fallback'` means the detected protocol can't display this
 * image — the caller renders a clean text line instead.
 */
export type InlineImageRender =
  | { readonly kind: 'escape'; readonly protocol: TerminalImageProtocol; readonly payload: string }
  | { readonly kind: 'fallback'; readonly protocol: TerminalImageProtocol };

/** Normalise a MIME type to a short label (`image/png` → `png`). */
function mimeSubtype(mimeType: string): string {
  const slash = mimeType.indexOf('/');
  const sub = slash >= 0 ? mimeType.slice(slash + 1) : mimeType;
  return sub.trim().toLowerCase();
}

/**
 * Kitty's graphics protocol only natively decodes PNG (`f=100`) among
 * compressed formats. JPEG/GIF/WebP would need a client-side decode +
 * raw RGB(A) transmit that we don't bundle. So Kitty can ONLY display
 * PNG here; everything else falls back to text on Kitty.
 */
function kittyCanRender(mimeType: string): boolean {
  return mimeSubtype(mimeType) === 'png';
}

/**
 * iTerm2's OSC 1337 inline-image protocol accepts the raw encoded bytes
 * of any common format (it decodes internally), so PNG/JPEG/GIF/WebP all
 * work.
 */
function iterm2CanRender(_mimeType: string): boolean {
  return true;
}

/**
 * Render an `InlineImage` for the given protocol. Returns a structured
 * result so the caller can distinguish "here is an escape sequence" from
 * "this protocol can't show this image — draw the text fallback".
 *
 * Pure: no env reads, no I/O. The escape-sequence string is what the
 * caller caches (see the renderer's FNV-1a cache) and emits exactly
 * once per committed `<Static>` row.
 */
export function renderInlineImage(
  image: InlineImage,
  protocol: TerminalImageProtocol,
): InlineImageRender {
  if (image.base64.length === 0) {
    return { kind: 'fallback', protocol };
  }
  if (protocol === 'iterm2' && iterm2CanRender(image.mimeType)) {
    return {
      kind: 'escape',
      protocol,
      payload: renderIterm2({ jpegBase64: image.base64 }),
    };
  }
  if (protocol === 'kitty' && kittyCanRender(image.mimeType)) {
    return {
      kind: 'escape',
      protocol,
      payload: renderKittyPng(image.base64),
    };
  }
  // sixel (no encoder bundled) and none, plus any protocol that can't
  // display this MIME, fall back to a clean text line drawn by the
  // caller.
  return { kind: 'fallback', protocol };
}

/**
 * Kitty graphics protocol for a PNG payload.
 *
 * Format: `\x1b_Gf=100,a=T,t=d;<base64>\x1b\\`
 *   - `f=100` — PNG (the ONLY compressed format Kitty decodes; `f=24`
 *     is raw RGB, `f=32` is raw RGBA).
 *   - `a=T`   — transmit AND display.
 *   - `t=d`   — direct payload (base64), not a file path.
 *
 * Payloads over 4096 bytes are chunked with `m=1` continuation frames;
 * `fetch_image` results routinely exceed that, so we chunk here. The
 * first chunk carries the control keys; continuation chunks carry only
 * `m=1` (more) / `m=0` (last). Without chunking Kitty silently drops
 * oversized single frames on some builds.
 */
function renderKittyPng(base64: string): string {
  const CHUNK = 4096;
  if (base64.length <= CHUNK) {
    return `\x1b_Gf=100,a=T,t=d;${base64}\x1b\\`;
  }
  const parts: string[] = [];
  let offset = 0;
  let first = true;
  while (offset < base64.length) {
    const slice = base64.slice(offset, offset + CHUNK);
    offset += CHUNK;
    const more = offset < base64.length ? 1 : 0;
    if (first) {
      parts.push(`\x1b_Gf=100,a=T,t=d,m=${more};${slice}\x1b\\`);
      first = false;
    } else {
      parts.push(`\x1b_Gm=${more};${slice}\x1b\\`);
    }
  }
  return parts.join('');
}

/**
 * Build a clean one-line text fallback for an image that can't be drawn
 * inline. Shape: `[image: <subtype> <N> bytes]`. Never emits escape
 * bytes — safe on any terminal / when piped to a file.
 */
export function inlineImageFallbackLabel(image: InlineImage): string {
  const sub = mimeSubtype(image.mimeType) || 'image';
  if (typeof image.byteLength === 'number' && Number.isFinite(image.byteLength) && image.byteLength > 0) {
    return `[image: ${sub} ${image.byteLength} bytes]`;
  }
  return `[image: ${sub}]`;
}

/**
 * Whether inline image rendering is enabled. Default ON. Opt out via
 * `LOCALCODE_NO_INLINE_IMAGES` (any non-empty value) or by forcing
 * `LOCALCODE_IMAGE_PROTOCOL=none`.
 */
export function inlineImagesEnabled(env: TerminalEnvSnapshot & { readonly LOCALCODE_NO_INLINE_IMAGES?: string }): boolean {
  const optOut = env.LOCALCODE_NO_INLINE_IMAGES;
  if (typeof optOut === 'string' && optOut.trim().length > 0) return false;
  return true;
}
// INLINE-IMAGE-SECTION (end)
