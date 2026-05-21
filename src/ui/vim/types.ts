/**
 * Vim mode — shared types.
 *
 * The vim engine is a pure reducer: `(state, key) → { state, actions[] }`.
 * It owns nothing UI-related — InputBar wires the buffer + cursor in,
 * the engine emits a description of what should happen, and the bar
 * applies it. This keeps the engine trivially testable from `bun:test`
 * (no ink, no stdin) and makes it possible to share the same kernel
 * with a web composer later.
 *
 * Activation invariant: every consumer must check `editor.vimMode === true`
 * before consulting the engine. When vim mode is off the engine is
 * never constructed, so the dispatcher never sees a single byte of
 * modal-edit overhead — zero behaviour change for users who don't opt in.
 */

/** The four modes the engine recognises. */
export type VimMode = 'normal' | 'insert' | 'visual' | 'command';

/**
 * An immutable snapshot of the buffer + cursor the engine reads from.
 * The host (InputBar) constructs one of these on every keystroke; the
 * engine never mutates it.
 *
 * `lines` is the flattened line array (committed lines + active line).
 * `cursor.row` is the line index, `cursor.col` is the byte offset
 * within that line. `cursor.col` may equal `lines[row].length` to
 * indicate "past the last char" (insert-mode default position).
 */
export interface VimBuffer {
  readonly lines: readonly string[];
  readonly cursor: { readonly row: number; readonly col: number };
}

/**
 * Visual-mode selection — anchor + head. Both points use the same
 * shape as `VimBuffer.cursor`. In linewise visual (`V`) the col is
 * ignored on read; the engine still tracks it so a switch back to
 * characterwise visual can resume from a sensible column.
 */
export interface VimSelection {
  readonly anchor: { readonly row: number; readonly col: number };
  readonly head: { readonly row: number; readonly col: number };
  readonly linewise: boolean;
}

/**
 * Visible engine state. Hosts read it via `engine.state` to render the
 * mode chip and decide whether to suppress insertion of printable keys.
 *
 * - `command` carries the partial `:`-line the user is typing in
 *   command mode. Cleared on Enter / Esc.
 * - `pending` carries the prefix of a multi-key motion the user has
 *   begun typing (e.g. after pressing `g` we wait for the second key).
 *   `null` when no prefix is pending.
 * - `register` is the unnamed yank/delete buffer (`"`). The engine
 *   uses ONE register; named registers (`"a`) are not yet supported.
 * - `lastFind` tracks the most recent `f<ch>` / `t<ch>` so `;` / `,`
 *   can repeat it. `null` when no find has been recorded.
 * - `count` is the in-progress motion count (e.g. `3w`). Reset after
 *   any operator/motion fires.
 */
export interface VimState {
  readonly mode: VimMode;
  readonly selection: VimSelection | null;
  readonly command: string;
  readonly pending: VimPending | null;
  readonly register: VimRegister;
  readonly lastFind: VimFind | null;
  readonly count: number;
}

/**
 * Operator awaiting a motion (e.g. `d` waiting on `w`).
 *
 * `d`, `c`, `y` all enter this state. `>` and `<` are handled the same
 * way — they're "indent" operators that, after a motion, shift each
 * affected line by one tab/4-spaces.
 *
 * `g` is a *motion* prefix (waiting for the second key to disambiguate
 * `gg` vs other `g`-prefixed motions). We carry it on the same field
 * so the dispatcher can collapse both cases.
 */
export type VimPending =
  | { readonly kind: 'operator'; readonly op: 'd' | 'c' | 'y' | '>' | '<' }
  | { readonly kind: 'motion-prefix'; readonly prefix: 'g' }
  | { readonly kind: 'find'; readonly find: 'f' | 'F' | 't' | 'T' }
  | { readonly kind: 'replace' };

/** Content of the unnamed register. */
export interface VimRegister {
  readonly text: string;
  /** linewise yanks paste below/above the current line, charwise pastes inline. */
  readonly linewise: boolean;
}

/** Most-recent character search, used by `;` and `,`. */
export interface VimFind {
  readonly kind: 'f' | 'F' | 't' | 'T';
  readonly char: string;
}

/**
 * Side-effects the host should apply after a step.
 *
 * The engine NEVER mutates the buffer; it emits an action so the host
 * (which owns the InputBar buffer) can apply it inside its own setState
 * reducer. This is the same pattern as React's reducer dispatch and
 * gives us a single audit point for every edit.
 *
 * Co-ordinates use the same `(row, col)` system as VimBuffer.cursor.
 * A `col` past the end of a line means "append".
 */
export type VimAction =
  | { readonly type: 'NOOP' }
  | { readonly type: 'INSERT_TEXT'; readonly row: number; readonly col: number; readonly text: string }
  | {
      readonly type: 'DELETE_RANGE';
      readonly start: { readonly row: number; readonly col: number };
      readonly end: { readonly row: number; readonly col: number };
      readonly linewise: boolean;
    }
  | {
      readonly type: 'REPLACE_RANGE';
      readonly start: { readonly row: number; readonly col: number };
      readonly end: { readonly row: number; readonly col: number };
      readonly text: string;
      readonly linewise: boolean;
    }
  | { readonly type: 'MOVE_CURSOR'; readonly row: number; readonly col: number }
  | { readonly type: 'OPEN_LINE_BELOW'; readonly row: number }
  | { readonly type: 'OPEN_LINE_ABOVE'; readonly row: number }
  | { readonly type: 'INDENT_LINES'; readonly fromRow: number; readonly toRow: number; readonly dir: 'in' | 'out' }
  | { readonly type: 'SUBMIT_COMMAND'; readonly command: string };

/**
 * Result of a single `step()` call. The host applies `actions` in order
 * and then renders with `state` as the new vim state. If actions is
 * empty the buffer didn't change; if actions is non-empty the buffer
 * was modified — the host's own renderer + autosave logic should fire.
 *
 * `consumed` tells the host whether the key was handled. When `false`
 * the engine ignored the key (e.g. a printable key in normal mode that
 * isn't a recognised motion) — the host should NOT insert it into the
 * buffer (normal mode is non-editing). The only mode where this flag
 * is `false` for a printable key is normal/visual/command after the
 * engine decided it had nothing to do.
 */
export interface VimStepResult {
  readonly state: VimState;
  readonly actions: readonly VimAction[];
  readonly consumed: boolean;
}

/** Keys the host forwards. Mirrors ink's `Key` shape with a couple of
 *  extras the engine cares about (escape, return, backspace). */
export interface VimKey {
  readonly input: string;
  readonly escape?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly tab?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
}
