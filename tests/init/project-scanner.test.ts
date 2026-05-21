import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectScanner } from '@/init/project-scanner';

let tmpRoot = '';

async function touch(relPath: string, content = 'x'): Promise<void> {
  const full = path.join(tmpRoot, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await fsWriteFile(full, content, 'utf8');
}

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-scanner-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('ProjectScanner.scan', () => {
  test('returns tree + detected languages + key files', async () => {
    await touch('README.md', '# Project\n');
    await touch('package.json', '{"name":"x"}');
    await touch('src/index.ts', 'export {};\n');
    await touch('src/util.ts', 'export const x = 1;\n');

    const scanner = new ProjectScanner();
    const result = await scanner.scan(tmpRoot);

    expect(result.fileCount).toBeGreaterThanOrEqual(4);
    expect(result.tree).toContain('src/');
    expect(result.tree).toContain('README.md');
    expect(result.tree).toContain('package.json');

    const keyPaths = result.keyFiles.map((k) => k.path);
    expect(keyPaths).toContain('README.md');
    expect(keyPaths).toContain('package.json');

    expect(result.languages).toContain('TypeScript');
    expect(result.languages).toContain('Markdown');
    // Note: the scanner's language map doesn't include .json — intentional
    // scope limit from Agent 7's scanner. We only assert what it does map.
  });

  test('respects .gitignore (excludes secret.txt)', async () => {
    await touch('.gitignore', 'secret.txt\n');
    await touch('secret.txt', 'hidden');
    await touch('public.txt', 'visible');

    const result = await new ProjectScanner().scan(tmpRoot);
    expect(result.tree).toContain('public.txt');
    expect(result.tree).not.toContain('secret.txt');
  });

  test('excludes node_modules by default', async () => {
    await touch('node_modules/pkg/index.js', 'x');
    await touch('keep.ts', 'x');
    const result = await new ProjectScanner().scan(tmpRoot);
    expect(result.tree).not.toContain('node_modules');
    expect(result.tree).toContain('keep.ts');
  });
});
