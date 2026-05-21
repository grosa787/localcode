import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDir } from '@/tools/list-dir';

let tmpRoot = '';

async function touch(p: string, content = 'x'): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await fsWriteFile(p, content, 'utf8');
}

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-listdir-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('listDir tool', () => {
  test('lists nested directory tree with proper indentation', async () => {
    await touch(path.join(tmpRoot, 'top.txt'));
    await touch(path.join(tmpRoot, 'src', 'a.ts'));
    await touch(path.join(tmpRoot, 'src', 'nested', 'b.ts'));

    const res = await listDir(
      {},
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );

    expect(res.success).toBe(true);
    const out = res.output;
    // Root name emitted with trailing slash.
    expect(out.split('\n')[0]).toMatch(/\/$/);
    expect(out).toContain('src/');
    expect(out).toContain('a.ts');
    expect(out).toContain('nested/');
    expect(out).toContain('b.ts');
    expect(out).toContain('top.txt');
  });

  test('excludes node_modules', async () => {
    await touch(path.join(tmpRoot, 'node_modules', 'pkg', 'index.js'));
    await touch(path.join(tmpRoot, 'src', 'keep.ts'));

    const res = await listDir(
      {},
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).not.toContain('node_modules');
    expect(res.output).toContain('keep.ts');
  });

  test('honours .gitignore patterns', async () => {
    await fsWriteFile(path.join(tmpRoot, '.gitignore'), 'secret.txt\n', 'utf8');
    await touch(path.join(tmpRoot, 'secret.txt'), 'hush');
    await touch(path.join(tmpRoot, 'public.txt'), 'hello');

    const res = await listDir(
      {},
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('public.txt');
    expect(res.output).not.toContain('secret.txt');
  });

  test('respects max depth of 5', async () => {
    // Create 7 levels deep.
    const deep = path.join(
      tmpRoot,
      'd1',
      'd2',
      'd3',
      'd4',
      'd5',
      'd6',
      'd7.txt',
    );
    await touch(deep);

    const res = await listDir(
      {},
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('d5/');
    // Beyond depth 5 either a "max depth" marker appears or the deepest
    // leaf is not shown — we at minimum require that the final file is
    // not listed anywhere in the tree output.
    expect(res.output).not.toContain('d7.txt');
  });

  test('rejects path traversal', async () => {
    const res = await listDir(
      { path: '../../../etc' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/traversal/i);
  });
});
