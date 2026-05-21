/**
 * `multi_edit` tool — batched sequential edits with all-or-nothing commit.
 *
 * Coverage targets (per ROADMAP):
 *   - Sequential application (edit 2 operates on result of edit 1).
 *   - Unique oldString requirement; fails on duplicates without replaceAll.
 *   - All-or-nothing: one bad edit aborts the whole call; file unchanged.
 *   - replaceAll=true handles many occurrences.
 *   - Empty edits array rejected (Zod).
 *   - File-not-found path returns a clear error.
 *   - Identical old/new strings rejected as no-ops.
 *   - Path traversal blocked.
 *   - Commit produces an atomic write (file readable, line-delta summary).
 *   - Re-validation between preview and commit (file mutated externally).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdir,
  readFile as fsReadFile,
  readdir,
  rm,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitMultiEdit, multiEdit } from '@/tools/multi-edit';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-multiedit-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('multiEdit (preview)', () => {
  test('sequential edits: edit #2 sees result of edit #1', async () => {
    const rel = 'src.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'foo bar baz', 'utf8');

    // Edit 1: foo -> qux. Edit 2: qux (which only exists AFTER edit 1) -> done.
    const result = await multiEdit(
      {
        path: rel,
        edits: [
          { oldString: 'foo', newString: 'qux' },
          { oldString: 'qux', newString: 'done' },
        ],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.requiresApproval).toBe(true);
    // Diff reflects the CUMULATIVE result, not intermediate snapshots.
    expect(result.output).toContain('-foo bar baz');
    expect(result.output).toContain('+done bar baz');
    // File still unchanged before commit.
    const raw = await fsReadFile(path.join(tmpRoot, rel), 'utf8');
    expect(raw).toBe('foo bar baz');
  });

  test('non-unique oldString without replaceAll -> error mentions count + uniqueness', async () => {
    const rel = 'dup.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'x x x', 'utf8');
    const result = await multiEdit(
      { path: rel, edits: [{ oldString: 'x', newString: 'y' }] },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/matches 3 locations/);
    expect(result.error ?? '').toMatch(/unique/);
  });

  test('replaceAll=true replaces every occurrence', async () => {
    const rel = 'all.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'x x x\nx', 'utf8');
    const result = await multiEdit(
      {
        path: rel,
        edits: [{ oldString: 'x', newString: 'y', replaceAll: true }],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('-x x x');
    expect(result.output).toContain('+y y y');
  });

  test('all-or-nothing: a failing edit aborts everything; file is NOT touched', async () => {
    const rel = 'atomic.txt';
    const original = 'alpha beta gamma\nalpha alpha';
    await fsWriteFile(path.join(tmpRoot, rel), original, 'utf8');

    // Edit 1 valid, Edit 2 INVALID (alpha appears 3x; not unique).
    const preview = await multiEdit(
      {
        path: rel,
        edits: [
          { oldString: 'beta', newString: 'BETA' },
          { oldString: 'alpha', newString: 'A' },
        ],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(preview.success).toBe(false);
    expect(preview.error ?? '').toMatch(/Edit #2/);

    // Even via commit, no bytes change.
    const commit = await commitMultiEdit(
      {
        path: rel,
        edits: [
          { oldString: 'beta', newString: 'BETA' },
          { oldString: 'alpha', newString: 'A' },
        ],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(commit.success).toBe(false);
    const raw = await fsReadFile(path.join(tmpRoot, rel), 'utf8');
    expect(raw).toBe(original);
  });

  test('empty edits array is rejected by Zod', async () => {
    const rel = 'e.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'anything', 'utf8');
    const result = await multiEdit(
      { path: rel, edits: [] },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/edits|at least one/);
  });

  test('missing file returns a clear error pointing to write_file', async () => {
    const result = await multiEdit(
      {
        path: 'missing.txt',
        edits: [{ oldString: 'a', newString: 'b' }],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('missing.txt');
    expect(result.error ?? '').toContain('write_file');
  });

  test('identical oldString and newString rejected as no-op', async () => {
    const rel = 'noop.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'foo bar', 'utf8');
    const result = await multiEdit(
      {
        path: rel,
        edits: [{ oldString: 'foo', newString: 'foo' }],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/no-op|identical/i);
  });

  test('empty oldString rejected by Zod', async () => {
    const rel = 'a.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'foo', 'utf8');
    const result = await multiEdit(
      {
        path: rel,
        edits: [{ oldString: '', newString: 'y' }],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/oldString/);
  });

  test('path traversal blocked', async () => {
    const result = await multiEdit(
      {
        path: '../evil.txt',
        edits: [{ oldString: 'a', newString: 'b' }],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/traversal/i);
    expect(result.requiresApproval).toBe(true);
  });

  test('replaceAll with zero occurrences fails (zero-match guard)', async () => {
    const rel = 'z.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'hello', 'utf8');
    const result = await multiEdit(
      {
        path: rel,
        edits: [{ oldString: 'nope', newString: 'x', replaceAll: true }],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/not found/);
  });
});

describe('commitMultiEdit', () => {
  test('commit writes the cumulative result to disk', async () => {
    const rel = 'out.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'foo bar baz', 'utf8');
    const res = await commitMultiEdit(
      {
        path: rel,
        edits: [
          { oldString: 'foo', newString: 'qux' },
          { oldString: 'bar', newString: 'BAR' },
        ],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('Multi-edited');
    expect(res.output).toContain(rel);
    const raw = await fsReadFile(path.join(tmpRoot, rel), 'utf8');
    expect(raw).toBe('qux BAR baz');
  });

  test('commit re-validates after external change to file', async () => {
    const rel = 'changed.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'bar', 'utf8');

    // Preview succeeds — exactly one match.
    const prev = await multiEdit(
      { path: rel, edits: [{ oldString: 'bar', newString: 'baz' }] },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(prev.success).toBe(true);

    // External mutation: duplicate the target, breaking uniqueness.
    await fsWriteFile(path.join(tmpRoot, rel), 'bar\nbar', 'utf8');

    const commit = await commitMultiEdit(
      { path: rel, edits: [{ oldString: 'bar', newString: 'baz' }] },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(commit.success).toBe(false);
    expect(commit.error ?? '').toMatch(/modified since preview|matches 2/);
  });

  test('commit reports line-delta', async () => {
    const rel = 'lines.txt';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'line1\nline2\nline3\n',
      'utf8',
    );
    const res = await commitMultiEdit(
      {
        path: rel,
        edits: [
          { oldString: 'line2', newString: 'line-2a\nline-2b' },
          { oldString: 'line3', newString: 'tail-a\ntail-b\ntail-c' },
        ],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/2 edits/);
    // +1 from line2 split, +2 from line3 split = +3 lines.
    expect(res.output).toContain('+3');
  });

  test('path traversal blocked on commit', async () => {
    const res = await commitMultiEdit(
      {
        path: '../evil.txt',
        edits: [{ oldString: 'a', newString: 'b' }],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/traversal/i);
  });

  test('commit cleans up tmp file on success (atomic write leaves no debris)', async () => {
    const rel = 'clean.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'aaa bbb', 'utf8');
    const res = await commitMultiEdit(
      {
        path: rel,
        edits: [{ oldString: 'aaa', newString: 'AAA' }],
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    const entries = await readdir(tmpRoot);
    // Only the target file should remain — no `.tmp-*` debris.
    expect(entries).toEqual([rel]);
  });

  test('zero edits rejected by Zod on commit', async () => {
    const rel = 'z2.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'foo', 'utf8');
    const res = await commitMultiEdit(
      { path: rel, edits: [] },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/edits|at least one/);
  });
});
