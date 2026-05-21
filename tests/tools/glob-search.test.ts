import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { globSearch } from '@/tools/glob-search';

let tmpRoot = '';

async function touch(p: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await fsWriteFile(p, 'x', 'utf8');
}

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-glob-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('globSearch tool', () => {
  test('finds all *.ts files with **/*.ts', async () => {
    await touch(path.join(tmpRoot, 'a.ts'));
    await touch(path.join(tmpRoot, 'sub', 'b.ts'));
    await touch(path.join(tmpRoot, 'sub', 'c.md'));

    const res = await globSearch(
      { pattern: '**/*.ts' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('a.ts');
    expect(res.output).toContain('sub/b.ts');
    expect(res.output).not.toContain('c.md');
  });

  test('returns a helpful message on zero matches', async () => {
    await touch(path.join(tmpRoot, 'a.ts'));
    const res = await globSearch(
      { pattern: '**/*.nomatch-ext' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output.toLowerCase()).toContain('no files matched');
  });

  test('excludes node_modules by default', async () => {
    await touch(path.join(tmpRoot, 'node_modules', 'dep', 'index.ts'));
    await touch(path.join(tmpRoot, 'keep.ts'));

    const res = await globSearch(
      { pattern: '**/*.ts' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).not.toContain('node_modules');
    expect(res.output).toContain('keep.ts');
  });

  test('rejects empty pattern via zod', async () => {
    const res = await globSearch(
      { pattern: '' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toContain('Invalid args');
  });

  // M1 — cwd containment. The optional `cwd` arg must stay inside the
  // project root. Both absolute paths and relative paths that escape
  // via `..` are rejected.

  test('rejects absolute cwd outside the project root', async () => {
    const res = await globSearch(
      { pattern: '**/*', cwd: '/etc' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/escapes project root/i);
  });

  test('rejects relative cwd that climbs out via ..', async () => {
    const res = await globSearch(
      { pattern: '**/*', cwd: '../..' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/escapes project root/i);
  });

  test('accepts cwd that points to a subdirectory of the root', async () => {
    await touch(path.join(tmpRoot, 'sub', 'inner.ts'));
    const res = await globSearch(
      { pattern: '**/*.ts', cwd: 'sub' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('inner.ts');
  });

  test('rejects symlink-cwd that resolves outside the project root', async () => {
    const { symlink } = await import('node:fs/promises');
    await symlink('/etc', path.join(tmpRoot, 'escape-link'));
    const res = await globSearch(
      { pattern: '**/*', cwd: 'escape-link' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/escapes project root/i);
  });
});
