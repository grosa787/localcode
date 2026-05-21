import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readFile as fsReadFile, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildInitPrompt,
  getLocalcodeMdStatus,
  readLocalcodeMd,
  writeLocalcodeMd,
} from '@/init/localcode-md';
import type { ScanResult } from '@/init/project-scanner';

let tmpRoot = '';

const scanFixture: ScanResult = {
  tree: 'root/\n  src/\n    index.ts\n  README.md',
  fileCount: 3,
  totalSize: 42,
  keyFiles: [
    { path: 'README.md', content: '# Project\n', type: 'readme' },
    { path: 'package.json', content: '{"name":"x"}', type: 'manifest' },
  ],
  languages: ['TypeScript', 'Markdown', 'JSON'],
};

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-md-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('buildInitPrompt', () => {
  test('includes the six required section headers', () => {
    const prompt = buildInitPrompt(scanFixture, null);
    expect(prompt).toContain('## Project Overview');
    expect(prompt).toContain('## Tech Stack');
    expect(prompt).toContain('## Architecture');
    expect(prompt).toContain('## Key Files');
    expect(prompt).toContain('## Development Conventions');
    expect(prompt).toContain('## Common Tasks');
  });

  test('embeds the project tree and key file contents', () => {
    const prompt = buildInitPrompt(scanFixture, null);
    expect(prompt).toContain('root/');
    expect(prompt).toContain('### README.md');
    expect(prompt).toContain('### package.json');
  });

  test('inlines existing LOCALCODE.md when provided', () => {
    const prompt = buildInitPrompt(scanFixture, '## Existing\nold');
    expect(prompt).toContain('Update the existing LOCALCODE.md');
    expect(prompt).toContain('## Existing');
  });

  test('omits update block when existing is null or empty', () => {
    expect(buildInitPrompt(scanFixture, null)).not.toContain(
      'Update the existing LOCALCODE.md',
    );
    expect(buildInitPrompt(scanFixture, '   \n')).not.toContain(
      'Update the existing LOCALCODE.md',
    );
  });
});

describe('writeLocalcodeMd', () => {
  test('creates .localcode/LOCALCODE.md and skills dir and updates .gitignore', async () => {
    writeLocalcodeMd(tmpRoot, '# Hello\n');
    expect(existsSync(path.join(tmpRoot, '.localcode', 'LOCALCODE.md'))).toBe(true);
    expect(existsSync(path.join(tmpRoot, '.localcode', 'skills'))).toBe(true);

    const gi = await fsReadFile(path.join(tmpRoot, '.gitignore'), 'utf8');
    expect(gi).toContain('.localcode/');
  });

  test('does not duplicate .localcode/ in .gitignore', async () => {
    // pre-existing .gitignore that already has the entry.
    await fsWriteFile(
      path.join(tmpRoot, '.gitignore'),
      'node_modules\n.localcode/\n',
      'utf8',
    );
    writeLocalcodeMd(tmpRoot, '# Again\n');
    const gi = await fsReadFile(path.join(tmpRoot, '.gitignore'), 'utf8');
    const occurrences = gi
      .split('\n')
      .filter((l) => l.trim().replace(/\/+$/, '') === '.localcode').length;
    expect(occurrences).toBe(1);
  });
});

describe('readLocalcodeMd / getLocalcodeMdStatus', () => {
  test('returns null when file does not exist', () => {
    expect(readLocalcodeMd(tmpRoot)).toBeNull();
    const status = getLocalcodeMdStatus(tmpRoot);
    expect(status.exists).toBe(false);
    expect(status.path.endsWith('LOCALCODE.md')).toBe(true);
  });

  test('returns file content after writeLocalcodeMd', () => {
    writeLocalcodeMd(tmpRoot, '# Hello');
    const raw = readLocalcodeMd(tmpRoot);
    expect(raw).not.toBeNull();
    expect(raw?.startsWith('# Hello')).toBe(true);
    const status = getLocalcodeMdStatus(tmpRoot);
    expect(status.exists).toBe(true);
  });
});
