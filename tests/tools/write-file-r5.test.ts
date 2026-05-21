/**
 * R5 — `commitWrite` output format.
 *
 * Agent 3 R5 changed the success message of `commitWrite` to include
 * the line count alongside the byte count:
 *
 *   - 0 lines (empty file)  → "Wrote 0 lines (empty file) to <path>"
 *   - 1 line                → "Wrote 1 line (<bytes> bytes) to <path>"
 *   - N lines (N > 1)       → "Wrote N lines (<bytes> bytes) to <path>"
 *
 * The byte count is the UTF-8 length of the content. Line count uses
 * the same `split('\n').length` convention as the rest of the editor
 * tooling.
 *
 * These tests provision a real temp directory and assert the
 * formatted output strings.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { commitWrite } from '@/tools/write-file';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-writefile-r5-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('commitWrite — output format with line count (R5)', () => {
  test('single-line content → "Wrote 1 line (X bytes) to <path>"', async () => {
    const content = 'hello world';
    const rel = 'one-line.txt';
    const result = await commitWrite(
      { path: rel, content },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    const bytes = Buffer.byteLength(content, 'utf8');
    expect(result.output).toBe(`Wrote 1 line (${bytes} bytes) to ${rel}`);
  });

  test('multi-line content → "Wrote N lines (X bytes) to <path>"', async () => {
    const content = 'one\ntwo\nthree';
    const rel = 'multi.txt';
    const result = await commitWrite(
      { path: rel, content },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    const bytes = Buffer.byteLength(content, 'utf8');
    // 'one\ntwo\nthree'.split('\n').length === 3
    expect(result.output).toBe(`Wrote 3 lines (${bytes} bytes) to ${rel}`);
  });

  test('two-line content → plural ("2 lines")', async () => {
    const content = 'first\nsecond';
    const rel = 'two-line.txt';
    const result = await commitWrite(
      { path: rel, content },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    const bytes = Buffer.byteLength(content, 'utf8');
    expect(result.output).toBe(`Wrote 2 lines (${bytes} bytes) to ${rel}`);
  });

  test('content with trailing newline → counted line is the empty trailing slot', async () => {
    // 'a\nb\n'.split('\n') === ['a', 'b', ''] → length 3
    const content = 'a\nb\n';
    const rel = 'trailing.txt';
    const result = await commitWrite(
      { path: rel, content },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    const bytes = Buffer.byteLength(content, 'utf8');
    expect(result.output).toBe(`Wrote 3 lines (${bytes} bytes) to ${rel}`);
  });

  test('empty content → "Wrote 0 lines (empty file) to <path>"', async () => {
    const rel = 'empty.txt';
    const result = await commitWrite(
      { path: rel, content: '' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe(`Wrote 0 lines (empty file) to ${rel}`);
  });

  test('output mentions the byte count (UTF-8) for non-ASCII content', async () => {
    const content = 'привет, мир!'; // ru: 12 chars, mostly 2-byte
    const rel = 'unicode.txt';
    const result = await commitWrite(
      { path: rel, content },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    const bytes = Buffer.byteLength(content, 'utf8');
    expect(result.output).toBe(`Wrote 1 line (${bytes} bytes) to ${rel}`);
    // Sanity: non-ASCII actually uses more bytes than chars.
    expect(bytes).toBeGreaterThan(content.length);
  });

  test('output uses singular "line" only for exactly 1 line', async () => {
    const r1 = await commitWrite(
      { path: 'a.txt', content: 'x' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    const r2 = await commitWrite(
      { path: 'b.txt', content: 'x\ny' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(r1.output).toMatch(/Wrote 1 line \(/);
    // Must use the plural "lines" for 2.
    expect(r2.output).toMatch(/Wrote 2 lines \(/);
    // Sanity — assert we don't accidentally use plural for 1.
    expect(r1.output).not.toMatch(/1 lines/);
  });

  test('output references the relative path verbatim (not the absolute path)', async () => {
    const rel = 'nested/dir/file.txt';
    const result = await commitWrite(
      { path: rel, content: 'data' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain(rel);
    // Absolute project root must NOT appear in the output (the message
    // is meant to be read by the user with relative paths).
    expect(result.output).not.toContain(tmpRoot);
  });
});

describe('commitWrite — output format edge cases (R5)', () => {
  test('content of just a newline → split length 2 → "Wrote 2 lines"', async () => {
    // '\n'.split('\n') === ['', ''] → length 2
    const content = '\n';
    const rel = 'just-newline.txt';
    const result = await commitWrite(
      { path: rel, content },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    const bytes = Buffer.byteLength(content, 'utf8');
    expect(result.output).toBe(`Wrote 2 lines (${bytes} bytes) to ${rel}`);
  });

  test('byte count matches Buffer.byteLength of the content', async () => {
    const content = 'abc\n123\n';
    const rel = 'count.txt';
    const result = await commitWrite(
      { path: rel, content },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    const bytes = Buffer.byteLength(content, 'utf8');
    expect(result.output).toContain(`(${bytes} bytes)`);
  });
});
