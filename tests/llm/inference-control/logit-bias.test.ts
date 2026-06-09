/**
 * Wave 16B — logit-bias construction tests.
 *
 * Verifies: symbols → bias map; non-TS → {} (no-op + note); ban list is
 * the only large-magnitude value (never an over-broad ban); injected
 * tokenizer is used (no bundled tokenizer); tokenizer errors are skipped.
 */
import { describe, expect, test } from 'bun:test';
import {
  BAN_BIAS,
  BOOST_BIAS,
  MAX_BOOST_SYMBOLS,
  buildSymbolLogitBias,
} from '@/llm/inference-control';

/** Deterministic fake tokenizer: 1 char → 1 token id (charCode). */
function charTokenize(text: string): number[] {
  return Array.from(text).map((c) => c.charCodeAt(0));
}

describe('buildSymbolLogitBias', () => {
  test('symbols produce a boost bias map', () => {
    const { bias, note } = buildSymbolLogitBias({
      symbols: ['ab'],
      tokenize: charTokenize,
    });
    expect(note).toBeUndefined();
    // 'a' = 97, 'b' = 98.
    expect(bias[97]).toBe(BOOST_BIAS);
    expect(bias[98]).toBe(BOOST_BIAS);
  });

  test('non-TypeScript language → empty map + explanatory note', () => {
    const { bias, note } = buildSymbolLogitBias({
      symbols: ['foo', 'bar'],
      tokenize: charTokenize,
      language: 'python',
    });
    expect(bias).toEqual({});
    expect(note).toBeDefined();
    expect(note).toContain('non-TypeScript');
  });

  test('tsx is treated as TypeScript', () => {
    const { bias, note } = buildSymbolLogitBias({
      symbols: ['x'],
      tokenize: charTokenize,
      language: 'typescriptreact',
    });
    expect(note).toBeUndefined();
    expect(bias[120]).toBe(BOOST_BIAS); // 'x' = 120
  });

  test('ban list applies the large-magnitude bias only to banned names', () => {
    const { bias } = buildSymbolLogitBias({
      symbols: ['a'],
      banned: ['z'],
      mode: 'boost+ban',
      tokenize: charTokenize,
    });
    expect(bias[97]).toBe(BOOST_BIAS); // 'a'
    expect(bias[122]).toBe(BAN_BIAS); // 'z'
    expect(BAN_BIAS).toBeLessThanOrEqual(-100);
  });

  test('ban wins over boost when a token is shared', () => {
    // 'a' is both boosted and banned — the ban must win.
    const { bias } = buildSymbolLogitBias({
      symbols: ['a'],
      banned: ['a'],
      mode: 'boost+ban',
      tokenize: charTokenize,
    });
    expect(bias[97]).toBe(BAN_BIAS);
  });

  test('mode "boost" ignores the banned list', () => {
    const { bias } = buildSymbolLogitBias({
      symbols: ['a'],
      banned: ['z'],
      mode: 'boost',
      tokenize: charTokenize,
    });
    expect(bias[122]).toBeUndefined();
  });

  test('never produces an over-broad ban — only boosts when no ban list', () => {
    const { bias } = buildSymbolLogitBias({
      symbols: ['hello', 'world'],
      tokenize: charTokenize,
    });
    // Every value is the gentle boost; nothing is a ban.
    for (const v of Object.values(bias)) {
      expect(v).toBe(BOOST_BIAS);
      expect(v).toBeGreaterThan(0);
    }
  });

  test('boost set is bounded by MAX_BOOST_SYMBOLS', () => {
    // Generate more distinct single-char-ish symbols than the cap, each
    // tokenizing to a unique id so we can count distinct boosted tokens.
    const symbols = Array.from({ length: MAX_BOOST_SYMBOLS + 50 }, (_, i) =>
      String.fromCodePoint(0x4e00 + i),
    );
    const tokenize = (t: string): number[] => [t.codePointAt(0) ?? 0];
    const { bias } = buildSymbolLogitBias({ symbols, tokenize });
    expect(Object.keys(bias).length).toBeLessThanOrEqual(MAX_BOOST_SYMBOLS);
  });

  test('uses the injected tokenizer (no bundled tokenizer)', () => {
    let called = 0;
    const tokenize = (_t: string): number[] => {
      called += 1;
      return [42];
    };
    buildSymbolLogitBias({ symbols: ['one', 'two'], tokenize });
    expect(called).toBe(2);
  });

  test('a tokenizer that throws is skipped, never crashes', () => {
    const tokenize = (t: string): number[] => {
      if (t === 'bad') throw new Error('boom');
      return charTokenize(t);
    };
    const { bias } = buildSymbolLogitBias({
      symbols: ['bad', 'ok'],
      tokenize,
    });
    // 'bad' skipped; 'ok' present.
    expect(bias[111]).toBe(BOOST_BIAS); // 'o'
    expect(bias[107]).toBe(BOOST_BIAS); // 'k'
  });

  test('empty symbol list → empty map', () => {
    const { bias } = buildSymbolLogitBias({ symbols: [], tokenize: charTokenize });
    expect(bias).toEqual({});
  });
});
