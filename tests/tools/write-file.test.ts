import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readFile as fsReadFile, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitWrite, writeFile } from '@/tools/write-file';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-writefile-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('writeFile (preview)', () => {
  test('returns unified diff and requiresApproval for a new file', async () => {
    const result = await writeFile(
      { path: 'new.txt', content: 'hello\n' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.output).toContain('new.txt');
    expect(result.output).toContain('+hello');
    // File must NOT be written yet.
    expect(existsSync(path.join(tmpRoot, 'new.txt'))).toBe(false);
  });

  test('returns diff reflecting changes to an existing file', async () => {
    const rel = 'existing.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'one\ntwo\n', 'utf8');
    const result = await writeFile(
      { path: rel, content: 'one\ntwo\nthree\n' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.output).toContain('+three');
    // File contents must still equal the original until commitWrite.
    const raw = await fsReadFile(path.join(tmpRoot, rel), 'utf8');
    expect(raw).toBe('one\ntwo\n');
  });

  test('blocks path traversal', async () => {
    const result = await writeFile(
      { path: '../evil.txt', content: 'x' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/traversal/i);
    expect(result.requiresApproval).toBe(true);
  });
});

describe('commitWrite', () => {
  test('actually writes the file to disk', async () => {
    const rel = 'deep/nested/out.txt';
    const res = await commitWrite(
      { path: rel, content: 'persisted!' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    const raw = await fsReadFile(path.join(tmpRoot, rel), 'utf8');
    expect(raw).toBe('persisted!');
  });

  test('creates missing parent directories', async () => {
    const rel = 'a/b/c/d/e.txt';
    const res = await commitWrite(
      { path: rel, content: 'x' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(existsSync(path.join(tmpRoot, rel))).toBe(true);
  });

  test('path traversal is rejected at commit time too', async () => {
    const res = await commitWrite(
      { path: '../outside.txt', content: 'x' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/traversal/i);
  });
});
