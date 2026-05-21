/**
 * R9 — InputBar custom editor pure helpers (Shift+Enter newline).
 *
 * Agent 4 R9 replaced the @inkjs/ui `<TextInput>`-based InputBar with a
 * custom inline editor that owns the entire keypress dispatch. The bulk
 * of the logic is React+ink — testing the live keypress flow requires
 * `ink-testing-library`. However, a useful subset is implemented as
 * pure helpers around the `EditorState` data structure:
 *
 *   - `splitMultiline(text)`     — externally-supplied multi-line text
 *                                  → `EditorState` with the trailing
 *                                  partial line as the active row.
 *   - `composeFullText(state)`   — joins `committedLines` + active
 *                                  row with `\n` and resolves any
 *                                  paste markers back to their text.
 *   - `isPasteEvent(input)`      — heuristic: is this keypress a bulk
 *                                  paste (>= 200 chars OR multi-line
 *                                  with >= 5 lines)?
 *
 * These helpers are reachable via the `__test__` namespace export.
 * The full keypress / cursor / paste-detection flow is covered by the
 * Agent 4 R9 manual smoke harness; here we lock down the pure pieces.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { __test__ } from '@/ui/components/InputBar';

const { splitMultiline, composeFullText, isPasteEvent } = __test__;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT_BAR_SRC = readFileSync(
  path.resolve(HERE, '..', '..', 'src', 'ui', 'components', 'InputBar.tsx'),
  'utf8',
);

describe('InputBar — SHIFT-ENTER-SECTION (TUI parity with web Composer)', () => {
  test('section markers are present (start + end)', () => {
    expect(INPUT_BAR_SRC).toMatch(/SHIFT-ENTER-SECTION — start/);
    expect(INPUT_BAR_SRC).toMatch(/SHIFT-ENTER-SECTION — end/);
  });

  test('the Shift+Enter branch checks `key.return && key.shift` BEFORE the plain-Enter submit', () => {
    const startIdx = INPUT_BAR_SRC.indexOf('SHIFT-ENTER-SECTION — start');
    const endIdx = INPUT_BAR_SRC.indexOf('SHIFT-ENTER-SECTION — end');
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = INPUT_BAR_SRC.slice(startIdx, endIdx);
    expect(block).toMatch(/if\s*\(\s*key\.return\s*&&\s*key\.shift\s*\)/);
    // The Shift+Enter handler must NOT call onSubmit — that is the
    // exact regression we're guarding against.
    expect(block).not.toMatch(/onSubmit\(/);
  });

  test('the Shift+Enter branch consumes the keystroke (returns true)', () => {
    const startIdx = INPUT_BAR_SRC.indexOf('SHIFT-ENTER-SECTION — start');
    const endIdx = INPUT_BAR_SRC.indexOf('SHIFT-ENTER-SECTION — end');
    const block = INPUT_BAR_SRC.slice(startIdx, endIdx);
    expect(block).toMatch(/return\s+true;/);
  });

  test('Shift+Enter branch sits before the plain-Enter (`if (key.return)`) branch', () => {
    const shiftBranchIdx = INPUT_BAR_SRC.search(
      /if\s*\(\s*key\.return\s*&&\s*key\.shift\s*\)/,
    );
    const plainBranchIdx = INPUT_BAR_SRC.search(
      /if\s*\(\s*key\.return\s*\)\s*\{/,
    );
    expect(shiftBranchIdx).toBeGreaterThan(-1);
    expect(plainBranchIdx).toBeGreaterThan(shiftBranchIdx);
  });
});

describe('InputBar.splitMultiline (R9)', () => {
  test('empty string → EMPTY_STATE shape (no committed lines, empty active)', () => {
    const state = splitMultiline('');
    expect(state.committedLines).toEqual([]);
    expect(state.value).toBe('');
    expect(state.cursorOffset).toBe(0);
    expect(state.pastes.size).toBe(0);
  });

  test('single-line input → no committed lines, value === input', () => {
    const state = splitMultiline('hello world');
    expect(state.committedLines).toEqual([]);
    expect(state.value).toBe('hello world');
    expect(state.cursorOffset).toBe('hello world'.length);
  });

  test('two-line input → one committed line + active row is the second line', () => {
    const state = splitMultiline('first\nsecond');
    expect(state.committedLines).toEqual(['first']);
    expect(state.value).toBe('second');
    expect(state.cursorOffset).toBe('second'.length);
  });

  test('three-line input → two committed + active is the third', () => {
    const state = splitMultiline('a\nb\nc');
    expect(state.committedLines).toEqual(['a', 'b']);
    expect(state.value).toBe('c');
    expect(state.cursorOffset).toBe(1);
  });

  test('trailing newline → an empty active row (Shift+Enter cursor position)', () => {
    const state = splitMultiline('line1\n');
    expect(state.committedLines).toEqual(['line1']);
    expect(state.value).toBe('');
    expect(state.cursorOffset).toBe(0);
  });

  test('only newlines → all empty committed rows + empty active', () => {
    const state = splitMultiline('\n\n\n');
    expect(state.committedLines).toEqual(['', '', '']);
    expect(state.value).toBe('');
    expect(state.cursorOffset).toBe(0);
  });

  test('cursor lands at the END of the last partial line', () => {
    const state = splitMultiline('foo\nbar baz qux');
    expect(state.cursorOffset).toBe('bar baz qux'.length);
  });
});

describe('InputBar.composeFullText (R9)', () => {
  test('empty state → empty string', () => {
    const state = splitMultiline('');
    expect(composeFullText(state)).toBe('');
  });

  test('single-line state round-trips through compose', () => {
    const state = splitMultiline('the quick brown fox');
    expect(composeFullText(state)).toBe('the quick brown fox');
  });

  test('multi-line state round-trips through compose', () => {
    const state = splitMultiline('a\nb\nc');
    expect(composeFullText(state)).toBe('a\nb\nc');
  });

  test('trailing-newline state round-trips through compose', () => {
    // splitMultiline('foo\n') → committed=['foo'], value='' →
    // composeFullText joins ['foo', ''] → 'foo\n'
    const state = splitMultiline('foo\n');
    expect(composeFullText(state)).toBe('foo\n');
  });

  test('manually-built state with multiple committed lines composes correctly', () => {
    const state = {
      committedLines: ['hello', 'world', ''] as const,
      // M5 — parallel id array + monotonic seq.
      committedLineIds: [0, 1, 2] as const,
      committedLineSeq: 3,
      value: 'tail',
      cursorOffset: 4,
      pastes: new Map(),
      pasteCounter: 0,
    };
    // committedLines + value → ['hello', 'world', '', 'tail'] joined by \n
    expect(composeFullText(state)).toBe('hello\nworld\n\ntail');
  });

  test('joins committedLines and active value with \\n separators', () => {
    const state = {
      committedLines: ['line-a'] as const,
      committedLineIds: [0] as const,
      committedLineSeq: 1,
      value: 'line-b',
      cursorOffset: 6,
      pastes: new Map(),
      pasteCounter: 0,
    };
    expect(composeFullText(state)).toBe('line-a\nline-b');
  });

  test('orphan paste markers (id not in pastes map) drop to empty string', () => {
    // Simulate a state where the active line contains a paste marker
    // whose id is NOT present in `pastes`. The marker should resolve
    // to "" rather than leaking the sentinel sequence into the output.
    const orphan = '\x02PASTE:' + '00000000-0000-0000-0000-000000000000' + '\x03';
    const state = {
      committedLines: [] as const,
      committedLineIds: [] as const,
      committedLineSeq: 0,
      value: `prefix ${orphan} suffix`,
      cursorOffset: 0,
      pastes: new Map(),
      pasteCounter: 0,
    };
    const out = composeFullText(state);
    expect(out).toBe('prefix  suffix');
    // Sanity: the sentinel chars must not appear in the result.
    expect(out).not.toContain('\x02');
    expect(out).not.toContain('\x03');
  });
});

describe('InputBar.splitMultiline ↔ composeFullText round-trip (R9)', () => {
  test('round-trip for a variety of inputs', () => {
    const inputs = [
      '',
      'single',
      'a\nb',
      'a\nb\nc\nd',
      'foo\n',
      '\nleading-empty',
      'with spaces\nand more spaces\n  trailing',
    ];
    for (const text of inputs) {
      const composed = composeFullText(splitMultiline(text));
      expect(composed).toBe(text);
    }
  });
});

describe('InputBar.isPasteEvent (R9)', () => {
  test('a single character is NOT a paste event', () => {
    expect(isPasteEvent('a')).toBe(false);
    expect(isPasteEvent(' ')).toBe(false);
    expect(isPasteEvent('!')).toBe(false);
  });

  test('a short multi-character string is NOT a paste event', () => {
    expect(isPasteEvent('hello')).toBe(false);
    expect(isPasteEvent('a few words')).toBe(false);
  });

  test('a string of >= 200 chars IS a paste event (regardless of newlines)', () => {
    const big = 'x'.repeat(200);
    expect(isPasteEvent(big)).toBe(true);
    expect(isPasteEvent(big + 'y')).toBe(true);
  });

  test('a string just under 200 chars without newlines is NOT a paste event', () => {
    expect(isPasteEvent('x'.repeat(199))).toBe(false);
  });

  test('two-line input (1 newline) is NOT a paste event', () => {
    expect(isPasteEvent('first\nsecond')).toBe(false);
  });

  test('three-line input (2 newlines) is NOT a paste event', () => {
    expect(isPasteEvent('a\nb\nc')).toBe(false);
  });

  test('four-line input (3 newlines) is NOT a paste event', () => {
    expect(isPasteEvent('a\nb\nc\nd')).toBe(false);
  });

  test('five-line input (4 newlines) IS a paste event', () => {
    expect(isPasteEvent('a\nb\nc\nd\ne')).toBe(true);
  });

  test('six-line input (5 newlines) IS a paste event', () => {
    expect(isPasteEvent('a\nb\nc\nd\ne\nf')).toBe(true);
  });
});
