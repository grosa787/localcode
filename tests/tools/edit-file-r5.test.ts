/**
 * R5 — `commitEdit` output format with line-count delta.
 *
 * Agent 3 R5 changed `commitEdit` to surface the resulting line-count
 * shape so the user can quickly grok how the edit reshaped the file:
 *
 *   - Same line count        → "Edited <path>: N lines (in-place edit)"
 *   - Growth (delta > 0)     → "Edited <path>: oldN → newN lines (+delta)"
 *   - Shrink (delta < 0)     → "Edited <path>: oldN → newN lines (-delta)"
 *
 * The arrow uses Unicode `→` (U+2192). The signed delta uses `+`/`-`
 * inline so the message reads naturally in chat output.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitEdit } from '@/tools/edit-file';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-editfile-r5-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('commitEdit — same line count → "in-place edit" (R5)', () => {
  test('replacing a single word inside a line keeps line count → in-place edit', async () => {
    const rel = 'src.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'foo bar baz\n', 'utf8');
    const result = await commitEdit(
      { path: rel, find_text: 'bar', replace_text: 'qux' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    // Old: 'foo bar baz\n' → split('\n') === ['foo bar baz', ''] → 2 lines
    // New: 'foo qux baz\n' → split('\n') === ['foo qux baz', ''] → 2 lines
    expect(result.output).toBe(`Edited ${rel}: 2 lines (in-place edit)`);
  });

  test('multi-line file, replacement with same line count → in-place', async () => {
    const rel = 'multi.txt';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'line1\nline2\nline3',
      'utf8',
    );
    const result = await commitEdit(
      { path: rel, find_text: 'line2', replace_text: 'altered' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    // Old line count = 3 (split('\n') of 'line1\nline2\nline3').
    expect(result.output).toBe(`Edited ${rel}: 3 lines (in-place edit)`);
  });

  test('replacement of one line by an empty string keeps line count when content already had a newline', async () => {
    // We rewrite "x" → "" inside a single-line file. Both sides
    // produce a 1-line file (after split).
    const rel = 'in-place-empty.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'x', 'utf8');
    const result = await commitEdit(
      { path: rel, find_text: 'x', replace_text: '' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    // 'x'.split('\n') === ['x'] → 1; ''.split('\n') === [''] → 1
    expect(result.output).toBe(`Edited ${rel}: 1 lines (in-place edit)`);
  });
});

describe('commitEdit — growth (delta > 0) → "oldN → newN lines (+delta)" (R5)', () => {
  test('replacement that adds one new line', async () => {
    const rel = 'grow.txt';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'line1\nline2\nline3\n',
      'utf8',
    );
    const result = await commitEdit(
      {
        path: rel,
        find_text: 'line2',
        replace_text: 'line-two\nline-2b',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    // Old line count = 4 (trailing \n adds an empty slot).
    // New line count = 5 (one extra \n added by replace_text).
    expect(result.output).toBe(`Edited ${rel}: 4 → 5 lines (+1)`);
  });

  test('replacement that adds multiple new lines', async () => {
    const rel = 'grow-more.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'placeholder', 'utf8');
    const result = await commitEdit(
      {
        path: rel,
        find_text: 'placeholder',
        replace_text: 'a\nb\nc\nd',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    // Old: 1 line. New: 4 lines. Delta: +3.
    expect(result.output).toBe(`Edited ${rel}: 1 → 4 lines (+3)`);
  });

  test('output uses Unicode arrow → (U+2192)', async () => {
    const rel = 'arrow.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'p', 'utf8');
    const result = await commitEdit(
      { path: rel, find_text: 'p', replace_text: 'p\nq' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain(' → ');
    // Make sure the literal three-char ASCII arrow `->` is NOT used.
    expect(result.output).not.toContain(' -> ');
  });
});

describe('commitEdit — shrink (delta < 0) → "oldN → newN lines (-delta)" (R5)', () => {
  test('replacement that removes one line', async () => {
    const rel = 'shrink.txt';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'a\nb\nc\nd',
      'utf8',
    );
    const result = await commitEdit(
      { path: rel, find_text: 'b\nc', replace_text: 'merged' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    // Old: 4 lines. New: 3 lines (a, merged, d). Delta: -1.
    expect(result.output).toBe(`Edited ${rel}: 4 → 3 lines (-1)`);
  });

  test('replacement that removes multiple lines', async () => {
    const rel = 'shrink-more.txt';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'one\ntwo\nthree\nfour\nfive',
      'utf8',
    );
    const result = await commitEdit(
      {
        path: rel,
        find_text: 'two\nthree\nfour',
        replace_text: 'X',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    // Old: 5 lines. New: 3 lines (one, X, five). Delta: -2.
    expect(result.output).toBe(`Edited ${rel}: 5 → 3 lines (-2)`);
  });

  test('replacement that removes all but one line', async () => {
    const rel = 'collapse.txt';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'header\nbody1\nbody2\nbody3',
      'utf8',
    );
    const result = await commitEdit(
      {
        path: rel,
        find_text: 'header\nbody1\nbody2\nbody3',
        replace_text: 'compact',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe(`Edited ${rel}: 4 → 1 lines (-3)`);
  });
});

describe('commitEdit — output references the relative path (R5)', () => {
  test('relative path appears in the output', async () => {
    const rel = 'sub/dir/file.txt';
    await mkdir(path.join(tmpRoot, 'sub/dir'), { recursive: true });
    await fsWriteFile(path.join(tmpRoot, rel), 'foo', 'utf8');
    const result = await commitEdit(
      { path: rel, find_text: 'foo', replace_text: 'bar' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain(rel);
    // Absolute project root must NOT leak into the user-facing message.
    expect(result.output).not.toContain(tmpRoot);
  });
});
