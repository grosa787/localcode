/**
 * Snippet selection mode — behaviour test for the underlying ring +
 * `expandClipReferences` pre-submit hook. Mirrors the rest of this
 * folder's pattern of testing the pure functions ChatScreen wires up,
 * rather than driving the full screen with fake ink stdin.
 *
 * Wire-up regression for the call-site (Ctrl+S, Y, @clip-N expansion in
 * `ChatScreen.submit`) lives in `chatscreen-wave6b-wireup.test.ts`.
 */

import { describe, test, expect } from 'bun:test';
import { SnippetRing, expandClipReferences } from '@/ui/snippet-ring';

describe('SnippetRing', () => {
  test('push assigns monotonically-increasing clip ids', () => {
    const ring = new SnippetRing();
    const a = ring.push('first');
    const b = ring.push('second');
    expect(a.clipId).toBe('clip-1');
    expect(b.clipId).toBe('clip-2');
  });

  test('FIFO eviction keeps the most recent 10', () => {
    const ring = new SnippetRing();
    for (let i = 0; i < 12; i++) ring.push(`s${i}`);
    expect(ring.size).toBe(10);
    // clip-1 / clip-2 are evicted; clip-3..clip-12 survive.
    expect(ring.get('clip-1')).toBeNull();
    expect(ring.get('clip-2')).toBeNull();
    expect(ring.get('clip-3')).toBe('s2');
    expect(ring.get('clip-12')).toBe('s11');
  });

  test('sequence numbers never recycle after eviction', () => {
    const ring = new SnippetRing();
    ring.push('a');
    ring.push('b');
    ring.clear();
    const c = ring.push('c');
    // After clear() the next push uses the next sequence, not clip-1.
    expect(c.clipId).toBe('clip-3');
  });
});

describe('expandClipReferences (composer pre-submit)', () => {
  test('rewrites @clip-N to the captured snippet content', () => {
    const ring = new SnippetRing();
    const { clipId } = ring.push('cat /etc/hosts');
    const out = expandClipReferences(
      `Run this please: @${clipId} and tell me what you see.`,
      ring,
    );
    expect(out.text).toBe(
      'Run this please: cat /etc/hosts and tell me what you see.',
    );
    expect(out.resolved).toEqual([clipId]);
  });

  test('leaves unknown clip-N references untouched', () => {
    const ring = new SnippetRing();
    const out = expandClipReferences('hello @clip-999 there', ring);
    expect(out.text).toBe('hello @clip-999 there');
    expect(out.resolved).toEqual([]);
  });

  test('multiple references resolve in order', () => {
    const ring = new SnippetRing();
    ring.push('alpha');
    ring.push('beta');
    const out = expandClipReferences('@clip-1 + @clip-2', ring);
    expect(out.text).toBe('alpha + beta');
    expect(out.resolved).toEqual(['clip-1', 'clip-2']);
  });
});
