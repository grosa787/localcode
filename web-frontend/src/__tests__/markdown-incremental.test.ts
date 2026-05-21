/**
 * Incremental-markdown boundary detection tests.
 *
 * Verifies the pure `findStableBoundary` and `isCacheValid` helpers
 * that drive the `Markdown` component's prefix cache.
 */

import { describe, expect, test } from 'vitest';

import {
  findStableBoundary,
  fnv1a,
  isCacheValid,
} from '../util/incremental-markdown';

describe('findStableBoundary', () => {
  test('returns 0 for empty source', () => {
    expect(findStableBoundary('')).toBe(0);
  });

  test('returns 0 for a single line with no blank line', () => {
    expect(findStableBoundary('just one paragraph')).toBe(0);
  });

  test('returns 0 when the only blank line is at EOF', () => {
    // A trailing blank line with nothing after gains us nothing — the
    // cached prefix would equal the full source.
    expect(findStableBoundary('hello\n\n')).toBe(0);
  });

  test('promotes the byte after a mid-document blank line', () => {
    const src = 'one\n\ntwo';
    const boundary = findStableBoundary(src);
    // The stable prefix should be 'one\n\n' (5 chars).
    expect(boundary).toBe(5);
    expect(src.slice(0, boundary)).toBe('one\n\n');
    expect(src.slice(boundary)).toBe('two');
  });

  test('chooses the LATEST blank-line boundary (high-water mark)', () => {
    const src = 'one\n\ntwo\n\nthree';
    const boundary = findStableBoundary(src);
    // After the second blank line — the boundary should be at the end
    // of 'one\n\ntwo\n\n' = 10 chars.
    expect(boundary).toBe(10);
    expect(src.slice(0, boundary)).toBe('one\n\ntwo\n\n');
    expect(src.slice(boundary)).toBe('three');
  });

  test('does not split inside an open code fence', () => {
    // Blank lines INSIDE a fence are content, not block boundaries.
    const src = '```ts\n\nconst x = 1;\n\n';
    expect(findStableBoundary(src)).toBe(0);
  });

  test('treats blank lines after a closed fence as stable', () => {
    const src = '```ts\nx\n```\n\nafter';
    const boundary = findStableBoundary(src);
    expect(boundary).toBeGreaterThan(0);
    expect(src.slice(boundary)).toBe('after');
  });

  test('handles CRLF line endings', () => {
    const src = 'one\r\n\r\ntwo';
    const boundary = findStableBoundary(src);
    // Normalised source 'one\n\ntwo' has boundary at 5.
    expect(boundary).toBe(5);
  });
});

describe('isCacheValid', () => {
  test('rejects null cache', () => {
    expect(isCacheValid(null, 'anything')).toBe(false);
  });

  test('rejects zero-length cache key', () => {
    expect(
      isCacheValid({ prefixLength: 0, prefixHash: 0 }, 'anything'),
    ).toBe(false);
  });

  test('accepts source that extends the cached prefix', () => {
    const prefix = 'hello\n\n';
    const key = { prefixLength: prefix.length, prefixHash: fnv1a(prefix) };
    expect(isCacheValid(key, prefix + 'world')).toBe(true);
  });

  test('rejects source shorter than the cached prefix', () => {
    const prefix = 'hello\n\n';
    const key = { prefixLength: prefix.length, prefixHash: fnv1a(prefix) };
    expect(isCacheValid(key, 'hello')).toBe(false);
  });

  test('rejects diverged source even at the same length', () => {
    const prefix = 'hello\n\n';
    const key = { prefixLength: prefix.length, prefixHash: fnv1a(prefix) };
    expect(isCacheValid(key, 'XELLO\n\n')).toBe(false);
  });
});

describe('fnv1a', () => {
  test('hashes the empty string to the FNV offset basis', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
  });

  test('produces stable hashes (same input → same output)', () => {
    expect(fnv1a('localcode')).toBe(fnv1a('localcode'));
  });

  test('hashes differ across different inputs', () => {
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
  });
});
