/**
 * Incremental markdown coalescing (R-perf, 2026-05).
 *
 * Pure-function checks. The block-parser shape is abstract — we feed
 * a simple `(text) => [{ kind: 'p', text }]` parser so the test is
 * agnostic to the real markdown AST.
 */

import { describe, test, expect } from 'bun:test';
import {
  findLastParagraphBoundary,
  splitStableTail,
  createIncrementalMarkdownCache,
} from '@/ui/markdown/incremental-markdown';

interface Block {
  readonly kind: 'p';
  readonly text: string;
}

const dummyParse = (s: string): readonly Block[] => [{ kind: 'p', text: s }];

describe('findLastParagraphBoundary', () => {
  test('returns -1 for empty string', () => {
    expect(findLastParagraphBoundary('')).toBe(-1);
  });

  test('returns -1 when no \\n\\n present', () => {
    expect(findLastParagraphBoundary('one line\nsecond line\nthird')).toBe(-1);
  });

  test('returns position after the boundary', () => {
    const s = 'first\n\nsecond';
    expect(findLastParagraphBoundary(s)).toBe('first\n\n'.length);
  });

  test('returns the LAST boundary when several exist', () => {
    const s = 'a\n\nb\n\nc';
    expect(findLastParagraphBoundary(s)).toBe('a\n\nb\n\n'.length);
  });

  test('boundary at the very end is detected', () => {
    const s = 'foo\n\n';
    expect(findLastParagraphBoundary(s)).toBe(s.length);
  });
});

describe('splitStableTail round-trip', () => {
  test('stable + tail reconstructs the input', () => {
    const inputs = [
      '',
      'no boundary here',
      'first\n\nsecond',
      'a\n\nb\n\nc',
      'foo\n\n',
    ];
    for (const s of inputs) {
      const { stable, tail } = splitStableTail(s);
      expect(stable + tail).toBe(s);
    }
  });

  test('stable always ends with \\n\\n when non-empty', () => {
    const { stable } = splitStableTail('a\n\nb');
    expect(stable.endsWith('\n\n')).toBe(true);
  });
});

describe('createIncrementalMarkdownCache', () => {
  test('first parse misses, second on same prefix hits', () => {
    const cache = createIncrementalMarkdownCache<Block>();
    cache.parseIncremental('para 1\n\ntail', dummyParse);
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
    // Same prefix, different tail — prefix-cache hits.
    cache.parseIncremental('para 1\n\ntail with more', dummyParse);
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(1);
  });

  test('extending past another \\n\\n boundary triggers one new parse', () => {
    const cache = createIncrementalMarkdownCache<Block>();
    cache.parseIncremental('p1\n\np2 tail', dummyParse); // miss: prefix "p1\n\n"
    cache.parseIncremental('p1\n\np2\n\np3 tail', dummyParse); // miss: prefix "p1\n\np2\n\n"
    cache.parseIncremental('p1\n\np2\n\np3 tail more', dummyParse); // hit: same prefix
    const s = cache.stats();
    expect(s.misses).toBe(2);
    expect(s.hits).toBe(1);
  });

  test('buffer with no paragraph break has empty prefixBlocks', () => {
    const cache = createIncrementalMarkdownCache<Block>();
    const r = cache.parseIncremental('all one paragraph', dummyParse);
    expect(r.prefixBlocks.length).toBe(0);
    expect(r.tailBlocks.length).toBe(1);
    expect(r.tailBlocks[0]?.text).toBe('all one paragraph');
  });

  test('reference equality of prefixBlocks across hits', () => {
    const cache = createIncrementalMarkdownCache<Block>();
    const r1 = cache.parseIncremental('p1\n\nt', dummyParse);
    const r2 = cache.parseIncremental('p1\n\nt with more', dummyParse);
    // The reused array must be the SAME identity so React.memo can
    // short-circuit downstream renders.
    expect(r2.prefixBlocks).toBe(r1.prefixBlocks);
  });

  test('clear resets stats and cache size', () => {
    const cache = createIncrementalMarkdownCache<Block>();
    cache.parseIncremental('p\n\nt', dummyParse);
    cache.clear();
    const s = cache.stats();
    expect(s.misses).toBe(0);
    expect(s.hits).toBe(0);
    expect(s.size).toBe(0);
  });

  test('FIFO eviction respects maxEntries', () => {
    const cache = createIncrementalMarkdownCache<Block>({ maxEntries: 2 });
    cache.parseIncremental('a\n\n.', dummyParse); // entry 1
    cache.parseIncremental('a\n\nb\n\n.', dummyParse); // entry 2
    cache.parseIncremental('a\n\nb\n\nc\n\n.', dummyParse); // entry 3, evicts 1
    expect(cache.stats().size).toBe(2);
    // First prefix back → miss again because evicted.
    cache.parseIncremental('a\n\nmore', dummyParse);
    expect(cache.stats().misses).toBe(4);
  });
});
