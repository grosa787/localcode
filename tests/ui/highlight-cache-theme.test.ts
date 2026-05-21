/**
 * Theme-aware highlight cache (R-perf, 2026-05).
 *
 * Verifies that:
 *   - the cache survives a theme switch (entries are NOT cleared), and
 *   - the FIRST highlight call under a new theme version misses (we
 *     must rebuild colours for the new palette), and
 *   - SUBSEQUENT calls with the same code+lang under the same theme
 *     version hit, and
 *   - bumping the theme version moves the cache key forward so old
 *     entries become unreachable until the version cycles back (which
 *     production never does — counter is monotonically increasing).
 *
 * No wall-clock assertions; everything here is deterministic on the
 * pure cache state.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  highlightCode,
  bumpThemeVersion,
  __TEST_CLEAR_CACHE,
  __TEST_CACHE_STATS,
} from '@/ui/highlighting/syntax-highlight';

const SAMPLE = 'const answer: number = 42;';
const SAMPLE_LANG = 'typescript';

describe('highlight cache — theme-aware key', () => {
  beforeEach(() => {
    __TEST_CLEAR_CACHE();
  });

  test('clean slate after __TEST_CLEAR_CACHE', () => {
    const s = __TEST_CACHE_STATS();
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
    expect(s.themeVersion).toBe(0);
    expect(s.size).toBe(0);
  });

  test('first render under theme A misses, second hits', () => {
    highlightCode(SAMPLE, SAMPLE_LANG); // miss
    const after1 = __TEST_CACHE_STATS();
    expect(after1.misses).toBe(1);
    expect(after1.hits).toBe(0);
    expect(after1.size).toBe(1);

    highlightCode(SAMPLE, SAMPLE_LANG); // hit
    const after2 = __TEST_CACHE_STATS();
    expect(after2.misses).toBe(1);
    expect(after2.hits).toBe(1);
    expect(after2.size).toBe(1);
  });

  test('theme bump invalidates: first call under new theme misses, then hits', () => {
    highlightCode(SAMPLE, SAMPLE_LANG); // miss under theme 0
    highlightCode(SAMPLE, SAMPLE_LANG); // hit under theme 0
    const before = __TEST_CACHE_STATS();
    expect(before.hits).toBe(1);
    expect(before.misses).toBe(1);
    expect(before.themeVersion).toBe(0);
    expect(before.size).toBe(1);

    bumpThemeVersion();

    highlightCode(SAMPLE, SAMPLE_LANG); // miss under theme 1 (new key)
    const afterMiss = __TEST_CACHE_STATS();
    expect(afterMiss.misses).toBe(2);
    expect(afterMiss.hits).toBe(1);
    expect(afterMiss.themeVersion).toBe(1);
    // Both the theme-0 and theme-1 entries are present; the old entry
    // is NOT evicted by the bump itself (LRU ages it out later).
    expect(afterMiss.size).toBe(2);

    highlightCode(SAMPLE, SAMPLE_LANG); // hit under theme 1
    highlightCode(SAMPLE, SAMPLE_LANG); // hit under theme 1
    const afterHits = __TEST_CACHE_STATS();
    expect(afterHits.misses).toBe(2);
    expect(afterHits.hits).toBe(3);
    expect(afterHits.size).toBe(2);
  });

  test('bumping multiple times in a row each shifts the cache key', () => {
    highlightCode(SAMPLE, SAMPLE_LANG); // miss, theme 0
    bumpThemeVersion();
    highlightCode(SAMPLE, SAMPLE_LANG); // miss, theme 1
    bumpThemeVersion();
    highlightCode(SAMPLE, SAMPLE_LANG); // miss, theme 2
    bumpThemeVersion();
    highlightCode(SAMPLE, SAMPLE_LANG); // miss, theme 3
    const s = __TEST_CACHE_STATS();
    expect(s.misses).toBe(4);
    expect(s.hits).toBe(0);
    expect(s.themeVersion).toBe(3);
    expect(s.size).toBe(4);
  });

  test('rendering different code under same theme produces independent misses', () => {
    highlightCode('let a = 1;', SAMPLE_LANG); // miss
    highlightCode('let b = 2;', SAMPLE_LANG); // miss (different code)
    highlightCode('let a = 1;', SAMPLE_LANG); // hit (same code)
    const s = __TEST_CACHE_STATS();
    expect(s.misses).toBe(2);
    expect(s.hits).toBe(1);
    expect(s.size).toBe(2);
  });

  test('theme bump preserves output correctness across calls', () => {
    const a = highlightCode(SAMPLE, SAMPLE_LANG);
    bumpThemeVersion();
    const b = highlightCode(SAMPLE, SAMPLE_LANG);
    // Both must be non-empty strings (ANSI-coloured). They MAY be
    // identical byte-for-byte because the underlying syntaxTheme map
    // is the same — the point of the version is that the CACHE KEY
    // changes so any future palette swap is honoured. Here we only
    // assert that the post-bump call returns valid output.
    expect(a.length).toBeGreaterThan(SAMPLE.length);
    expect(b.length).toBeGreaterThan(SAMPLE.length);
  });
});
