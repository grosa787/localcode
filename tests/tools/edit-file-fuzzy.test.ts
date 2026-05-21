/**
 * Fuzzy `edit_file` fallback tests (ROADMAP #8 — simplified).
 *
 * The exact-match path is covered by `edit-file.test.ts` and
 * `edit-file-r5.test.ts`. This file targets the three fallback
 * strategies introduced for ROADMAP #8:
 *   1. Whitespace-normalised match — auto-resolves when exactly one.
 *   2. Token-overlap candidate listing — enriches the error message.
 *   3. Anchor-based snippet — enriches the error message for known
 *      declaration prefixes.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdir,
  readFile as fsReadFile,
  rm,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitEdit, editFile } from '@/tools/edit-file';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-editfile-fuzzy-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────
// Whitespace-normalised auto-resolve
// ───────────────────────────────────────────────────────────────────────

describe('editFile — whitespace-normalised match', () => {
  test('extra spaces in find_text still match real source', async () => {
    const rel = 'src.ts';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'const x = foo(a, b);\n',
      'utf8',
    );
    const result = await editFile(
      {
        path: rel,
        // Excess spaces — no exact match exists.
        find_text: 'const  x  =  foo(a,  b);',
        replace_text: 'const x = bar(a, b);',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('-const x = foo(a, b);');
    expect(result.output).toContain('+const x = bar(a, b);');
  });

  test('different indentation in find_text still resolves', async () => {
    const rel = 'indent.ts';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      '  return calc(value);\n',
      'utf8',
    );
    const result = await editFile(
      {
        path: rel,
        // Note: no leading indent.
        find_text: 'return calc(value);',
        replace_text: 'return compute(value);',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('+  return compute(value);');
  });

  test('whitespace-normalised match is ambiguous → reports count', async () => {
    const rel = 'dup.ts';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'a = 1;\na = 1;\n',
      'utf8',
    );
    const result = await editFile(
      {
        path: rel,
        find_text: 'a  =  1;',
        replace_text: 'a = 2;',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('whitespace');
    expect(result.error ?? '').toMatch(/2 location/);
  });

  test('commitEdit honours whitespace-fuzzy resolution', async () => {
    const rel = 'commit.ts';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'const greeting = "hello";\n',
      'utf8',
    );
    const result = await commitEdit(
      {
        path: rel,
        find_text: 'const  greeting  =  "hello";',
        replace_text: 'const greeting = "hi";',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(true);
    const raw = await fsReadFile(path.join(tmpRoot, rel), 'utf8');
    // Trailing newline of the original file is preserved by the
    // end-exclusive whitespace-fuzzy span (only the matched chars
    // through `;` are replaced).
    expect(raw).toBe('const greeting = "hi";\n');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Token-overlap "did you mean"
// ───────────────────────────────────────────────────────────────────────

describe('editFile — token candidates in error', () => {
  test('similar-but-different snippet surfaces as "did you mean" candidate', async () => {
    const rel = 'totals.ts';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      [
        'function calculateTotal(items) {',
        '  return items.reduce((s, i) => s + i.price, 0);',
        '}',
        '',
        'function computeSum(values) {',
        '  return values.reduce((acc, v) => acc + v, 0);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await editFile(
      {
        path: rel,
        find_text:
          'function calculateTotal(items) {\n  return items.reduce((s, i) => s + i.cost, 0);\n}',
        replace_text: 'function calculateTotal(items) { return 0; }',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('Did you mean');
    expect(result.error ?? '').toContain('calculateTotal');
    expect(result.error ?? '').toMatch(/line \d+-\d+:/);
  });

  test('plain not-found (no candidates) keeps whitespace tip', async () => {
    const rel = 'plain.txt';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      'just a plain unrelated file\n',
      'utf8',
    );
    const result = await editFile(
      {
        path: rel,
        find_text: 'totally absent random unique phrase',
        replace_text: 'replacement',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('not found');
    expect(result.error ?? '').toMatch(/whitespace|indent/i);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Anchor-based "did you mean"
// ───────────────────────────────────────────────────────────────────────

describe('editFile — anchor-based candidate', () => {
  test('function declaration anchor surfaces correct block', async () => {
    const rel = 'anchor-fn.ts';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      [
        'function helper() { return "noop"; }',
        '',
        'function calculateTotal(items) {',
        '  const total = items.reduce((s, i) => s + i.price, 0);',
        '  return total;',
        '}',
        '',
        'function unrelated() { return 42; }',
      ].join('\n'),
      'utf8',
    );

    const result = await editFile(
      {
        path: rel,
        // Wrong body but correct declaration → anchor finds it.
        find_text:
          'function calculateTotal(items) {\n  return items.reduce((s, i) => s + i.cost, 0);\n}',
        replace_text: 'function calculateTotal(items) { return 0; }',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    const errMsg = result.error ?? '';
    expect(errMsg).toContain('Did you mean');
    // Anchor block contains the actual declaration body.
    expect(errMsg).toContain('function calculateTotal(items) {');
    expect(errMsg).toContain('return total;');
  });

  test('class declaration anchor', async () => {
    const rel = 'anchor-class.ts';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      [
        'class Animal {',
        '  speak() { return "..."; }',
        '}',
      ].join('\n'),
      'utf8',
    );
    const result = await editFile(
      {
        path: rel,
        find_text: 'class Animal {\n  speak() { return "bark"; }\n}',
        replace_text: 'class Animal { speak() { return "meow"; } }',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('Did you mean');
    expect(result.error ?? '').toContain('class Animal');
  });

  test('const arrow-fn anchor', async () => {
    const rel = 'anchor-const.ts';
    await fsWriteFile(
      path.join(tmpRoot, rel),
      [
        'const sum = (a, b) => {',
        '  return a + b;',
        '};',
      ].join('\n'),
      'utf8',
    );
    const result = await editFile(
      {
        path: rel,
        find_text:
          'const sum = (a, b) => {\n  return a * b;\n};',
        replace_text: 'const sum = (a, b) => a + b;',
      },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('Did you mean');
    expect(result.error ?? '').toContain('const sum');
  });
});
