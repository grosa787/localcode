import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from '@/tools/read-file';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-readfile-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('readFile tool', () => {
  test('returns the contents of an existing file', async () => {
    const rel = 'hello.txt';
    await fsWriteFile(path.join(tmpRoot, rel), 'hi there\n', 'utf8');

    const result = await readFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('hi there\n');
    expect(result.error).toBeUndefined();
  });

  test('blocks path traversal with .. segments', async () => {
    const result = await readFile(
      { path: '../../etc/passwd' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/traversal/i);
  });

  test('reports missing file as failure', async () => {
    const result = await readFile(
      { path: 'does-not-exist.txt' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain("does-not-exist.txt");
  });

  test('rejects empty path via zod', async () => {
    const result = await readFile(
      { path: '' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('Invalid args');
  });

  test('truncates files larger than 100KB to 500 lines with a marker', async () => {
    // Build > 100 KB of text composed of many short lines so we can assert the
    // "showing first 500 lines" clause.
    const line = 'line'.padEnd(90, 'x') + '\n'; // 91 bytes
    const total = 'pad'.padEnd(150, 'x') + '\n' + line.repeat(1500); // > 100 KB
    const rel = 'big.txt';
    await fsWriteFile(path.join(tmpRoot, rel), total, 'utf8');

    const result = await readFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('[... file truncated');
    expect(result.output).toContain('first 500 lines');
  });

  test('rejects when target is a directory', async () => {
    const subdir = path.join(tmpRoot, 'sub');
    await mkdir(subdir, { recursive: true });
    const result = await readFile(
      { path: 'sub' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/not a file/i);
  });
});
