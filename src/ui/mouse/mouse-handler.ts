/**
 * Mouse-handling primitives for the TUI.
 *
 * Terminals report mouse events as escape sequences on stdin. We parse
 * two encodings:
 *
 *   - **SGR**  (xterm 1006): `\x1b[<<button>;<col>;<row>(M|m)`
 *     The trailing `M` is press, `m` is release. SGR coordinates are
 *     1-indexed and the button code carries shift/alt/ctrl modifiers
 *     plus a "motion" flag (bit 5) and wheel-scroll flags (64 = up,
 *     65 = down).
 *
 *   - **X10/legacy** (xterm 1000): `\x1b[M<button><col><row>`
 *     One byte each, offset by 32. Limited to ≤223 columns/rows.
 *     We parse but most modern terminals (iTerm2, Alacritty, Kitty,
 *     Ghostty, WezTerm, modern xterm, modern gnome-terminal) prefer
 *     SGR when offered.
 *
 * Activation: callers must opt in. The TUI checks `config.editor.mouseSupport`
 * AND the terminal capability before turning the modes on. Turning the
 * modes on without parsing the bytes back is a recipe for visible
 * garbage in the user's terminal, so the activator and parser ship
 * together.
 *
 * Terminal compatibility (verified empirically):
 *   - iTerm2 (macOS)         — SGR ✓, X10 ✓
 *   - Alacritty              — SGR ✓
 *   - Kitty                  — SGR ✓
 *   - Ghostty                — SGR ✓
 *   - WezTerm                — SGR ✓
 *   - xterm (modern)         — SGR ✓ (set `set-allow-mouse-ops` in XResources)
 *   - gnome-terminal         — SGR ✓
 *   - Terminal.app (macOS)   — X10 only on older OS releases; partial SGR on Sonoma+
 *   - Windows Terminal       — SGR ✓
 *   - tmux/screen wrappers   — pass-through when configured; otherwise opaque
 *
 * Graceful degradation: the activator advertises the modes but never
 * blocks startup if the terminal silently ignores them. If no mouse
 * bytes ever arrive, no event ever fires — the rest of the TUI
 * continues unchanged.
 */

/** Mouse button identifiers we expose to the UI. */
export type MouseButton =
  | 'left'
  | 'middle'
  | 'right'
  | 'wheel-up'
  | 'wheel-down'
  | 'unknown';

/** Whether the event is press, release, or motion (drag/move). */
export type MouseEventKind = 'press' | 'release' | 'motion';

/**
 * Parsed mouse event. Coordinates are 1-indexed (top-left = `(1, 1)`),
 * matching the on-the-wire convention.
 */
export interface MouseEvent {
  readonly kind: MouseEventKind;
  readonly button: MouseButton;
  readonly col: number;
  readonly row: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

/**
 * Decode the SGR button code byte. Bit layout (xterm 1006):
 *
 *   bits 0-1 : 0=left, 1=middle, 2=right, 3=release (X10 only)
 *   bit  2   : shift
 *   bit  3   : meta/alt
 *   bit  4   : ctrl
 *   bit  5   : motion (move while button held)
 *   bit  6   : wheel scroll (button 0 = up, 1 = down)
 *
 * In SGR encoding the press/release distinction comes from the `M`/`m`
 * suffix (not bit 3), so we mask it out before checking button id.
 */
function decodeButton(
  code: number,
  release: boolean,
): { button: MouseButton; kind: MouseEventKind; shift: boolean; alt: boolean; ctrl: boolean } {
  const shift = (code & 4) !== 0;
  const alt = (code & 8) !== 0;
  const ctrl = (code & 16) !== 0;
  const motion = (code & 32) !== 0;
  const wheel = (code & 64) !== 0;
  const base = code & 3;
  let button: MouseButton = 'unknown';
  if (wheel) {
    button = base === 0 ? 'wheel-up' : base === 1 ? 'wheel-down' : 'unknown';
  } else if (base === 0) button = 'left';
  else if (base === 1) button = 'middle';
  else if (base === 2) button = 'right';
  let kind: MouseEventKind;
  if (release) kind = 'release';
  else if (motion) kind = 'motion';
  else kind = 'press';
  return { button, kind, shift, alt, ctrl };
}

/**
 * Try to parse one mouse event from the start of `input`. Returns the
 * decoded event AND the number of bytes consumed, or `null` if the
 * prefix doesn't match any supported encoding.
 *
 * Designed for incremental parsing: callers can feed bytes as they
 * arrive and re-call until they get `null` (no more complete events)
 * or `bytes === 0` (waiting for more data).
 */
export function parseMouseEvent(
  input: string,
): { event: MouseEvent; bytes: number } | null {
  // SGR: `\x1b[<<button>;<col>;<row>(M|m)`
  if (input.startsWith('\x1b[<')) {
    // Find the terminating M or m. We scan forward up to a small
    // hard cap; mouse sequences are tiny.
    const end = findSgrTerminator(input, 3, 32);
    if (end === -1) return null;
    const suffix = input.charAt(end);
    const release = suffix === 'm';
    const body = input.slice(3, end);
    const parts = body.split(';');
    if (parts.length !== 3) return null;
    const code = Number(parts[0]);
    const col = Number(parts[1]);
    const row = Number(parts[2]);
    if (!Number.isFinite(code) || !Number.isFinite(col) || !Number.isFinite(row)) {
      return null;
    }
    const decoded = decodeButton(code, release);
    return {
      event: {
        kind: decoded.kind,
        button: decoded.button,
        col,
        row,
        shift: decoded.shift,
        alt: decoded.alt,
        ctrl: decoded.ctrl,
      },
      bytes: end + 1,
    };
  }
  // X10/legacy: `\x1b[M<cb><cx><cy>` — fixed 6 bytes after ESC.
  if (input.startsWith('\x1b[M') && input.length >= 6) {
    const code = input.charCodeAt(3) - 32;
    const col = input.charCodeAt(4) - 32;
    const row = input.charCodeAt(5) - 32;
    if (code < 0 || col < 0 || row < 0) return null;
    // X10 reports release via button bits == 3 (no per-button distinction).
    const release = (code & 3) === 3;
    const decoded = decodeButton(release ? code & ~3 : code, release);
    return {
      event: {
        kind: decoded.kind,
        button: decoded.button,
        col,
        row,
        shift: decoded.shift,
        alt: decoded.alt,
        ctrl: decoded.ctrl,
      },
      bytes: 6,
    };
  }
  return null;
}

/** Bounded scan for `M` or `m` after the SGR prefix. */
function findSgrTerminator(input: string, from: number, maxScan: number): number {
  const end = Math.min(input.length, from + maxScan);
  for (let i = from; i < end; i++) {
    const ch = input.charAt(i);
    if (ch === 'M' || ch === 'm') return i;
  }
  return -1;
}

/**
 * Stateful parser that buffers partial sequences across reads. Use this
 * when feeding raw stdin chunks (which may split a mouse sequence
 * across two reads). Events are delivered via `onEvent` callback.
 *
 * Returns the number of events emitted from this call — useful for
 * tests + for the host to short-circuit when no events arrived.
 */
export class MouseSequenceParser {
  private buffer: string = '';

  constructor(private readonly onEvent: (event: MouseEvent) => void) {}

  /**
   * Feed a chunk of bytes from stdin. Returns the number of mouse
   * events emitted. Non-mouse bytes are returned via `getResidual()`
   * so the host's regular key handler can still process them.
   */
  feed(chunk: string): number {
    this.buffer += chunk;
    let emitted = 0;
    while (this.buffer.length > 0) {
      const idx = this.buffer.indexOf('\x1b[');
      if (idx === -1) {
        // No mouse-style prefix anywhere; nothing to emit. Leave the
        // buffer alone so getResidual() returns it intact.
        break;
      }
      // Bytes before the prefix are not mouse — leave them in residual
      // and continue scanning from the prefix.
      // We strip leading non-mouse bytes off the buffer so we don't
      // re-scan them on the next feed call.
      if (idx > 0) {
        // Move residual bytes to a separate spillover string so the
        // host can drain them.
        this.residual += this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx);
      }
      // Try to parse from the start.
      const parsed = parseMouseEvent(this.buffer);
      if (parsed === null) {
        // Either the prefix doesn't match a mouse sequence (e.g. it's
        // a key like arrow-up `\x1b[A`) or we don't have enough bytes
        // yet. Heuristic: if the buffer is short and starts with
        // `\x1b[<` keep it (waiting for more bytes). Otherwise drop
        // the `\x1b[` so we don't loop forever on a non-mouse seq.
        if (this.buffer.startsWith('\x1b[<') && this.buffer.length < 24) {
          // Wait for more bytes — partial SGR sequence.
          break;
        }
        if (this.buffer.startsWith('\x1b[M') && this.buffer.length < 6) {
          break;
        }
        // Not a mouse sequence — push the prefix to residual and
        // continue from the next char.
        this.residual += this.buffer.slice(0, 2);
        this.buffer = this.buffer.slice(2);
        continue;
      }
      this.onEvent(parsed.event);
      this.buffer = this.buffer.slice(parsed.bytes);
      emitted++;
    }
    return emitted;
  }

  /**
   * Consume and return any non-mouse bytes the parser has accumulated.
   * The host should forward these to ink's input pipeline.
   */
  getResidual(): string {
    const out = this.residual;
    this.residual = '';
    return out;
  }

  private residual: string = '';
}

/**
 * ANSI escape sequences to ENABLE mouse reporting. Send to stdout
 * during startup if the user has opted in AND `process.stdout.isTTY`
 * is true.
 *
 *   \x1b[?1000h — basic mouse press/release (X10 protocol)
 *   \x1b[?1002h — button-event tracking (press + release + drag while held)
 *   \x1b[?1006h — SGR extended encoding (lifts the 223 col/row cap)
 *
 * We enable 1002 (drag tracking) so click-and-drag selection becomes
 * possible later; for our v1 we only need press/release/wheel so the
 * extra bytes are harmless if unused.
 *
 * Wheel events arrive as press events with bit 6 set in the button
 * code (handled by `decodeButton`) on all SGR-capable terminals — no
 * extra mode needs enabling.
 */
export const MOUSE_ENABLE_SEQUENCE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';

/** ANSI escape sequences to DISABLE mouse reporting on shutdown. */
export const MOUSE_DISABLE_SEQUENCE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

/**
 * Heuristic terminal-capability check. Returns true when the terminal
 * is reasonably likely to support SGR mouse reporting based on the
 * `TERM` and `TERM_PROGRAM` env vars. False positives are safe (the
 * terminal will simply ignore the enable sequence and no mouse bytes
 * will arrive); false negatives just mean a user has to set
 * `editor.mouseSupport = true` explicitly.
 *
 * The check is intentionally permissive: any TERM that starts with
 * `xterm`, `screen`, `tmux`, `alacritty`, `kitty`, `wezterm`,
 * `ghostty`, or `rxvt` is considered capable. Plain `dumb` / `linux`
 * are rejected.
 */
export function detectMouseCapability(env: NodeJS.ProcessEnv = process.env): boolean {
  const term = env['TERM'] ?? '';
  const program = env['TERM_PROGRAM'] ?? '';
  if (term.length === 0) return false;
  if (term === 'dumb' || term === 'linux') return false;
  const lc = term.toLowerCase();
  const prefixes = [
    'xterm',
    'screen',
    'tmux',
    'alacritty',
    'kitty',
    'wezterm',
    'ghostty',
    'rxvt',
    'vt100',
    'vt220',
  ];
  if (prefixes.some((p) => lc.startsWith(p))) return true;
  // Some terminals leave TERM at 'xterm-256color' but expose themselves
  // via TERM_PROGRAM (iTerm.app, Apple_Terminal, vscode, ...).
  if (program.length > 0) return true;
  return false;
}

/** Test-only namespace. */
export const __test__ = {
  decodeButton,
  findSgrTerminator,
};
