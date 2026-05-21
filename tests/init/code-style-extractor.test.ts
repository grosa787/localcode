import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractCodeStyle,
  renderCodeStyleMarkdown,
} from '@/init/code-style-extractor';

let tmpRoot = '';

async function touch(relPath: string, content: string): Promise<void> {
  const full = path.join(tmpRoot, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await fsWriteFile(full, content, 'utf8');
}

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-style-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('extractCodeStyle', () => {
  test('returns defaults for an empty / non-existent project', async () => {
    const r = await extractCodeStyle(tmpRoot);
    expect(r.indentation).toBe('mixed');
    expect(r.lineEndings).toBe('lf');
    expect(r.testFramework).toBe('unknown');
    expect(r.linterConfigured).toBe('none');
  });

  test('detects single quotes + 2-space indent + camelCase functions in TS', async () => {
    // Write at least 3 TS files with consistent style. Need enough
    // indented lines (>=3 per file) so the indent heuristic fires.
    const tsFile = (i: number): string =>
      `import { foo } from './foo';\nimport { bar } from './bar';\nimport { baz } from './baz';\n\nexport function helloWorld${i}() {\n  const greeting = 'hi';\n  const subject = 'world';\n  const punct = '!';\n  const message = greeting + subject + punct;\n  return message;\n}\n`;
    for (let i = 0; i < 3; i += 1) {
      await touch(`src/file${i}.ts`, tsFile(i));
    }
    const r = await extractCodeStyle(tmpRoot);
    expect(r.indentation).toBe('2-spaces');
    expect(r.quotes).toBe('single');
    expect(r.namingConventions.functions).toBe('camelCase');
    expect(r.importStyle).toBe('relative');
  });

  test('detects test framework via package.json', async () => {
    await touch('package.json', JSON.stringify({
      name: 'x',
      devDependencies: { vitest: '^1.0.0' },
    }));
    await touch('src/a.ts', "export const x = 'one';\n");
    const r = await extractCodeStyle(tmpRoot);
    expect(r.testFramework).toBe('vitest');
  });

  test('detects bun:test via bunfig.toml', async () => {
    await touch('bunfig.toml', '[test]\npreload = "tests/setup.ts"\n');
    const r = await extractCodeStyle(tmpRoot);
    expect(r.testFramework).toBe('bun:test');
  });

  test('detects multiple linters', async () => {
    await touch('package.json', JSON.stringify({
      name: 'x',
      devDependencies: { eslint: '^9.0.0', prettier: '^3.0.0' },
    }));
    const r = await extractCodeStyle(tmpRoot);
    expect(r.linterConfigured).toBe('multiple');
  });

  test('detects single linter (eslint)', async () => {
    await touch('eslint.config.mjs', 'export default [];\n');
    const r = await extractCodeStyle(tmpRoot);
    expect(r.linterConfigured).toBe('eslint');
  });

  test('classifies kebab-case file names', async () => {
    await touch('src/my-cool-file.ts', 'export const x = 1;\n');
    await touch('src/my-other-file.ts', 'export const y = 2;\n');
    await touch('src/yet-another-file.ts', 'export const z = 3;\n');
    const r = await extractCodeStyle(tmpRoot);
    expect(r.namingConventions.files).toBe('kebab-case');
  });

  test('classifies snake_case Python function names', async () => {
    await touch('app.py', 'def hello_world():\n    return 1\n\ndef do_thing():\n    return 2\n\ndef my_func():\n    return 3\n');
    const r = await extractCodeStyle(tmpRoot);
    expect(r.namingConventions.functions).toBe('snake_case');
  });

  test('returns "interface" type-style when interface declarations dominate', async () => {
    const tsFile = `export interface Foo {\n  a: number;\n}\nexport interface Bar {\n  b: string;\n}\n`;
    for (let i = 0; i < 3; i += 1) {
      await touch(`src/types${i}.ts`, tsFile);
    }
    const r = await extractCodeStyle(tmpRoot);
    expect(r.typeStyle).toBe('interface');
  });

  test('detects gofmt + go-test for Go projects', async () => {
    await touch('go.mod', 'module example.com/x\n\ngo 1.21\n');
    await touch('main_test.go', 'package main\n\nimport "testing"\n\nfunc TestMain(t *testing.T) {}\n');
    const r = await extractCodeStyle(tmpRoot);
    expect(r.linterConfigured).toBe('gofmt');
    expect(r.testFramework).toBe('go-test');
  });
});

describe('renderCodeStyleMarkdown', () => {
  test('emits a markdown block with the expected header + bullets', async () => {
    const r = await extractCodeStyle(tmpRoot); // defaults
    const md = renderCodeStyleMarkdown(r);
    expect(md).toContain('## Project Conventions (auto-detected, DO NOT VIOLATE)');
    expect(md).toContain('- Indentation:');
    expect(md).toContain('- Quotes:');
    expect(md).toContain('- Test framework:');
    expect(md).toContain('- Naming:');
  });
});
