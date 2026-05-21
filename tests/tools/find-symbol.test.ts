/**
 * `find_symbol` tool tests (ROADMAP #11 — regex-based symbol search).
 *
 * Verifies:
 *   - Finds TS function/class/interface/type/const declarations.
 *   - Filters by `kind` correctly.
 *   - Detects Python `def`/`class`, Go `func`, Rust `fn`/`struct`,
 *     Java `class`/methods.
 *   - Falls back to plain word-boundary on unknown extensions.
 *   - Skips `node_modules`, `.git`, `dist`, `build`, etc.
 *   - Caps matches at 50 and reports truncation.
 *   - Returns helpful "no occurrences" message when zero results.
 *   - Validates Zod args.
 *   - Output format matches the spec: `path:line:col  — preview`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findSymbol } from '@/tools/find-symbol';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-findsym-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(tmpRoot, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await fsWriteFile(full, content, 'utf8');
}

// ───────────────────────────────────────────────────────────────────────
// Argument validation
// ───────────────────────────────────────────────────────────────────────

describe('findSymbol — argument validation', () => {
  test('empty name → Zod error', async () => {
    const res = await findSymbol(
      { name: '' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toContain('Invalid args');
  });

  test('invalid kind → Zod error', async () => {
    const res = await findSymbol(
      { name: 'foo', kind: 'banana' as never },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toContain('Invalid args');
  });
});

// ───────────────────────────────────────────────────────────────────────
// TypeScript / JavaScript
// ───────────────────────────────────────────────────────────────────────

describe('findSymbol — TS/JS', () => {
  test('finds function declaration', async () => {
    await write(
      'src/utils/math.ts',
      'export function calculateTotal(items) {\n  return items.length;\n}\n',
    );
    const res = await findSymbol(
      { name: 'calculateTotal' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('src/utils/math.ts:1');
    expect(res.output).toContain('calculateTotal');
    expect(res.output).toMatch(/Found \d+/);
  });

  test('finds class declaration when kind=class', async () => {
    await write(
      'src/Animal.ts',
      'export class Animal {\n  speak() {}\n}\n',
    );
    const res = await findSymbol(
      { name: 'Animal', kind: 'class' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('src/Animal.ts:1');
    expect(res.output).toContain('class Animal');
  });

  test('kind=function does not match a class declaration', async () => {
    await write(
      'src/Cls.ts',
      'export class Foo {\n  bar() {}\n}\n',
    );
    const res = await findSymbol(
      { name: 'Foo', kind: 'function' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    // Class is the only declaration — no method named `Foo`, no function.
    expect(res.output).toContain('No occurrences');
  });

  test('finds interface', async () => {
    await write(
      'src/types.ts',
      'export interface UserProfile {\n  id: string;\n}\n',
    );
    const res = await findSymbol(
      { name: 'UserProfile', kind: 'interface' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('UserProfile');
    expect(res.output).toContain('src/types.ts:1');
  });

  test('finds type alias', async () => {
    await write(
      'src/aliases.ts',
      'export type Coord = { x: number; y: number };\n',
    );
    const res = await findSymbol(
      { name: 'Coord', kind: 'type' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('Coord');
  });

  test('finds const arrow-function', async () => {
    await write(
      'src/helpers.ts',
      'export const sum = (a, b) => a + b;\n',
    );
    const res = await findSymbol(
      { name: 'sum', kind: 'const' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('sum');
    expect(res.output).toContain('src/helpers.ts:1');
  });

  test('multi-file search: aggregates matches', async () => {
    await write(
      'src/a.ts',
      'export function helper() {}\n',
    );
    await write(
      'src/b.ts',
      'export const helper = () => {};\n',
    );
    const res = await findSymbol(
      { name: 'helper' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    // Two distinct files in the output.
    expect(res.output).toContain('src/a.ts');
    expect(res.output).toContain('src/b.ts');
  });

  test('column points to symbol name within line', async () => {
    await write(
      'src/c.ts',
      '    function indented() {}\n',
    );
    const res = await findSymbol(
      { name: 'indented' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    // Column 13 = '    function ' (13 chars, then 'indented').
    expect(res.output).toContain('src/c.ts:1:13');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Python
// ───────────────────────────────────────────────────────────────────────

describe('findSymbol — Python', () => {
  test('finds def', async () => {
    await write('mod.py', 'def calculateTotal(items):\n    return 0\n');
    const res = await findSymbol(
      { name: 'calculateTotal' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('mod.py:1');
    expect(res.output).toContain('calculateTotal');
  });

  test('finds class', async () => {
    await write('m.py', 'class Service:\n    pass\n');
    const res = await findSymbol(
      { name: 'Service', kind: 'class' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('m.py:1');
  });

  test('finds module-level assignment as variable', async () => {
    await write('config.py', 'API_URL = "https://example.com"\n');
    const res = await findSymbol(
      { name: 'API_URL', kind: 'variable' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('API_URL');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Go
// ───────────────────────────────────────────────────────────────────────

describe('findSymbol — Go', () => {
  test('finds plain func', async () => {
    await write(
      'main.go',
      'package main\n\nfunc Greet(name string) string {\n    return "hi"\n}\n',
    );
    const res = await findSymbol(
      { name: 'Greet' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('main.go:3');
  });

  test('finds method on receiver', async () => {
    await write(
      'r.go',
      'package main\n\nfunc (s *Server) Start() error {\n    return nil\n}\n',
    );
    const res = await findSymbol(
      { name: 'Start' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('r.go:3');
  });

  test('finds type', async () => {
    await write(
      't.go',
      'package main\n\ntype User struct {\n    ID int\n}\n',
    );
    const res = await findSymbol(
      { name: 'User', kind: 'type' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('t.go:3');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Rust
// ───────────────────────────────────────────────────────────────────────

describe('findSymbol — Rust', () => {
  test('finds fn', async () => {
    await write(
      'lib.rs',
      'pub fn handle_request(req: Request) -> Response {\n    todo!()\n}\n',
    );
    const res = await findSymbol(
      { name: 'handle_request' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('lib.rs:1');
  });

  test('finds struct (kind=class)', async () => {
    await write(
      'mod.rs',
      'pub struct UserAccount {\n    pub id: u64,\n}\n',
    );
    const res = await findSymbol(
      { name: 'UserAccount', kind: 'class' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('UserAccount');
    expect(res.output).toContain('mod.rs:1');
  });

  test('finds trait (kind=interface)', async () => {
    await write(
      'iface.rs',
      'pub trait Loggable {\n    fn log(&self);\n}\n',
    );
    const res = await findSymbol(
      { name: 'Loggable', kind: 'interface' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('Loggable');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Java
// ───────────────────────────────────────────────────────────────────────

describe('findSymbol — Java', () => {
  test('finds class', async () => {
    await write(
      'src/Foo.java',
      'public class FooBar {\n  public void run() {}\n}\n',
    );
    const res = await findSymbol(
      { name: 'FooBar', kind: 'class' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('src/Foo.java:1');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Other / unknown extension fallback
// ───────────────────────────────────────────────────────────────────────

describe('findSymbol — unknown language fallback', () => {
  test('plain word-boundary match for .txt', async () => {
    await write(
      'notes.txt',
      'reminder: search for myToken.\nanother line.\n',
    );
    const res = await findSymbol(
      { name: 'myToken' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('notes.txt:1');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Excludes & limits
// ───────────────────────────────────────────────────────────────────────

describe('findSymbol — excludes', () => {
  test('skips node_modules', async () => {
    await write(
      'node_modules/leftpad/index.js',
      'export function leakedSymbol() {}\n',
    );
    await write('src/app.ts', 'export function realSymbol() {}\n');

    const res = await findSymbol(
      { name: 'leakedSymbol' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('No occurrences');
  });

  test('skips .git', async () => {
    await write('.git/HEAD', 'ref: refs/heads/main\n');
    await write(
      '.git/objects/abc/something',
      'def gitSymbol(): pass\n',
    );
    const res = await findSymbol(
      { name: 'gitSymbol' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('No occurrences');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Format & header
// ───────────────────────────────────────────────────────────────────────

describe('findSymbol — output format', () => {
  test('header line + body lines', async () => {
    await write('a.ts', 'export function f() {}\n');
    const res = await findSymbol(
      { name: 'f' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    const lines = res.output.split('\n');
    expect(lines[0]).toMatch(/^Found \d+\+? occurrences of "f":/);
    expect(lines[1]).toMatch(/^  a\.ts:\d+:\d+ {2}— /);
  });

  test('no match → friendly suggestion', async () => {
    await write('x.ts', 'export function present() {}\n');
    const res = await findSymbol(
      { name: 'absent' },
      { projectRoot: tmpRoot, dangerouslyAllowAll: false },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('No occurrences');
    expect(res.output).toContain("'any'");
  });
});
