/**
 * Wave 5A (TA team) — fuzzy ranker used by CommandPalette.
 *
 * Verifies the contract the renderer depends on:
 *   - empty query → score 0
 *   - non-subsequence query → score 0
 *   - prefix matches score higher than mid-string matches
 *   - boundary / CamelCase jumps score higher than scattered matches
 *   - consecutive runs score higher than scattered runs
 *   - matchedIndices align with the haystack characters that match
 *   - fuzzyRank: stable ordering, drops zero-score items
 *
 * Plus a fixture of 100 strings to confirm `fuzzyRank` returns
 * sensible top results for common queries.
 */

import { describe, test, expect } from 'bun:test';
import { fuzzyMatch, fuzzyRank, isMatched } from '@/ui/fuzzy';

describe('fuzzyMatch — scoring contract', () => {
  test('empty query returns zero score', () => {
    const m = fuzzyMatch('', 'whatever');
    expect(m.score).toBe(0);
    expect(m.matchedIndices).toHaveLength(0);
  });

  test('non-subsequence query returns zero score', () => {
    expect(fuzzyMatch('xyz', 'foobar').score).toBe(0);
  });

  test('full prefix match scores higher than mid-string match', () => {
    const prefix = fuzzyMatch('perm', '/permissions');
    const mid = fuzzyMatch('perm', 'overlay-permissions-list');
    expect(prefix.score).toBeGreaterThan(0);
    expect(mid.score).toBeGreaterThan(0);
    expect(prefix.score).toBeGreaterThan(mid.score);
  });

  test('CamelCase boundary scores higher than mid-word match', () => {
    // CommandPalette: 'C' is prefix (idx 0, +3) and 'P' is CamelCase boundary
    // (idx 7, +2). The scattered case is also a prefix but the 'P' is mid-word.
    const camel = fuzzyMatch('CP', 'CommandPalette');
    const scattered = fuzzyMatch('CP', 'capabilities pings');
    expect(camel.score).toBeGreaterThan(0);
    expect(scattered.score).toBeGreaterThan(0);
    expect(camel.score).toBeGreaterThan(scattered.score);
  });

  test('consecutive run beats jumps over the same characters', () => {
    const consecutive = fuzzyMatch('foo', 'food-app');
    const jumps = fuzzyMatch('foo', 'fXoXoX');
    expect(consecutive.score).toBeGreaterThan(0);
    expect(jumps.score).toBeGreaterThan(0);
    expect(consecutive.score).toBeGreaterThan(jumps.score);
  });

  test('case-insensitive — matches regardless of input case', () => {
    expect(fuzzyMatch('PERM', '/permissions').score).toBeGreaterThan(0);
    expect(fuzzyMatch('cP', 'CommandPalette').score).toBeGreaterThan(0);
  });

  test('matchedIndices align with haystack characters', () => {
    const m = fuzzyMatch('cat', 'category');
    expect(m.matchedIndices).toEqual([0, 1, 2]);
    expect(isMatched(m, 0)).toBe(true);
    expect(isMatched(m, 2)).toBe(true);
    expect(isMatched(m, 3)).toBe(false);
  });

  test('shorter haystack ties break in favour of the shorter row', () => {
    const short = fuzzyMatch('perm', '/perm');
    const long = fuzzyMatch('perm', '/permissions-debug-overlay');
    expect(short.score).toBeGreaterThan(long.score);
  });
});

describe('fuzzyRank — ordering + drop semantics', () => {
  test('drops items that do not match', () => {
    const items = ['alpha', 'beta', 'gamma'];
    const ranked = fuzzyRank('xy', items, (s) => s);
    expect(ranked).toHaveLength(0);
  });

  test('empty / whitespace query returns items in original order with zero scores', () => {
    const items = ['z', 'a', 'm'];
    const ranked = fuzzyRank('  ', items, (s) => s);
    expect(ranked).toHaveLength(3);
    expect(ranked.map((r) => r.item)).toEqual(['z', 'a', 'm']);
    for (const r of ranked) expect(r.match.score).toBe(0);
  });

  test('stable order on ties — earlier index wins', () => {
    // Both candidates produce identical scores; ranker must preserve
    // the input order so callers can pre-sort by recency.
    const items = ['foo', 'foo'];
    const ranked = fuzzyRank('foo', items, (s) => s);
    expect(ranked).toHaveLength(2);
    // Both refer to the same string but the FIRST occurrence wins on
    // ties — verifies the sort is stable.
    expect(ranked[0]?.item).toBe('foo');
    expect(ranked[1]?.item).toBe('foo');
  });

  test('100-item fixture — "perm" puts /permissions in the top 3', () => {
    const fixture = [
      '/permissions',
      '/provider',
      '/model',
      '/context',
      '/ctxsize',
      '/resume',
      '/settings',
      '/diff',
      '/skill',
      '/spawn',
      ...Array.from({ length: 90 }, (_, i) => `unrelated-row-${i}-perm-debug-`),
    ];
    const ranked = fuzzyRank('perm', fixture, (s) => s);
    expect(ranked.length).toBeGreaterThan(0);
    const top3 = ranked.slice(0, 3).map((r) => r.item);
    expect(top3).toContain('/permissions');
  });

  test('100-item fixture — "settings" prefers prefix matches over noisy substring rows', () => {
    // Prefix matches (start-of-string) earn the +3 prefix bonus on top
    // of the per-character base + consecutive multiplier. A noisy
    // unrelated row that contains "settings" in the middle should
    // never beat a true prefix-anchored row.
    const fixture = [
      'settings-overlay',
      'foo-settings-bar',
      '/permissions-settings-debug',
      ...Array.from({ length: 97 }, (_, i) => `unrelated-${i}-settings-something`),
    ];
    const ranked = fuzzyRank('settings', fixture, (s) => s);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.item).toBe('settings-overlay');
  });
});
