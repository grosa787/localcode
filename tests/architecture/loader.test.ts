/**
 * Loader tests for `.localcode/arch.toml`.
 *
 * Covers:
 *   - Valid TOML → typed ArchConfig.
 *   - Missing file → null.
 *   - Malformed TOML → ArchConfigError.
 *   - Invalid schema (rule without `forbid` or `allowAll`) → ArchConfigError.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArchConfigError, loadArchConfig, parseArchConfigSource } from '@/architecture';

let projectRoot = '';

beforeEach(async () => {
  projectRoot = path.join(os.tmpdir(), `arch-loader-${crypto.randomUUID()}`);
  await mkdir(path.join(projectRoot, '.localcode'), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe('loadArchConfig', () => {
  test('returns null when arch.toml is absent', () => {
    expect(loadArchConfig(projectRoot)).toBeNull();
  });

  test('parses a well-formed config with a single rule', async () => {
    const toml = `
[[rule]]
id = "ui-no-llm"
description = "UI must not import LLM internals"
match = "src/ui/**/*.{ts,tsx}"
forbid = ["src/llm/**"]

[global]
ignoreImports = ["^node:.*"]
`;
    await writeFile(path.join(projectRoot, '.localcode', 'arch.toml'), toml);
    const config = loadArchConfig(projectRoot);
    expect(config).not.toBeNull();
    expect(config?.rule.length).toBe(1);
    expect(config?.rule[0]?.id).toBe('ui-no-llm');
    expect(config?.rule[0]?.forbid).toEqual(['src/llm/**']);
    expect(config?.global.ignoreImports).toEqual(['^node:.*']);
  });

  test('parses allowAll rule without forbid', async () => {
    const toml = `
[[rule]]
id = "tests-anywhere"
match = "tests/**/*.ts"
allowAll = true
`;
    await writeFile(path.join(projectRoot, '.localcode', 'arch.toml'), toml);
    const config = loadArchConfig(projectRoot);
    expect(config?.rule[0]?.allowAll).toBe(true);
  });

  test('fills defaults for missing [global]', async () => {
    const toml = `
[[rule]]
id = "x"
match = "src/x/**/*.ts"
forbid = ["src/y/**"]
`;
    await writeFile(path.join(projectRoot, '.localcode', 'arch.toml'), toml);
    const config = loadArchConfig(projectRoot);
    expect(config?.global.ignoreImports).toEqual([]);
  });

  test('throws ArchConfigError on malformed TOML', async () => {
    await writeFile(
      path.join(projectRoot, '.localcode', 'arch.toml'),
      '[[rule\nid = "broken"',
    );
    expect(() => loadArchConfig(projectRoot)).toThrow(ArchConfigError);
  });

  test('throws ArchConfigError when rule has neither forbid nor allowAll', () => {
    const toml = `
[[rule]]
id = "bad"
match = "src/bad/**"
`;
    expect(() => parseArchConfigSource(toml, 'inline')).toThrow(ArchConfigError);
  });

  test('throws ArchConfigError when rule.id is empty', () => {
    const toml = `
[[rule]]
id = ""
match = "src/**/*.ts"
forbid = ["src/x/**"]
`;
    expect(() => parseArchConfigSource(toml, 'inline')).toThrow(ArchConfigError);
  });
});
