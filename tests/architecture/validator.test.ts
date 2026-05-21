/**
 * Validator tests — exercise the layering matrix:
 *   - Matched file importing forbidden target → violation
 *   - Matched file importing allowed target → clean
 *   - Unmatched file → clean (no rule applies)
 *   - allowAll: true → clean even when forbidden pattern matches
 *   - [global].ignoreImports → exclude
 *   - `**` wildcards work
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _resetTsconfigCache,
  parseArchConfigSource,
  validateFile,
  validateProject,
} from '@/architecture';

let projectRoot = '';

const SAMPLE_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      baseUrl: '.',
      paths: { '@/*': ['./src/*'] },
    },
  },
  null,
  2,
);

beforeEach(async () => {
  projectRoot = path.join(os.tmpdir(), `arch-validator-${crypto.randomUUID()}`);
  await mkdir(path.join(projectRoot, 'src', 'ui'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src', 'llm'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src', 'tools'), { recursive: true });
  await mkdir(path.join(projectRoot, 'src', 'types'), { recursive: true });
  await mkdir(path.join(projectRoot, 'tests', 'integration'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'llm', 'adapter.ts'), 'export const x = 1;');
  await writeFile(path.join(projectRoot, 'src', 'ui', 'helper.ts'), 'export const h = 1;');
  await writeFile(path.join(projectRoot, 'src', 'tools', 'reader.ts'), 'export const r = 1;');
  await writeFile(path.join(projectRoot, 'src', 'types', 'global.ts'), 'export const t = 1;');
  await writeFile(path.join(projectRoot, 'tsconfig.json'), SAMPLE_TSCONFIG);
  _resetTsconfigCache();
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  _resetTsconfigCache();
});

function loadConfig(toml: string) {
  return parseArchConfigSource(toml, 'inline-test');
}

describe('validateFile', () => {
  test('forbidden cross-layer import produces a violation', async () => {
    const config = loadConfig(`
[[rule]]
id = "ui-no-llm"
description = "UI must not import LLM"
match = "src/ui/**/*.ts"
forbid = ["src/llm/**"]
`);
    const filePath = path.join(projectRoot, 'src', 'ui', 'main.ts');
    await writeFile(filePath, `import { x } from '@/llm/adapter';`);
    const violations = validateFile(filePath, config, projectRoot);
    expect(violations.length).toBe(1);
    expect(violations[0]?.ruleId).toBe('ui-no-llm');
    expect(violations[0]?.importPath).toBe('@/llm/adapter');
    expect(violations[0]?.resolvedTarget).toBe('src/llm/adapter.ts');
  });

  test('allowed import inside the same layer is clean', async () => {
    const config = loadConfig(`
[[rule]]
id = "ui-no-llm"
match = "src/ui/**/*.ts"
forbid = ["src/llm/**"]
`);
    const filePath = path.join(projectRoot, 'src', 'ui', 'consumer.ts');
    await writeFile(filePath, `import { h } from './helper';`);
    const violations = validateFile(filePath, config, projectRoot);
    expect(violations).toEqual([]);
  });

  test('file outside any rule.match is clean', async () => {
    const config = loadConfig(`
[[rule]]
id = "ui-no-llm"
match = "src/ui/**/*.ts"
forbid = ["src/llm/**"]
`);
    const filePath = path.join(projectRoot, 'src', 'tools', 'reader.ts');
    await writeFile(filePath, `import { x } from '@/llm/adapter';`);
    const violations = validateFile(filePath, config, projectRoot);
    expect(violations).toEqual([]);
  });

  test('allowAll rule overrides every forbid', async () => {
    const config = loadConfig(`
[[rule]]
id = "tests-anywhere"
match = "tests/**/*.ts"
allowAll = true
`);
    const filePath = path.join(projectRoot, 'tests', 'integration', 'big.test.ts');
    await writeFile(filePath, `import { x } from '@/llm/adapter';\nimport { h } from '@/ui/helper';`);
    const violations = validateFile(filePath, config, projectRoot);
    expect(violations).toEqual([]);
  });

  test('[global].ignoreImports excludes matching specifiers', async () => {
    const config = loadConfig(`
[[rule]]
id = "no-types"
match = "src/ui/**/*.ts"
forbid = ["src/types/.*", "@/types/.*"]

[global]
ignoreImports = ["^@/types/.*"]
`);
    const filePath = path.join(projectRoot, 'src', 'ui', 'consumer.ts');
    await writeFile(filePath, `import type T from '@/types/global';`);
    const violations = validateFile(filePath, config, projectRoot);
    expect(violations).toEqual([]);
  });

  test('** wildcard matches nested directories', async () => {
    const config = loadConfig(`
[[rule]]
id = "deep"
match = "src/**/*.ts"
forbid = ["src/llm/**"]
`);
    await mkdir(path.join(projectRoot, 'src', 'ui', 'deep', 'nested'), { recursive: true });
    const filePath = path.join(projectRoot, 'src', 'ui', 'deep', 'nested', 'thing.ts');
    await writeFile(filePath, `import { x } from '@/llm/adapter';`);
    const violations = validateFile(filePath, config, projectRoot);
    expect(violations.length).toBe(1);
    expect(violations[0]?.sourceFile).toBe('src/ui/deep/nested/thing.ts');
  });

  test('precomputed content path bypasses disk read', () => {
    const config = loadConfig(`
[[rule]]
id = "ui-no-llm"
match = "src/ui/**/*.ts"
forbid = ["src/llm/**"]
`);
    const inMemoryPath = path.join(projectRoot, 'src', 'ui', 'pending.ts');
    const violations = validateFile(
      inMemoryPath,
      config,
      projectRoot,
      `import { x } from '@/llm/adapter';`,
    );
    expect(violations.length).toBe(1);
  });

  test('multiple rules can match the same file', async () => {
    const config = loadConfig(`
[[rule]]
id = "ui-no-llm"
match = "src/ui/**/*.ts"
forbid = ["src/llm/**"]

[[rule]]
id = "ui-no-tools"
match = "src/ui/**/*.ts"
forbid = ["src/tools/**"]
`);
    const filePath = path.join(projectRoot, 'src', 'ui', 'main.ts');
    await writeFile(filePath, `import { x } from '@/llm/adapter';\nimport { r } from '@/tools/reader';`);
    const violations = validateFile(filePath, config, projectRoot);
    expect(violations.length).toBe(2);
    const ids = violations.map((v) => v.ruleId).sort();
    expect(ids).toEqual(['ui-no-llm', 'ui-no-tools']);
  });

  test('severity defaults to error and can be overridden to warn', () => {
    const config = loadConfig(`
[[rule]]
id = "soft"
match = "src/ui/**/*.ts"
forbid = ["src/llm/**"]
severity = "warn"
`);
    const violations = validateFile(
      path.join(projectRoot, 'src', 'ui', 'main.ts'),
      config,
      projectRoot,
      `import { x } from '@/llm/adapter';`,
    );
    expect(violations[0]?.severity).toBe('warn');
  });
});

describe('validateProject', () => {
  test('sweeps every matching file deterministically', async () => {
    const config = loadConfig(`
[[rule]]
id = "ui-no-llm"
match = "src/ui/**/*.ts"
forbid = ["src/llm/**"]
`);
    await writeFile(
      path.join(projectRoot, 'src', 'ui', 'a.ts'),
      `import { x } from '@/llm/adapter';`,
    );
    await writeFile(
      path.join(projectRoot, 'src', 'ui', 'b.ts'),
      `export const ok = 1;`,
    );
    const result = await validateProject(config, projectRoot);
    // helper.ts (from beforeEach) + a.ts + b.ts under src/ui.
    expect(result.filesChecked).toBe(3);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0]?.sourceFile).toBe('src/ui/a.ts');
  });

  test('zero rules → zero files checked', async () => {
    const config = loadConfig(`
[global]
ignoreImports = []
`);
    const result = await validateProject(config, projectRoot);
    expect(result.filesChecked).toBe(0);
    expect(result.violations).toEqual([]);
  });
});

describe('performance', () => {
  test('validateFile stays under 50ms per call on a moderate file', async () => {
    const config = loadConfig(`
[[rule]]
id = "ui-no-llm"
match = "src/ui/**/*.ts"
forbid = ["src/llm/**"]
`);
    const filePath = path.join(projectRoot, 'src', 'ui', 'perf.ts');
    // ~50 imports + body to simulate a real source file.
    const body = Array.from({ length: 50 }, (_, i) => `import x${i} from './helper';`).join('\n');
    await writeFile(filePath, body + '\nexport const x = 1;\n');
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) {
      validateFile(filePath, config, projectRoot);
    }
    const elapsed = (performance.now() - t0) / 5;
    expect(elapsed).toBeLessThan(50);
  });
});
