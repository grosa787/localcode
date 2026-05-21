/**
 * SyntaxBlock — token-coalescing unit tests (M2).
 *
 * The renderer used to emit one <span> per identifier/operator (and one
 * per un-classified character). For typical TS code that produces ~2x
 * the number of DOM nodes required. `coalesceTokens` merges adjacent
 * tokens that share a className so React reconciliation has less work
 * to do.
 */

import { describe, expect, test } from 'vitest';

import { coalesceTokens, type Token } from '../components/SyntaxBlock';

describe('coalesceTokens', () => {
  test('merges adjacent same-class tokens', () => {
    const input: Token[] = [
      { cls: '', text: 'a' },
      { cls: '', text: 'b' },
      { cls: '', text: 'c' },
    ];
    expect(coalesceTokens(input)).toEqual([{ cls: '', text: 'abc' }]);
  });

  test('does not merge tokens with different classes', () => {
    const input: Token[] = [
      { cls: '', text: 'foo' },
      { cls: 'kw', text: 'bar' },
      { cls: '', text: 'baz' },
    ];
    expect(coalesceTokens(input)).toEqual([
      { cls: '', text: 'foo' },
      { cls: 'kw', text: 'bar' },
      { cls: '', text: 'baz' },
    ]);
  });

  test('merges runs of same non-empty class', () => {
    const input: Token[] = [
      { cls: 'kw', text: 'if ' },
      { cls: 'kw', text: 'else' },
    ];
    expect(coalesceTokens(input)).toEqual([{ cls: 'kw', text: 'if else' }]);
  });

  test('empty input yields empty output', () => {
    expect(coalesceTokens([])).toEqual([]);
  });

  test('coalesces typical TS-shaped token stream to <= N/2', () => {
    // Simulate the shape `tokeniseCLike` produces: identifier + space +
    // identifier + space + ... For a 20-token alternating stream
    // [(plain word), (plain space), ...] the post-coalesce length must
    // be 1 (all collapse into the same cls='' run).
    const input: Token[] = [];
    for (let i = 0; i < 20; i++) {
      input.push({ cls: '', text: i % 2 === 0 ? `id${i}` : ' ' });
    }
    const out = coalesceTokens(input);
    expect(out.length).toBeLessThanOrEqual(input.length / 2);
    expect(out.length).toBe(1);
    // No characters were lost in the merge.
    const total = input.reduce((a, t) => a + t.text.length, 0);
    expect(out[0]?.text.length).toBe(total);
  });

  test('preserves order across mixed-class runs', () => {
    const input: Token[] = [
      { cls: '', text: 'const ' },
      { cls: 'kw', text: 'x' },
      { cls: '', text: ' ' },
      { cls: '', text: '=' },
      { cls: '', text: ' ' },
      { cls: 'num', text: '1' },
      { cls: '', text: ';' },
    ];
    const out = coalesceTokens(input);
    // Expected: [plain(const ), kw(x), plain( = ), num(1), plain(;)]
    expect(out).toEqual([
      { cls: '', text: 'const ' },
      { cls: 'kw', text: 'x' },
      { cls: '', text: ' = ' },
      { cls: 'num', text: '1' },
      { cls: '', text: ';' },
    ]);
  });
});
