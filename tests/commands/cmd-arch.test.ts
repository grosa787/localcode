/**
 * /arch slash-command tests.
 *
 * Covers `check`, `rules`, `init`, and `ignore <pattern>`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendIgnorePattern, createArchCommand } from '@/commands/cmd-arch';
import { _resetTsconfigCache, archConfigPath } from '@/architecture';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext } from '@/types/global';

let projectRoot = '';

beforeEach(async () => {
  projectRoot = path.join(os.tmpdir(), `cmd-arch-${crypto.randomUUID()}`);
  await mkdir(path.join(projectRoot, 'src', 'ui'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src', 'llm'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'llm', 'adapter.ts'), 'export const x = 1;');
  await writeFile(
    path.join(projectRoot, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  );
  _resetTsconfigCache();
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  _resetTsconfigCache();
});

function buildCtx(): { ctx: CommandContext; out: string[] } {
  const out: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  config.model.current = 'm1';
  config.onboarding.completed = true;
  const ctx: CommandContext = {
    projectRoot,
    sessionId: 'sess-1',
    config,
    print: (t: string): void => {
      out.push(t);
    },
    setScreen: (): void => {
      /* no-op */
    },
  };
  return { ctx, out };
}

describe('/arch init', () => {
  test('writes a starter arch.toml with rules derived from src/ subdirs', async () => {
    const cmd = createArchCommand();
    const { ctx, out } = buildCtx();
    await cmd.execute('init', ctx);
    const archPath = archConfigPath(projectRoot);
    expect(existsSync(archPath)).toBe(true);
    const written = await readFile(archPath, 'utf8');
    expect(written).toContain('[[rule]]');
    expect(written).toContain('ui-isolation');
    expect(written).toContain('llm-isolation');
    expect(written).toContain('tests-anywhere');
    expect(written).toContain('[global]');
    expect(out.join('\n')).toContain('Wrote starter rules');
  });

  test('scaffolded arch.toml round-trips through the loader', async () => {
    const cmd = createArchCommand();
    const { ctx } = buildCtx();
    await cmd.execute('init', ctx);
    // Re-using the imported parseArchConfigSource ensures the scaffold
    // is loader-clean — guards against future schema drift where the
    // scaffold's `allowAll` rules would otherwise fail validation.
    const { parseArchConfigSource } = await import('@/architecture');
    const written = await readFile(archConfigPath(projectRoot), 'utf8');
    const parsed = parseArchConfigSource(written, archConfigPath(projectRoot));
    expect(parsed.rule.length).toBeGreaterThan(0);
  });

  test('refuses to overwrite an existing arch.toml', async () => {
    await mkdir(path.join(projectRoot, '.localcode'), { recursive: true });
    await writeFile(archConfigPath(projectRoot), 'existing = "value"');
    const cmd = createArchCommand();
    const { ctx, out } = buildCtx();
    await cmd.execute('init', ctx);
    const written = await readFile(archConfigPath(projectRoot), 'utf8');
    expect(written).toBe('existing = "value"');
    expect(out.join('\n')).toContain('refusing to overwrite');
  });
});

describe('/arch rules', () => {
  test('prints "no arch.toml" when absent', async () => {
    const cmd = createArchCommand();
    const { ctx, out } = buildCtx();
    await cmd.execute('rules', ctx);
    expect(out.join('\n')).toContain('No arch.toml');
  });

  test('lists rules and global ignores', async () => {
    await mkdir(path.join(projectRoot, '.localcode'), { recursive: true });
    await writeFile(
      archConfigPath(projectRoot),
      `
[[rule]]
id = "ui-no-llm"
description = "UI must not import LLM"
match = "src/ui/**/*.ts"
forbid = ["src/llm/**"]

[global]
ignoreImports = ["^node:.*"]
`,
    );
    const cmd = createArchCommand();
    const { ctx, out } = buildCtx();
    await cmd.execute('rules', ctx);
    const joined = out.join('\n');
    expect(joined).toContain('ui-no-llm');
    expect(joined).toContain('src/ui/**/*.ts');
    expect(joined).toContain('src/llm/**');
    expect(joined).toContain('^node:.*');
  });
});

describe('/arch check', () => {
  test('flags a violating file and shows the first details', async () => {
    await mkdir(path.join(projectRoot, '.localcode'), { recursive: true });
    await writeFile(
      archConfigPath(projectRoot),
      `
[[rule]]
id = "ui-no-llm"
match = "src/ui/**/*.ts"
forbid = ["src/llm/**", "@/llm/**"]
`,
    );
    await writeFile(
      path.join(projectRoot, 'src', 'ui', 'main.ts'),
      `import { x } from '@/llm/adapter';`,
    );
    const cmd = createArchCommand();
    const { ctx, out } = buildCtx();
    await cmd.execute('check', ctx);
    const joined = out.join('\n');
    expect(joined).toContain('Found 1 violation');
    expect(joined).toContain('ui-no-llm');
    expect(joined).toContain('src/ui/main.ts');
  });

  test('reports clean when no violations', async () => {
    await mkdir(path.join(projectRoot, '.localcode'), { recursive: true });
    await writeFile(
      archConfigPath(projectRoot),
      `
[[rule]]
id = "ui-no-llm"
match = "src/ui/**/*.ts"
forbid = ["src/llm/**"]
`,
    );
    await writeFile(
      path.join(projectRoot, 'src', 'ui', 'clean.ts'),
      `export const ok = 1;`,
    );
    const cmd = createArchCommand();
    const { ctx, out } = buildCtx();
    await cmd.execute('check', ctx);
    expect(out.join('\n')).toContain('No architecture violations');
  });
});

describe('/arch ignore', () => {
  test('creates arch.toml with [global] block when none exists', async () => {
    const cmd = createArchCommand();
    const { ctx, out } = buildCtx();
    await cmd.execute('ignore ^bun:.*', ctx);
    const written = await readFile(archConfigPath(projectRoot), 'utf8');
    expect(written).toContain('[global]');
    expect(written).toContain('"^bun:.*"');
    expect(out.join('\n')).toContain('Added ignoreImports pattern');
  });

  test('appends to existing ignoreImports without losing entries', async () => {
    await mkdir(path.join(projectRoot, '.localcode'), { recursive: true });
    await writeFile(
      archConfigPath(projectRoot),
      `
[global]
ignoreImports = ["^node:.*"]
`,
    );
    const cmd = createArchCommand();
    const { ctx } = buildCtx();
    await cmd.execute('ignore ^bun:.*', ctx);
    const written = await readFile(archConfigPath(projectRoot), 'utf8');
    expect(written).toContain('"^node:.*"');
    expect(written).toContain('"^bun:.*"');
  });

  test('rejects invalid regex', async () => {
    const cmd = createArchCommand();
    const { ctx, out } = buildCtx();
    await cmd.execute('ignore [unbalanced', ctx);
    expect(out.join('\n')).toContain('Invalid regex');
    expect(existsSync(archConfigPath(projectRoot))).toBe(false);
  });

  test('rejects empty pattern', async () => {
    const cmd = createArchCommand();
    const { ctx, out } = buildCtx();
    await cmd.execute('ignore', ctx);
    expect(out.join('\n')).toContain('Usage');
  });
});

describe('appendIgnorePattern', () => {
  test('idempotent when pattern already present', () => {
    const initial = `[global]\nignoreImports = ["^node:.*"]\n`;
    const updated = appendIgnorePattern(initial, '^node:.*');
    expect(updated).toBe(initial);
  });

  test('adds [global] when absent', () => {
    const initial = `[[rule]]\nid = "x"\nmatch = "src/**/*.ts"\nforbid = ["src/y/**"]\n`;
    const updated = appendIgnorePattern(initial, '^node:.*');
    expect(updated).toContain('[global]');
    expect(updated).toContain('"^node:.*"');
  });
});

describe('unknown subcommand', () => {
  test('prints usage', async () => {
    const cmd = createArchCommand();
    const { ctx, out } = buildCtx();
    await cmd.execute('bogus', ctx);
    expect(out.join('\n')).toContain('Unknown /arch subcommand');
  });
});
