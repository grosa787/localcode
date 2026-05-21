import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseGitignore, shouldIgnore } from '@/init/gitignore-parser';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-gitignore-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('parseGitignore', () => {
  test('appends built-ins when file is absent', () => {
    const patterns = parseGitignore(tmpRoot);
    expect(patterns).toContain('node_modules');
    expect(patterns).toContain('.git');
    expect(patterns).toContain('dist');
    expect(patterns).toContain('.localcode');
    expect(patterns).toContain('*.lock');
    expect(patterns).toContain('*.log');
  });

  test('reads file contents and dedupes against built-ins', async () => {
    await fsWriteFile(
      path.join(tmpRoot, '.gitignore'),
      '# comment\n\nnode_modules\nsecret.txt\n',
      'utf8',
    );
    const patterns = parseGitignore(tmpRoot);
    // secret.txt from file
    expect(patterns).toContain('secret.txt');
    // node_modules should appear only once even though file + built-ins
    // both contain it.
    const nmCount = patterns.filter((p) => p === 'node_modules').length;
    expect(nmCount).toBe(1);
  });

  test('ignores comment and negation lines', async () => {
    await fsWriteFile(
      path.join(tmpRoot, '.gitignore'),
      '# a comment\n!unignore.txt\nkeep.txt\n',
      'utf8',
    );
    const patterns = parseGitignore(tmpRoot);
    expect(patterns).toContain('keep.txt');
    expect(patterns).not.toContain('!unignore.txt');
    expect(patterns).not.toContain('# a comment');
  });
});

describe('shouldIgnore', () => {
  test('matches plain name anywhere in the tree', () => {
    expect(shouldIgnore('node_modules/foo/index.js', ['node_modules'])).toBe(true);
    expect(shouldIgnore('src/index.ts', ['node_modules'])).toBe(false);
  });

  test('matches trailing-slash directory pattern', () => {
    expect(shouldIgnore('dist/cli.js', ['dist/'])).toBe(true);
    expect(shouldIgnore('src/dist-keep.ts', ['dist/'])).toBe(false);
  });

  test('matches anchored /pattern only at the root', () => {
    expect(shouldIgnore('foo', ['/foo'])).toBe(true);
    expect(shouldIgnore('src/foo', ['/foo'])).toBe(false);
  });

  test('matches *.ext globs', () => {
    expect(shouldIgnore('a/b/c.log', ['*.log'])).toBe(true);
    expect(shouldIgnore('a/b/c.txt', ['*.log'])).toBe(false);
  });

  test('matches **/name anywhere', () => {
    expect(shouldIgnore('deep/nested/foo', ['**/foo'])).toBe(true);
    expect(shouldIgnore('foo/bar', ['foo/**'])).toBe(true);
  });

  test('empty path is never ignored', () => {
    expect(shouldIgnore('', ['foo'])).toBe(false);
  });
});
