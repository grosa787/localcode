/**
 * Tests for the shared GFM table detector. Covers parsing rules and
 * confirms the parser is well-behaved when fed paragraphs, mixed-shape
 * tables, escaped pipes, and empty cells.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseSeparator,
  parseTables,
  splitRow,
} from '@/ui/markdown/table-detector';

describe('splitRow', () => {
  test('splits a basic row, ignoring leading/trailing pipes', () => {
    expect(splitRow('| a | b | c |')).toEqual(['a', 'b', 'c']);
  });
  test('handles missing leading/trailing pipes', () => {
    expect(splitRow('a | b | c')).toEqual(['a', 'b', 'c']);
  });
  test('honours escaped pipes inside cells', () => {
    expect(splitRow('| a \\| 1 | b |')).toEqual(['a | 1', 'b']);
  });
  test('preserves empty cells', () => {
    expect(splitRow('|   |  x |    |')).toEqual(['', 'x', '']);
  });
});

describe('parseSeparator', () => {
  test('returns left/center/right for valid separator', () => {
    expect(parseSeparator('| --- | :---: | ---: |')).toEqual([
      'left',
      'center',
      'right',
    ]);
  });
  test('left-aligned by default', () => {
    expect(parseSeparator('| --- | --- |')).toEqual(['left', 'left']);
  });
  test('returns null for non-separator lines', () => {
    expect(parseSeparator('| a | b |')).toBeNull();
    expect(parseSeparator('plain text')).toBeNull();
  });
});

describe('parseTables', () => {
  test('detects a simple 2x2 table', () => {
    const src = `| H1 | H2 |
| --- | --- |
| a | b |
| c | d |`;
    const { blocks } = parseTables(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('table');
    if (blocks[0]?.kind !== 'table') throw new Error('expected table');
    expect(blocks[0].table.headers).toEqual(['H1', 'H2']);
    expect(blocks[0].table.rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('handles mixed alignment', () => {
    const src = `| L | C | R |
| :--- | :---: | ---: |
| 1 | 2 | 3 |`;
    const { blocks } = parseTables(src);
    if (blocks[0]?.kind !== 'table') throw new Error('expected table');
    expect(blocks[0].table.alignments).toEqual(['left', 'center', 'right']);
  });

  test('cells preserve inline markdown for downstream rendering', () => {
    const src = `| A | B |
| --- | --- |
| **bold** | \`code\` |
| *italic* | [link](https://x) |`;
    const { blocks } = parseTables(src);
    if (blocks[0]?.kind !== 'table') throw new Error('expected table');
    expect(blocks[0].table.rows[0]).toEqual(['**bold**', '`code`']);
    expect(blocks[0].table.rows[1]).toEqual(['*italic*', '[link](https://x)']);
  });

  test('table sandwiched between paragraphs', () => {
    const src = `before paragraph

| H | I |
| --- | --- |
| a | b |

after paragraph`;
    const { blocks } = parseTables(src);
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'table', 'text']);
    if (blocks[0]?.kind === 'text') {
      expect(blocks[0].content).toContain('before paragraph');
    }
    if (blocks[2]?.kind === 'text') {
      expect(blocks[2].content).toContain('after paragraph');
    }
  });

  test('optional leading/trailing pipes', () => {
    const src = `H1 | H2
--- | ---
a | b`;
    const { blocks } = parseTables(src);
    if (blocks[0]?.kind !== 'table') throw new Error('expected table');
    expect(blocks[0].table.headers).toEqual(['H1', 'H2']);
    expect(blocks[0].table.rows).toEqual([['a', 'b']]);
  });

  test('escaped pipes inside cells', () => {
    const src = `| key | val |
| --- | --- |
| pipe \\| char | x |`;
    const { blocks } = parseTables(src);
    if (blocks[0]?.kind !== 'table') throw new Error('expected table');
    expect(blocks[0].table.rows[0]).toEqual(['pipe | char', 'x']);
  });

  test('empty cells survive parsing', () => {
    const src = `| a | b |
| --- | --- |
|   |   |
| x |   |`;
    const { blocks } = parseTables(src);
    if (blocks[0]?.kind !== 'table') throw new Error('expected table');
    expect(blocks[0].table.rows).toEqual([
      ['', ''],
      ['x', ''],
    ]);
  });

  test('header-only table (no body) still parses', () => {
    const src = `| H1 | H2 |
| --- | --- |`;
    const { blocks } = parseTables(src);
    if (blocks[0]?.kind !== 'table') throw new Error('expected table');
    expect(blocks[0].table.headers).toEqual(['H1', 'H2']);
    expect(blocks[0].table.rows).toEqual([]);
  });

  test('non-table content with pipes is left as text', () => {
    const src = `pipe | in | text without a separator on the next line`;
    const { blocks } = parseTables(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('text');
  });

  test('rows with mismatched cell counts are normalised to header width', () => {
    const src = `| a | b | c |
| --- | --- | --- |
| 1 | 2 |
| 1 | 2 | 3 | 4 |`;
    const { blocks } = parseTables(src);
    if (blocks[0]?.kind !== 'table') throw new Error('expected table');
    expect(blocks[0].table.rows).toEqual([
      ['1', '2', ''],
      ['1', '2', '3'],
    ]);
  });
});
