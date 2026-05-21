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
