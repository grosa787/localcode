/**
 * TOOL-RENDERERS-SECTION — tests for the `file:line` parser.
 *
 * The regex is the gatekeeper: every false positive becomes a stale
 * link the user clicks and lands nowhere. We exercise:
 *   - accepted shapes (file.ts:N, file.tsx:N:M, well-known names),
 *   - rejected shapes (URLs, host:port, time-like strings),
 *   - ordering / non-overlap.
 */

import { describe, test, expect } from 'bun:test';
import {
  parseFileRefs,
  splitTextByRefs,
} from '@/ui/tool-renderers/file-ref-parser';

describe('parseFileRefs — accept patterns', () => {
  test('accepts file.ext:line', () => {
    const refs = parseFileRefs('see src/foo.ts:42 for details');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe('src/foo.ts');
    expect(refs[0]?.line).toBe(42);
    expect(refs[0]?.column).toBeUndefined();
  });

  test('accepts file.ext:line:col', () => {
    const refs = parseFileRefs('hit at tests/a.test.tsx:120:5');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe('tests/a.test.tsx');
    expect(refs[0]?.line).toBe(120);
    expect(refs[0]?.column).toBe(5);
  });

  test('accepts relative dot-paths', () => {
    const refs = parseFileRefs('./tests/bar.go:99');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe('./tests/bar.go');
    expect(refs[0]?.line).toBe(99);
  });

  test('accepts well-known names', () => {
    const refs = parseFileRefs('Dockerfile:8 has the issue');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe('Dockerfile');
    expect(refs[0]?.line).toBe(8);
  });

  test('accepts multiple refs in one string', () => {
    const refs = parseFileRefs('src/a.ts:1 and src/b.ts:2');
    expect(refs).toHaveLength(2);
    expect(refs[0]?.path).toBe('src/a.ts');
    expect(refs[1]?.path).toBe('src/b.ts');
  });
});

describe('parseFileRefs — reject patterns', () => {
  test('rejects URLs', () => {
    const refs = parseFileRefs('try http://example.com:80/foo');
    // Neither `example.com:80` nor anything in the URL has a recognised
    // file extension so the regex MUST decline.
    expect(refs).toHaveLength(0);
  });

  test('rejects host:port', () => {
    const refs = parseFileRefs('serve on localhost:5173');
    expect(refs).toHaveLength(0);
  });

  test('rejects bare time-like strings', () => {
    const refs = parseFileRefs('the meeting is at 14:30:00');
    expect(refs).toHaveLength(0);
  });

  test('rejects bare numbers next to colon', () => {
    const refs = parseFileRefs('ratio is 3:1 to 5:2');
    expect(refs).toHaveLength(0);
  });

  test('rejects unsupported extensions', () => {
    const refs = parseFileRefs('see foo.zzz:5 here');
    expect(refs).toHaveLength(0);
  });
});

describe('parseFileRefs — ordering and bounds', () => {
  test('refs are sorted by source start index', () => {
    const refs = parseFileRefs('b: src/b.ts:1; a: src/a.ts:2');
    expect(refs[0]?.path).toBe('src/b.ts');
    expect(refs[1]?.path).toBe('src/a.ts');
  });

  test('start/end span the raw match', () => {
    const text = 'see src/x.ts:10:3 now';
    const refs = parseFileRefs(text);
    expect(refs).toHaveLength(1);
    const r = refs[0];
    if (r !== undefined) {
      expect(text.slice(r.start, r.end)).toBe(r.raw);
      expect(r.raw).toBe('src/x.ts:10:3');
    }
  });
});

describe('splitTextByRefs', () => {
  test('returns single text piece when no refs found', () => {
    const pieces = splitTextByRefs('plain prose with no refs');
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.kind).toBe('text');
  });

  test('alternates text and ref pieces', () => {
    const pieces = splitTextByRefs('see src/foo.ts:1 and src/bar.ts:2 here');
    const kinds = pieces.map((p) => p.kind);
    expect(kinds).toContain('text');
    expect(kinds).toContain('ref');
    // Order: text, ref, text, ref, text
    expect(kinds[0]).toBe('text');
    expect(kinds[1]).toBe('ref');
    expect(kinds[2]).toBe('text');
    expect(kinds[3]).toBe('ref');
  });
});
