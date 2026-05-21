/**
 * `edit_file` tool — surgical search/replace.
 *
 * Covers:
 *   - Happy path: preview produces diff; commit actually writes.
 *   - Missing file -> clear error.
 *   - find_text appears more than once -> uniqueness error.
 *   - find_text not present -> whitespace-hint error.
 *   - Path traversal blocked.
 *   - Commit re-validates uniqueness when file changed since preview.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readFile as fsReadFile, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitEdit, editFile } from '@/tools/edit-file';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-editfile-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('editFile (preview)', () => {
  test('happy path: file with foo bar foo2 -> find bar, replace baz', async () => {
    const rel = 'src.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'foo bar foo2', 'utf8');
    const result = await editFile(
      { path: rel, find_text: 'bar', replace_text: 'baz' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.requiresApproval).toBe(true);
    // Diff should reference the file + show the change.
    expect(result.output).toContain(rel);
    expect(result.output).toContain('-foo bar foo2');
    expect(result.output).toContain('+foo baz foo2');
    // File still unchanged until commit.
    const raw = await fsReadFile(path.join(tmpRoot, rel), 'utf8');
    expect(raw).toBe('foo bar foo2');
  });

  test('missing file -> clear error (mentions use of write_file)', async () => {
    const result = await editFile(
      { path: 'absent.txt', find_text: 'a', replace_text: 'b' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('absent.txt');
    expect(result.error ?? '').toContain('write_file');
  });

  test('non-unique find_text -> uniqueness error', async () => {
    const rel = 'dup.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'x\nx\nx', 'utf8');
    const result = await editFile(
      { path: rel, find_text: 'x', replace_text: 'y' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('unique');
  });

  test('not-found find_text -> whitespace tip', async () => {
    const rel = 'nf.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'hello world', 'utf8');
    const result = await editFile(
      { path: rel, find_text: 'goodbye', replace_text: 'bye' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('not found');
    expect(result.error ?? '').toMatch(/whitespace|indent/i);
  });

  test('path traversal blocked (preview)', async () => {
    const result = await editFile(
      { path: '../evil.txt', find_text: 'x', replace_text: 'y' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/traversal/i);
    expect(result.requiresApproval).toBe(true);
  });

  test('Zod rejects empty find_text', async () => {
    const rel = 'a.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'any', 'utf8');
    const result = await editFile(
      { path: rel, find_text: '', replace_text: 'y' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('find_text');
  });
});

describe('commitEdit', () => {
  test('writes the mutated file to disk', async () => {
    const rel = 'out.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'foo bar foo2', 'utf8');
    const res = await commitEdit(
      { path: rel, find_text: 'bar', replace_text: 'baz' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain(rel);
    const raw = await fsReadFile(path.join(tmpRoot, rel), 'utf8');
    expect(raw).toBe('foo baz foo2');
  });

  test('commit re-validates uniqueness: file changed between preview and commit', async () => {
    const rel = 'changing.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'bar', 'utf8');
    // Preview succeeds (unique).
    const preview = await editFile(
      { path: rel, find_text: 'bar', replace_text: 'baz' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(preview.success).toBe(true);

    // Simulate an external modification that duplicates find_text.
    await fsWriteFile(path.join(tmpRoot, rel), 'bar\nbar', 'utf8');

    const commit = await commitEdit(
      { path: rel, find_text: 'bar', replace_text: 'baz' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(commit.success).toBe(false);
    expect(commit.error ?? '').toContain('modified');
  });

  test('commit re-validates uniqueness: file lost find_text between preview and commit', async () => {
    const rel = 'gone.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'bar', 'utf8');
    const commit = await commitEdit(
      { path: rel, find_text: 'missing-now', replace_text: 'x' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(commit.success).toBe(false);
    // Either "modified" (commit-time re-read shows 0 matches) or "not found".
    expect(commit.error ?? '').toMatch(/modified|not found|no longer present/);
  });

  test('path traversal blocked (commit)', async () => {
    const res = await commitEdit(
      { path: '../evil.txt', find_text: 'x', replace_text: 'y' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/traversal/i);
  });

  test('commit reports line-delta in the output', async () => {
    const rel = 'counted.txt';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'line1\nline2\nline3\n',
      'utf8',
    );
    const res = await commitEdit(
      {
        path: rel,
        find_text: 'line2',
        replace_text: 'line-two\nline-2b',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('Edited');
    expect(res.output).toMatch(/lines/);
    expect(res.output).toContain('+1');
  });
});
