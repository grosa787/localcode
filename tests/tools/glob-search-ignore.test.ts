/**
 * Tests covering `.gitignore` / `.ignore` / `.localcodeignore` handling
 * and symlink-loop protection in `glob_search`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { globSearch, _resetGlobIgnoreCache } from '@/tools/glob-search';

let tmpRoot = '';

async function touch(p: string, body = 'x'): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await fsWriteFile(p, body, 'utf8');
}

async function writeIgnore(
  dir: string,
  filename: string,
  body: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await fsWriteFile(path.join(dir, filename), body, 'utf8');
}

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-glob-ig-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
  _resetGlobIgnoreCache();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('globSearch ignore-file handling', () => {
  test('honours .gitignore at the project root', async () => {
    // node_modules is already excluded by DEFAULT_IGNORE, but we still
    // exercise the gitignore path via a directory the defaults don't know.
    await writeIgnore(tmpRoot, '.gitignore', 'secret/\n*.log\n!important.log\n');
    await touch(path.join(tmpRoot, 'secret', 'foo.ts'));
    await touch(path.join(tmpRoot, 'keep.ts'));
    await touch(path.join(tmpRoot, 'debug.log'));
    await touch(path.join(tmpRoot, 'important.log'));

    const res = await globSearch(
      { pattern: '**/*' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('keep.ts');
    expect(res.output).not.toContain('secret/foo.ts');
    expect(res.output).not.toContain('debug.log');
    expect(res.output).toContain('important.log');
  });

  test('honours nested .gitignore files (parent + child)', async () => {
    // Parent ignores everything under dist/, child ignores *.tmp.
    await writeIgnore(tmpRoot, '.gitignore', 'dist/\n');
    await writeIgnore(path.join(tmpRoot, 'pkg'), '.gitignore', '*.tmp\n');
    await touch(path.join(tmpRoot, 'src.ts'));
    await touch(path.join(tmpRoot, 'dist', 'out.js'));
    await touch(path.join(tmpRoot, 'pkg', 'keep.ts'));
    await touch(path.join(tmpRoot, 'pkg', 'scratch.tmp'));

    const res = await globSearch(
      { pattern: '**/*', cwd: 'pkg' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('keep.ts');
    expect(res.output).not.toContain('scratch.tmp');
  });

  test('child .gitignore extends parent rules within the same project', async () => {
    await writeIgnore(tmpRoot, '.gitignore', 'dist/\n');
    await writeIgnore(path.join(tmpRoot, 'pkg'), '.gitignore', '*.tmp\n');
    await touch(path.join(tmpRoot, 'dist', 'out.js'));
    await touch(path.join(tmpRoot, 'pkg', 'kept.ts'));
    await touch(path.join(tmpRoot, 'pkg', 'scratch.tmp'));

    const res = await globSearch(
      { pattern: '**/*' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    // Parent rule still hides dist/.
    expect(res.output).not.toContain('dist/out.js');
    // Child rule hides *.tmp under pkg/.
    expect(res.output).not.toContain('scratch.tmp');
    expect(res.output).toContain('pkg/kept.ts');
  });

  test('.ignore (ripgrep convention) is also honoured', async () => {
    await writeIgnore(tmpRoot, '.ignore', '*.bak\n');
    await touch(path.join(tmpRoot, 'a.ts'));
    await touch(path.join(tmpRoot, 'a.ts.bak'));

    const res = await globSearch(
      { pattern: '**/*' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('a.ts');
    expect(res.output).not.toContain('a.ts.bak');
  });

  test('.localcodeignore overrides .gitignore (negation wins)', async () => {
    await writeIgnore(tmpRoot, '.gitignore', '*.lock\n');
    await writeIgnore(tmpRoot, '.localcodeignore', '!*.lock\n');
    await touch(path.join(tmpRoot, 'bun.lock'));
    await touch(path.join(tmpRoot, 'keep.ts'));

    const res = await globSearch(
      { pattern: '**/*' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('bun.lock');
    expect(res.output).toContain('keep.ts');
  });

  test('symlink loop a -> b -> a does not hang', async () => {
    await touch(path.join(tmpRoot, 'src.ts'));
    // Create cyclic symlinks: tmpRoot/a -> tmpRoot/b, tmpRoot/b -> tmpRoot/a
    await symlink(path.join(tmpRoot, 'b'), path.join(tmpRoot, 'a'));
    await symlink(path.join(tmpRoot, 'a'), path.join(tmpRoot, 'b'));

    // fast-glob is configured with followSymbolicLinks: false, so the
    // glob itself won't loop, but our ignore-file walk also needs to be
    // safe. We assert termination by completing within the test timeout
    // and returning the expected files.
    const start = Date.now();
    const res = await globSearch(
      { pattern: '**/*' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    const elapsed = Date.now() - start;
    expect(res.success).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
    expect(res.output).toContain('src.ts');
  });

  test('respectIgnore: false bypasses every ignore file', async () => {
    await writeIgnore(tmpRoot, '.gitignore', 'secret/\n*.log\n');
    await touch(path.join(tmpRoot, 'secret', 'foo.ts'));
    await touch(path.join(tmpRoot, 'debug.log'));
    await touch(path.join(tmpRoot, 'keep.ts'));

    const res = await globSearch(
      { pattern: '**/*', respectIgnore: false },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('keep.ts');
    expect(res.output).toContain('secret/foo.ts');
    expect(res.output).toContain('debug.log');
  });

  test('caches rule chain across calls in the same project', async () => {
    await writeIgnore(tmpRoot, '.gitignore', '*.log\n');
    await touch(path.join(tmpRoot, 'a.log'));
    await touch(path.join(tmpRoot, 'a.ts'));

    const ctx = { projectRoot: tmpRoot, dangerouslyAllowAll: false };
    const first = await globSearch({ pattern: '**/*' }, ctx);
    expect(first.success).toBe(true);
    expect(first.output).not.toContain('a.log');

    // Re-run — cache hit. Result must be identical.
    const second = await globSearch({ pattern: '**/*' }, ctx);
    expect(second.success).toBe(true);
    expect(second.output).not.toContain('a.log');
    expect(second.output).toBe(first.output);
  });

  test('respectIgnore default is true (omitted arg = filtered)', async () => {
    await writeIgnore(tmpRoot, '.gitignore', '*.tmp\n');
    await touch(path.join(tmpRoot, 'x.tmp'));
    await touch(path.join(tmpRoot, 'y.ts'));

    const res = await globSearch(
      { pattern: '**/*' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('y.ts');
    expect(res.output).not.toContain('x.tmp');
  });
});
