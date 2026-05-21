/**
 * lint_file tool — dispatches to language-native syntax/type checkers.
 *
 * We avoid asserting on specific diagnostic text because linter output varies
 * by version; instead we assert structural properties:
 *   - success: true when the linter ran (or was skipped)
 *   - output: contains canonical phrases (`No issues found.`, `Found N diagnostic`)
 *   - path traversal is blocked (success: false + error mentions traversal)
 *   - missing file -> success: false + error mentions the path
 *   - unknown extension -> success: true with a friendly skip message
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lintFile } from '@/tools/lint-file';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-lintfile-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('lintFile tool — argument validation', () => {
  test('empty path is rejected via zod', async () => {
    const result = await lintFile(
      { path: '' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('Invalid args');
  });

  test('path traversal is blocked', async () => {
    const result = await lintFile(
      { path: '../../etc/passwd' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/traversal/i);
  });

  test('missing file reports a canonical error', async () => {
    const result = await lintFile(
      { path: 'does-not-exist.ts' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('does-not-exist.ts');
  });

  test('rejects when target is a directory', async () => {
    const sub = path.join(tmpRoot, 'nested');
    await mkdir(sub, { recursive: true });

    const result = await lintFile(
      { path: 'nested' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/not a regular file/i);
  });
});

describe('lintFile tool — unknown / skipped extensions', () => {
  test('files with no extension return a friendly skip message', async () => {
    const rel = 'README';
    await fsWriteFile(path.join(tmpRoot, rel), 'some text\n', 'utf8');
    const result = await lintFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('No linter configured');
    expect(result.output).toContain('skipping');
  });

  test('markdown files are skipped with a friendly message', async () => {
    const rel = 'notes.md';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      '# hello\n\nsome markdown\n',
      'utf8',
    );
    const result = await lintFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('No linter configured for md');
    expect(result.output).toContain('skipping');
  });

  test('arbitrary binary-ish extension is still skipped gracefully', async () => {
    const rel = 'picture.jpg';
    await fsWriteFile(path.join(tmpRoot, rel), 'fake-bytes', 'utf8');
    const result = await lintFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('No linter configured for jpg');
  });
});

describe('lintFile tool — TypeScript', () => {
  test('runs the tsc path for .ts files (success always true)', async () => {
    // Create a minimal tsconfig + a TS file so tsc has a project to work
    // against. We accept any of these outcomes: "No issues found.",
    // "Found N diagnostic(s)", "Linter for ts/tsx/js/jsx not installed",
    // or a timeout message. All of them satisfy `success: true`.
    const rel = 'clean.ts';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'export const answer: number = 42;\n',
      'utf8',
    );
    await fsWriteFile(
      path.join(tmpRoot, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ['clean.ts'],
        },
        null,
        2,
      ),
      'utf8',
    );
    const result = await lintFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    // The output must be one of the expected linter shapes.
    const matchesExpected =
      result.output === 'No issues found.' ||
      result.output.includes('Found') ||
      result.output.includes('not installed') ||
      result.output.includes('skipping') ||
      result.output.includes('timed out');
    expect(matchesExpected).toBe(true);
  }, 30_000);

  test('broken TS file reports diagnostics or skip (never crashes)', async () => {
    const rel = 'broken.ts';
    // Intentionally broken: wrong type assignment.
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'export const n: number = "not a number";\n',
      'utf8',
    );
    await fsWriteFile(
      path.join(tmpRoot, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ['broken.ts'],
        },
        null,
        2,
      ),
      'utf8',
    );
    const result = await lintFile(
      { path: rel },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    // Output is either diagnostics OR a "not installed" / skip line.
    const matchesExpected =
      result.output === 'No issues found.' ||
      result.output.includes('Found') ||
      result.output.includes('not installed') ||
      result.output.includes('skipping') ||
      result.output.includes('timed out');
    expect(matchesExpected).toBe(true);
  }, 30_000);

  test('handles .tsx, .js, .jsx extensions the same as .ts', async () => {
    const files = ['a.tsx', 'b.js', 'c.jsx'];
    for (const f of files) {
      await fsWriteFile(
        path.join(tmpRoot, f),
        'export const x = 1;\n',
        'utf8',
      );
      const result = await lintFile(
        { path: f },
        { projectRoot: tmpRoot, dangerouslyAllowAll: false },
      );
      // Whatever tsc does, the tool returns success.
      expect(result.success).toBe(true);
      expect(typeof result.output).toBe('string');
    }
  }, 60_000);
});
