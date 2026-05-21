/**
 * Vim engine — pure reducer-style state machine.
 *
 * Input: `step(state, buffer, key)` → `{ state, actions, consumed }`.
 *
 * The engine owns NONE of the buffer. The host (InputBar) flattens its
 * committed-lines + active-line representation into a `VimBuffer`,
 * passes that + the current key + the prior `VimState` in, and applies
 * whatever actions the engine emits to its own buffer state.
 *
 * Supported motions: h j k l, w b e, 0 $, gg G, f<ch> t<ch> F<ch> T<ch>,
 *                    % (matching bracket), n (no-op — search not wired).
 * Supported edits:   i I a A o O, x X, dd cc yy, dw cw yw, d$ c$ y$,
 *                    p P, > <, r<ch>.
 * Visual mode:       v V (enter), y / d (consume), Esc (exit).
 * Command mode:      `:w` is a no-op (submit lives in the host), `:q`
 *                    emits `SUBMIT_COMMAND` so the host can close any
 *                    reading-mode overlay. User-defined later.
 *
 * Activation: never instantiated unless `config.editor.vimMode === true`.
 */

import type {
  VimAction,
  VimBuffer,
  VimFind,
  VimKey,
  VimMode,
  VimPending,
  VimRegister,
  VimSelection,
  VimState,
  VimStepResult,
} from './types';

/** Initial vim state — defaults to normal mode with no pending op. */
export function makeInitialState(startInsert: boolean): VimState {
  return {
    mode: startInsert ? 'insert' : 'normal',
    selection: null,
    command: '',
    pending: null,
    register: { text: '', linewise: false },
    lastFind: null,
    count: 0,
  };
}

/** A pure no-op step — returned for unrecognised keys in normal mode. */
function noop(state: VimState): VimStepResult {
  return { state, actions: [], consumed: false };
}

/** A consumed-but-no-action step — keeps the mode chip stable but
 *  prevents the host from inserting the key as text. */
function consumeOnly(state: VimState): VimStepResult {
  return { state, actions: [], consumed: true };
}

/** A consumed step that applies actions. */
function withActions(state: VimState, ...actions: VimAction[]): VimStepResult {
  return { state, actions, consumed: true };
}

/**
 * Clamp a (row, col) pair to the buffer. col may equal `lines[row].length`
 * to indicate "after the last char" (insert / append at end of line).
 */
function clampCursor(
  buffer: VimBuffer,
  row: number,
  col: number,
  allowPastEnd: boolean,
): { row: number; col: number } {
  const rows = buffer.lines.length;
  const safeRow = Math.max(0, Math.min(rows - 1, row));
  const line = buffer.lines[safeRow] ?? '';
  const maxCol = allowPastEnd ? line.length : Math.max(0, line.length - 1);
  const safeCol = Math.max(0, Math.min(maxCol, col));
  return { row: safeRow, col: safeCol };
}

/** Compare two cursor positions for ordering. */
function compareCursors(
  a: { row: number; col: number },
  b: { row: number; col: number },
): number {
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

/** Normalise a selection so `start <= end`. */
function normaliseSelection(sel: VimSelection): {
  start: { row: number; col: number };
  end: { row: number; col: number };
  linewise: boolean;
} {
  const cmp = compareCursors(sel.anchor, sel.head);
  const start = cmp <= 0 ? sel.anchor : sel.head;
  const end = cmp <= 0 ? sel.head : sel.anchor;
  return { start, end, linewise: sel.linewise };
}

/** Detect word character class. Treats word chars as `[A-Za-z0-9_]`. */
function isWord(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/** Move to the start of the next word (basic `w` motion). */
function moveWordForward(
  buffer: VimBuffer,
  row: number,
  col: number,
): { row: number; col: number } {
  let r = row;
  let c = col;
  const line = buffer.lines[r] ?? '';
  // Skip current word if we're in one.
  const startCh = line.charAt(c);
  if (startCh.length > 0 && isWord(startCh)) {
    while (c < line.length && isWord(line.charAt(c))) c++;
  } else if (startCh.length > 0 && !/\s/.test(startCh)) {
    while (c < line.length && !isWord(line.charAt(c)) && !/\s/.test(line.charAt(c))) c++;
  }
  // Skip whitespace.
  while (c < line.length && /\s/.test(line.charAt(c))) c++;
  if (c >= line.length && r < buffer.lines.length - 1) {
    return { row: r + 1, col: 0 };
  }
  return { row: r, col: c };
}

/** Move to the start of the previous word (basic `b` motion). */
function moveWordBackward(
  buffer: VimBuffer,
  row: number,
  col: number,
): { row: number; col: number } {
  let r = row;
  let c = col;
  if (c === 0) {
    if (r === 0) return { row: 0, col: 0 };
    r -= 1;
    const prev = buffer.lines[r] ?? '';
    c = prev.length;
  }
  const line = buffer.lines[r] ?? '';
  // Step back one then skip whitespace.
  c = Math.max(0, c - 1);
  while (c > 0 && /\s/.test(line.charAt(c))) c--;
  // Step to the start of the current word/punct class.
  const cls = isWord(line.charAt(c)) ? 'w' : /\s/.test(line.charAt(c)) ? 's' : 'p';
  if (cls === 'w') {
    while (c > 0 && isWord(line.charAt(c - 1))) c--;
  } else if (cls === 'p') {
    while (c > 0 && !isWord(line.charAt(c - 1)) && !/\s/.test(line.charAt(c - 1))) c--;
  }
  return { row: r, col: c };
}

/** Move to the end of the current/next word (basic `e` motion). */
function moveWordEnd(
  buffer: VimBuffer,
  row: number,
  col: number,
): { row: number; col: number } {
  let r = row;
  let c = col;
  const line = buffer.lines[r] ?? '';
  // Step forward if we're at the end of a word.
  if (c < line.length - 1) c++;
  // Skip whitespace.
  while (c < line.length && /\s/.test(line.charAt(c))) c++;
  if (c >= line.length) {
    if (r < buffer.lines.length - 1) {
      return moveWordEnd(buffer, r + 1, 0);
    }
    return { row: r, col: Math.max(0, line.length - 1) };
  }
  const cls = isWord(line.charAt(c)) ? 'w' : 'p';
  if (cls === 'w') {
    while (c < line.length - 1 && isWord(line.charAt(c + 1))) c++;
  } else {
    while (
      c < line.length - 1 &&
      !isWord(line.charAt(c + 1)) &&
      !/\s/.test(line.charAt(c + 1))
    ) {
      c++;
    }
  }
  return { row: r, col: c };
}

/** Apply `f<ch>` / `F<ch>` / `t<ch>` / `T<ch>`. */
function moveFind(
  buffer: VimBuffer,
  row: number,
  col: number,
  find: VimFind,
): { row: number; col: number } | null {
  const line = buffer.lines[row] ?? '';
  if (find.kind === 'f' || find.kind === 't') {
    for (let i = col + 1; i < line.length; i++) {
      if (line.charAt(i) === find.char) {
        return { row, col: find.kind === 't' ? i - 1 : i };
      }
    }
    return null;
  }
  for (let i = col - 1; i >= 0; i--) {
    if (line.charAt(i) === find.char) {
      return { row, col: find.kind === 'T' ? i + 1 : i };
    }
  }
  return null;
}

/** Find matching bracket position for `%`. */
function moveMatchingBracket(
  buffer: VimBuffer,
  row: number,
  col: number,
): { row: number; col: number } | null {
  const openToClose: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const closeToOpen: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const line = buffer.lines[row] ?? '';
  const ch = line.charAt(col);
  if (openToClose[ch] !== undefined) {
    const close = openToClose[ch];
    let depth = 0;
    for (let r = row; r < buffer.lines.length; r++) {
      const l = buffer.lines[r] ?? '';
      for (let c = r === row ? col : 0; c < l.length; c++) {
        const x = l.charAt(c);
        if (x === ch) depth++;
        else if (x === close) {
          depth--;
          if (depth === 0) return { row: r, col: c };
        }
      }
    }
    return null;
  }
  if (closeToOpen[ch] !== undefined) {
    const open = closeToOpen[ch];
    let depth = 0;
    for (let r = row; r >= 0; r--) {
      const l = buffer.lines[r] ?? '';
      const startCol = r === row ? col : l.length - 1;
      for (let c = startCol; c >= 0; c--) {
        const x = l.charAt(c);
        if (x === ch) depth++;
        else if (x === open) {
          depth--;
          if (depth === 0) return { row: r, col: c };
        }
      }
    }
    return null;
  }
  return null;
}

/** Build a delete-range action from current cursor to target cursor. */
function rangeBetween(
  a: { row: number; col: number },
  b: { row: number; col: number },
  linewise: boolean,
): { start: { row: number; col: number }; end: { row: number; col: number }; linewise: boolean } {
  const cmp = compareCursors(a, b);
  const start = cmp <= 0 ? a : b;
  const end = cmp <= 0 ? b : a;
  return { start, end, linewise };
}

/**
 * Extract text between two cursors from a buffer. Inclusive on `start.col`,
 * exclusive on `end.col` (charwise) — exactly what vim's delete/yank/change
 * use. For linewise the function returns each full affected line joined by
 * `\n` plus a trailing newline so paste-after / paste-before reproduces the
 * line semantics.
 */
function extractText(
  buffer: VimBuffer,
  start: { row: number; col: number },
  end: { row: number; col: number },
  linewise: boolean,
): string {
  if (linewise) {
    const out: string[] = [];
    for (let r = start.row; r <= end.row; r++) {
      out.push(buffer.lines[r] ?? '');
    }
    return out.join('\n') + '\n';
  }
  if (start.row === end.row) {
    const line = buffer.lines[start.row] ?? '';
    return line.slice(start.col, end.col);
  }
  const startLine = buffer.lines[start.row] ?? '';
  const endLine = buffer.lines[end.row] ?? '';
  const middle: string[] = [];
  for (let r = start.row + 1; r < end.row; r++) middle.push(buffer.lines[r] ?? '');
  const segments = [startLine.slice(start.col), ...middle, endLine.slice(0, end.col)];
  return segments.join('\n');
}

/**
 * Dispatch a single keystroke. The engine never mutates the buffer; the
 * host applies each emitted action in turn.
 */
export function step(state: VimState, buffer: VimBuffer, key: VimKey): VimStepResult {
  // Esc — universally returns to normal mode (or clears pending op).
  if (key.escape === true) {
    return {
      state: {
        ...state,
        mode: 'normal',
        selection: null,
        command: '',
        pending: null,
        count: 0,
      },
      actions: [],
      consumed: true,
    };
  }

  if (state.mode === 'insert') {
    return stepInsert(state, buffer, key);
  }
  if (state.mode === 'command') {
    return stepCommand(state, buffer, key);
  }
  // Normal + visual share the motion/operator machinery.
  return stepNormalOrVisual(state, buffer, key);
}

// ---------- Insert mode ----------

function stepInsert(state: VimState, buffer: VimBuffer, key: VimKey): VimStepResult {
  // The engine lets the host handle text insertion / arrows / backspace
  // verbatim — those are the InputBar's normal operations. Insert mode
  // exists primarily so normal-mode key bindings DON'T fire while typing.
  // We mark every event as NOT consumed so the host's reducer runs.
  return { state, actions: [], consumed: false };
}

// ---------- Command mode (`:` line) ----------

function stepCommand(state: VimState, _buffer: VimBuffer, key: VimKey): VimStepResult {
  if (key.return === true) {
    const cmd = state.command;
    return withActions(
      { ...state, mode: 'normal', command: '' },
      { type: 'SUBMIT_COMMAND', command: cmd },
    );
  }
  if (key.backspace === true || key.delete === true) {
    if (state.command.length === 0) {
      return consumeOnly({ ...state, mode: 'normal', command: '' });
    }
    return consumeOnly({ ...state, command: state.command.slice(0, -1) });
  }
  if (key.input.length > 0 && !key.ctrl) {
    return consumeOnly({ ...state, command: state.command + key.input });
  }
  return consumeOnly(state);
}

// ---------- Normal + Visual ----------

function stepNormalOrVisual(
  state: VimState,
  buffer: VimBuffer,
  key: VimKey,
): VimStepResult {
  // Handle pending input first.
  if (state.pending !== null) {
    return handlePending(state, buffer, key, state.pending);
  }

  // Handle digits → count accumulator. `0` is special (start-of-line)
  // when `count` is currently zero; otherwise it appends to count.
  if (key.input.length === 1 && /[1-9]/.test(key.input)) {
    return consumeOnly({ ...state, count: state.count * 10 + Number(key.input) });
  }
  if (key.input === '0' && state.count > 0) {
    return consumeOnly({ ...state, count: state.count * 10 });
  }

  const repeat = Math.max(1, state.count);
  const input = key.input;
  const cursor = buffer.cursor;

  // Motions ---------------------------------------------------------
  let dest: { row: number; col: number } | null = null;
  let motionLinewise = false;

  if (input === 'h' || key.leftArrow === true) {
    dest = clampCursor(buffer, cursor.row, cursor.col - repeat, false);
  } else if (input === 'l' || key.rightArrow === true) {
    dest = clampCursor(buffer, cursor.row, cursor.col + repeat, false);
  } else if (input === 'j' || key.downArrow === true) {
    dest = clampCursor(buffer, cursor.row + repeat, cursor.col, false);
  } else if (input === 'k' || key.upArrow === true) {
    dest = clampCursor(buffer, cursor.row - repeat, cursor.col, false);
  } else if (input === 'w') {
    let p = { row: cursor.row, col: cursor.col };
    for (let i = 0; i < repeat; i++) p = moveWordForward(buffer, p.row, p.col);
    dest = p;
  } else if (input === 'b') {
    let p = { row: cursor.row, col: cursor.col };
    for (let i = 0; i < repeat; i++) p = moveWordBackward(buffer, p.row, p.col);
    dest = p;
  } else if (input === 'e') {
    let p = { row: cursor.row, col: cursor.col };
    for (let i = 0; i < repeat; i++) p = moveWordEnd(buffer, p.row, p.col);
    dest = p;
  } else if (input === '0') {
    dest = { row: cursor.row, col: 0 };
  } else if (input === '$') {
    const line = buffer.lines[cursor.row] ?? '';
    dest = { row: cursor.row, col: Math.max(0, line.length - 1) };
  } else if (input === 'G') {
    const target = state.count > 0 ? state.count - 1 : buffer.lines.length - 1;
    dest = clampCursor(buffer, target, 0, false);
    motionLinewise = true;
  } else if (input === '%') {
    const match = moveMatchingBracket(buffer, cursor.row, cursor.col);
    if (match !== null) dest = match;
  } else if (input === 'g') {
    return consumeOnly({ ...state, pending: { kind: 'motion-prefix', prefix: 'g' } });
  } else if (input === 'f' || input === 'F' || input === 't' || input === 'T') {
    return consumeOnly({ ...state, pending: { kind: 'find', find: input } });
  } else if (input === ';' && state.lastFind !== null) {
    const p = moveFind(buffer, cursor.row, cursor.col, state.lastFind);
    if (p !== null) dest = p;
  } else if (input === 'n') {
    // search not wired — no-op consume so it doesn't fall through to
    // insert mode.
    return consumeOnly({ ...state, count: 0 });
  }

  if (dest !== null) {
    return finishMotion(state, dest, motionLinewise);
  }

  // Mode entries ----------------------------------------------------
  if (input === 'i') return enterInsert(state, cursor.row, cursor.col);
  if (input === 'I') return enterInsert(state, cursor.row, firstNonBlank(buffer.lines[cursor.row] ?? ''));
  if (input === 'a') return enterInsert(state, cursor.row, cursor.col + 1);
  if (input === 'A') return enterInsert(state, cursor.row, (buffer.lines[cursor.row] ?? '').length);
  if (input === 'o') {
    return withActions(
      { ...state, mode: 'insert', count: 0 },
      { type: 'OPEN_LINE_BELOW', row: cursor.row },
    );
  }
  if (input === 'O') {
    return withActions(
      { ...state, mode: 'insert', count: 0 },
      { type: 'OPEN_LINE_ABOVE', row: cursor.row },
    );
  }
  if (input === 'v') {
    return consumeOnly({
      ...state,
      mode: 'visual',
      selection: {
        anchor: { row: cursor.row, col: cursor.col },
        head: { row: cursor.row, col: cursor.col },
        linewise: false,
      },
      count: 0,
    });
  }
  if (input === 'V') {
    return consumeOnly({
      ...state,
      mode: 'visual',
      selection: {
        anchor: { row: cursor.row, col: cursor.col },
        head: { row: cursor.row, col: cursor.col },
        linewise: true,
      },
      count: 0,
    });
  }
  if (input === ':') {
    return consumeOnly({ ...state, mode: 'command', command: '', count: 0 });
  }

  // Edits -----------------------------------------------------------
  if (input === 'x') {
    const line = buffer.lines[cursor.row] ?? '';
    if (line.length === 0) return consumeOnly({ ...state, count: 0 });
    const start = { row: cursor.row, col: cursor.col };
    const end = { row: cursor.row, col: Math.min(line.length, cursor.col + repeat) };
    const removed = line.slice(start.col, end.col);
    return withActions(
      { ...state, register: { text: removed, linewise: false }, count: 0 },
      { type: 'DELETE_RANGE', start, end, linewise: false },
    );
  }
  if (input === 'X') {
    if (cursor.col === 0) return consumeOnly({ ...state, count: 0 });
    const line = buffer.lines[cursor.row] ?? '';
    const start = { row: cursor.row, col: Math.max(0, cursor.col - repeat) };
    const end = { row: cursor.row, col: cursor.col };
    const removed = line.slice(start.col, end.col);
    return withActions(
      { ...state, register: { text: removed, linewise: false }, count: 0 },
      { type: 'DELETE_RANGE', start, end, linewise: false },
    );
  }
  if (input === 'd' || input === 'c' || input === 'y' || input === '>' || input === '<') {
    if (state.mode === 'visual') {
      return applyVisualOperator(state, buffer, input as 'd' | 'c' | 'y' | '>' | '<');
    }
    return consumeOnly({
      ...state,
      pending: { kind: 'operator', op: input as 'd' | 'c' | 'y' | '>' | '<' },
    });
  }
  if (input === 'p' || input === 'P') {
    return applyPaste(state, buffer, input === 'p');
  }
  if (input === 'r') {
    return consumeOnly({ ...state, pending: { kind: 'replace' } });
  }
  if (input === 'D') {
    // Shortcut for `d$`.
    const line = buffer.lines[cursor.row] ?? '';
    const start = { row: cursor.row, col: cursor.col };
    const end = { row: cursor.row, col: line.length };
    const removed = line.slice(start.col, end.col);
    return withActions(
      { ...state, register: { text: removed, linewise: false }, count: 0 },
      { type: 'DELETE_RANGE', start, end, linewise: false },
    );
  }
  if (input === 'C') {
    const line = buffer.lines[cursor.row] ?? '';
    const start = { row: cursor.row, col: cursor.col };
    const end = { row: cursor.row, col: line.length };
    const removed = line.slice(start.col, end.col);
    return withActions(
      { ...state, mode: 'insert', register: { text: removed, linewise: false }, count: 0 },
      { type: 'DELETE_RANGE', start, end, linewise: false },
    );
  }
  if (input === 'Y') {
    // Shortcut for `yy`.
    const line = buffer.lines[cursor.row] ?? '';
    return consumeOnly({ ...state, register: { text: line + '\n', linewise: true }, count: 0 });
  }
  if (input === 's') {
    // Substitute — delete char, enter insert.
    const line = buffer.lines[cursor.row] ?? '';
    if (line.length === 0) {
      return withActions({ ...state, mode: 'insert', count: 0 });
    }
    const start = { row: cursor.row, col: cursor.col };
    const end = { row: cursor.row, col: Math.min(line.length, cursor.col + repeat) };
    return withActions(
      { ...state, mode: 'insert', count: 0 },
      { type: 'DELETE_RANGE', start, end, linewise: false },
    );
  }

  return noop({ ...state, count: 0 });
}

function enterInsert(state: VimState, row: number, col: number): VimStepResult {
  return withActions(
    { ...state, mode: 'insert', count: 0 },
    { type: 'MOVE_CURSOR', row, col },
  );
}

function firstNonBlank(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (!/\s/.test(line.charAt(i))) return i;
  }
  return 0;
}

function finishMotion(
  state: VimState,
  dest: { row: number; col: number },
  motionLinewise: boolean,
): VimStepResult {
  if (state.mode === 'visual' && state.selection !== null) {
    const sel: VimSelection = {
      anchor: state.selection.anchor,
      head: dest,
      linewise: state.selection.linewise || motionLinewise,
    };
    return withActions(
      { ...state, selection: sel, count: 0 },
      { type: 'MOVE_CURSOR', row: dest.row, col: dest.col },
    );
  }
  return withActions(
    { ...state, count: 0 },
    { type: 'MOVE_CURSOR', row: dest.row, col: dest.col },
  );
}

function handlePending(
  state: VimState,
  buffer: VimBuffer,
  key: VimKey,
  pending: VimPending,
): VimStepResult {
  if (pending.kind === 'motion-prefix') {
    if (pending.prefix === 'g' && key.input === 'g') {
      // `gg` → start of buffer (line 1 or `count` if provided).
      const target = state.count > 0 ? state.count - 1 : 0;
      const dest = clampCursor(buffer, target, 0, false);
      return finishMotion({ ...state, pending: null }, dest, true);
    }
    return consumeOnly({ ...state, pending: null, count: 0 });
  }
  if (pending.kind === 'find' && key.input.length === 1) {
    const find: VimFind = { kind: pending.find, char: key.input };
    const dest = moveFind(buffer, buffer.cursor.row, buffer.cursor.col, find);
    if (dest === null) {
      return consumeOnly({ ...state, pending: null, lastFind: find, count: 0 });
    }
    return finishMotion({ ...state, pending: null, lastFind: find }, dest, false);
  }
  if (pending.kind === 'replace' && key.input.length === 1) {
    const line = buffer.lines[buffer.cursor.row] ?? '';
    if (line.length === 0) return consumeOnly({ ...state, pending: null, count: 0 });
    const start = { row: buffer.cursor.row, col: buffer.cursor.col };
    const end = { row: buffer.cursor.row, col: Math.min(line.length, buffer.cursor.col + 1) };
    return withActions(
      { ...state, pending: null, count: 0 },
      { type: 'REPLACE_RANGE', start, end, text: key.input, linewise: false },
    );
  }
  if (pending.kind === 'operator') {
    return handleOperatorMotion(state, buffer, key, pending.op);
  }
  return consumeOnly({ ...state, pending: null });
}

function handleOperatorMotion(
  state: VimState,
  buffer: VimBuffer,
  key: VimKey,
  op: 'd' | 'c' | 'y' | '>' | '<',
): VimStepResult {
  const input = key.input;
  const cursor = buffer.cursor;

  // Linewise doubled operator (dd, cc, yy, >>, <<).
  if (input === op) {
    const row = cursor.row;
    if (op === '>') {
      return withActions(
        { ...state, pending: null, count: 0 },
        { type: 'INDENT_LINES', fromRow: row, toRow: row, dir: 'in' },
      );
    }
    if (op === '<') {
      return withActions(
        { ...state, pending: null, count: 0 },
        { type: 'INDENT_LINES', fromRow: row, toRow: row, dir: 'out' },
      );
    }
    const line = buffer.lines[row] ?? '';
    const reg: VimRegister = { text: line + '\n', linewise: true };
    if (op === 'y') {
      return consumeOnly({ ...state, pending: null, register: reg, count: 0 });
    }
    const start = { row, col: 0 };
    const end = { row, col: line.length };
    const actions: VimAction[] = [
      { type: 'DELETE_RANGE', start: { row, col: 0 }, end: { row: row + 1, col: 0 }, linewise: true },
    ];
    if (op === 'c') {
      // `cc` deletes the line content but keeps the (empty) line and
      // enters insert mode. We emit a delete-to-start-of-line instead
      // of the whole-row delete above.
      actions[0] = { type: 'DELETE_RANGE', start, end, linewise: false };
      return withActions({ ...state, mode: 'insert', pending: null, register: reg, count: 0 }, ...actions);
    }
    return withActions({ ...state, pending: null, register: reg, count: 0 }, ...actions);
  }

  // Motion + operator. We compute the destination, then apply op.
  let dest: { row: number; col: number } | null = null;
  if (input === 'w') dest = moveWordForward(buffer, cursor.row, cursor.col);
  else if (input === 'b') dest = moveWordBackward(buffer, cursor.row, cursor.col);
  else if (input === 'e') {
    const e = moveWordEnd(buffer, cursor.row, cursor.col);
    dest = { row: e.row, col: e.col + 1 };
  } else if (input === '0') dest = { row: cursor.row, col: 0 };
  else if (input === '$') {
    const line = buffer.lines[cursor.row] ?? '';
    dest = { row: cursor.row, col: line.length };
  } else if (input === 'h') dest = { row: cursor.row, col: Math.max(0, cursor.col - 1) };
  else if (input === 'l') {
    const line = buffer.lines[cursor.row] ?? '';
    dest = { row: cursor.row, col: Math.min(line.length, cursor.col + 1) };
  }

  if (dest === null) {
    return consumeOnly({ ...state, pending: null, count: 0 });
  }

  const range = rangeBetween({ row: cursor.row, col: cursor.col }, dest, false);
  const text = extractText(buffer, range.start, range.end, false);
  const reg: VimRegister = { text, linewise: false };

  if (op === 'y') {
    return consumeOnly({ ...state, pending: null, register: reg, count: 0 });
  }
  if (op === '>') {
    return withActions(
      { ...state, pending: null, count: 0 },
      {
        type: 'INDENT_LINES',
        fromRow: range.start.row,
        toRow: range.end.row,
        dir: 'in',
      },
    );
  }
  if (op === '<') {
    return withActions(
      { ...state, pending: null, count: 0 },
      {
        type: 'INDENT_LINES',
        fromRow: range.start.row,
        toRow: range.end.row,
        dir: 'out',
      },
    );
  }
  if (op === 'c') {
    return withActions(
      { ...state, mode: 'insert', pending: null, register: reg, count: 0 },
      { type: 'DELETE_RANGE', start: range.start, end: range.end, linewise: false },
    );
  }
  return withActions(
    { ...state, pending: null, register: reg, count: 0 },
    { type: 'DELETE_RANGE', start: range.start, end: range.end, linewise: false },
  );
}

function applyVisualOperator(
  state: VimState,
  buffer: VimBuffer,
  op: 'd' | 'c' | 'y' | '>' | '<',
): VimStepResult {
  if (state.selection === null) return consumeOnly({ ...state, mode: 'normal' });
  const { start, end, linewise } = normaliseSelection(state.selection);
  // Visual selection is INCLUSIVE on the end position; the delete range
  // semantics are exclusive — bump end.col by 1 (charwise) or end.row by 1
  // (linewise) to match.
  const effEnd = linewise
    ? { row: Math.min(buffer.lines.length, end.row + 1), col: 0 }
    : {
        row: end.row,
        col: Math.min((buffer.lines[end.row] ?? '').length, end.col + 1),
      };
  const text = extractText(buffer, start, effEnd, linewise);
  const reg: VimRegister = { text, linewise };
  if (op === 'y') {
    return withActions(
      { ...state, mode: 'normal', selection: null, register: reg, count: 0 },
      { type: 'MOVE_CURSOR', row: start.row, col: start.col },
    );
  }
  if (op === '>') {
    return withActions(
      { ...state, mode: 'normal', selection: null, count: 0 },
      { type: 'INDENT_LINES', fromRow: start.row, toRow: end.row, dir: 'in' },
    );
  }
  if (op === '<') {
    return withActions(
      { ...state, mode: 'normal', selection: null, count: 0 },
      { type: 'INDENT_LINES', fromRow: start.row, toRow: end.row, dir: 'out' },
    );
  }
  const actions: VimAction[] = [
    { type: 'DELETE_RANGE', start, end: effEnd, linewise },
  ];
  if (op === 'c') {
    return withActions(
      { ...state, mode: 'insert', selection: null, register: reg, count: 0 },
      ...actions,
    );
  }
  return withActions(
    { ...state, mode: 'normal', selection: null, register: reg, count: 0 },
    ...actions,
  );
}

function applyPaste(state: VimState, buffer: VimBuffer, after: boolean): VimStepResult {
  const reg = state.register;
  if (reg.text.length === 0) return consumeOnly({ ...state, count: 0 });
  const cursor = buffer.cursor;
  if (reg.linewise) {
    const targetRow = after ? cursor.row + 1 : cursor.row;
    // Strip the trailing newline we encode for linewise yanks so the
    // text inserted is exactly the line content.
    const text = reg.text.endsWith('\n') ? reg.text.slice(0, -1) : reg.text;
    return withActions(
      { ...state, count: 0 },
      { type: 'INSERT_TEXT', row: targetRow, col: 0, text: text + '\n' },
      { type: 'MOVE_CURSOR', row: targetRow, col: firstNonBlank(text) },
    );
  }
  const col = after ? cursor.col + 1 : cursor.col;
  return withActions(
    { ...state, count: 0 },
    { type: 'INSERT_TEXT', row: cursor.row, col, text: reg.text },
    { type: 'MOVE_CURSOR', row: cursor.row, col: col + reg.text.length - 1 },
  );
}

/** Small helper exposed for unit tests. */
export const __test__ = {
  moveWordForward,
  moveWordBackward,
  moveWordEnd,
  moveFind,
  moveMatchingBracket,
  extractText,
  firstNonBlank,
  isWord,
};
