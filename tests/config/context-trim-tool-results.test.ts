/**
 * ROADMAP #5 — `context.trimToolResultsAfter` config field.
 *
 * Verifies:
 *   - Default value is 3.
 *   - Legacy TOML files without the field parse cleanly with the
 *     default filled in.
 *   - Update round-trips through the on-disk file.
 *   - Range validation (0..50, integer, non-negative).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import { ConfigSchema, ContextSettingsSchema } from '@/config/types';
import { DEFAULTS, getDefaultConfig } from '@/config/defaults';

let tmpDir = '';
let configPath = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-context-trim-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('Defaults — context.trimToolResultsAfter', () => {
  test('DEFAULTS.context.trimToolResultsAfter is 3', () => {
    expect(DEFAULTS.context.trimToolResultsAfter).toBe(3);
  });

  test('getDefaultConfig fills the field for both backends', () => {
    expect(getDefaultConfig('ollama').context.trimToolResultsAfter).toBe(3);
    expect(getDefaultConfig('lmstudio').context.trimToolResultsAfter).toBe(3);
  });

  test('ContextSettingsSchema parses an empty object → field defaulted', () => {
    const parsed = ContextSettingsSchema.parse(undefined);
    expect(parsed.trimToolResultsAfter).toBe(3);
  });

  test('ContextSettingsSchema accepts explicit values in range', () => {
    expect(ContextSettingsSchema.parse({ trimToolResultsAfter: 0 }).trimToolResultsAfter).toBe(0);
    expect(ContextSettingsSchema.parse({ trimToolResultsAfter: 50 }).trimToolResultsAfter).toBe(50);
  });
});

describe('Legacy TOML — context.trimToolResultsAfter forward-compat', () => {
  test('reading a config with [context] but no trimToolResultsAfter fills 3', async () => {
    const toml = `
[backend]
type = "ollama"
baseUrl = "http://localhost:11434"

[model]
current = "qwen"
available = ["qwen"]

[onboarding]
completed = true

[context]
maxTokens = 8192
keepAliveSeconds = 1800
responseTimeoutSeconds = 300
`;
    await fsWriteFile(configPath, toml, 'utf8');
    const mgr = new ConfigManager(configPath);
    const cfg = mgr.read();
    expect(cfg.context.trimToolResultsAfter).toBe(3);
  });

  test('reading a config with no [context] block at all fills 3', async () => {
    const toml = `
[backend]
type = "ollama"
baseUrl = "http://localhost:11434"

[model]
current = "qwen"
available = ["qwen"]

[onboarding]
completed = true
`;
    await fsWriteFile(configPath, toml, 'utf8');
    const mgr = new ConfigManager(configPath);
    const cfg = mgr.read();
    expect(cfg.context.trimToolResultsAfter).toBe(3);
  });
});

describe('Update — context.trimToolResultsAfter round-trip', () => {
  test('updating preserves siblings and persists to disk', () => {
    const mgr = new ConfigManager(configPath);
    const initial = getDefaultConfig('ollama');
    initial.model.current = 'm';
    initial.model.available = ['m'];
    initial.onboarding.completed = true;
    mgr.write(initial);

    const merged = mgr.update({ context: { trimToolResultsAfter: 12 } });
    expect(merged.context.trimToolResultsAfter).toBe(12);
    expect(merged.context.maxTokens).toBe(8192);
    expect(merged.context.keepAliveSeconds).toBe(1800);

    const reread = new ConfigManager(configPath).read();
    expect(reread.context.trimToolResultsAfter).toBe(12);
  });

  test('rejects negative values', () => {
    const mgr = new ConfigManager(configPath);
    const initial = getDefaultConfig('ollama');
    initial.model.current = 'm';
    initial.model.available = ['m'];
    initial.onboarding.completed = true;
    mgr.write(initial);

    expect(() =>
      mgr.update({ context: { trimToolResultsAfter: -1 } }),
    ).toThrow();
  });

  test('rejects values above 50', () => {
    const mgr = new ConfigManager(configPath);
    const initial = getDefaultConfig('ollama');
    initial.model.current = 'm';
    initial.model.available = ['m'];
    initial.onboarding.completed = true;
    mgr.write(initial);

    expect(() =>
      mgr.update({ context: { trimToolResultsAfter: 51 } }),
    ).toThrow();
  });

  test('rejects non-integer values', () => {
    const mgr = new ConfigManager(configPath);
    const initial = getDefaultConfig('ollama');
    initial.model.current = 'm';
    initial.model.available = ['m'];
    initial.onboarding.completed = true;
    mgr.write(initial);

    expect(() =>
      mgr.update({ context: { trimToolResultsAfter: 1.5 } }),
    ).toThrow();
  });
});

describe('Top-level ConfigSchema — fully-defaulted parse', () => {
  test('ConfigSchema.parse fills trimToolResultsAfter on a minimal input', () => {
    const minimal = {
      backend: { type: 'ollama' as const, baseUrl: 'http://localhost:11434' },
      model: { current: 'm', available: ['m'] },
      onboarding: { completed: true },
    };
    const cfg = ConfigSchema.parse(minimal);
    expect(cfg.context.trimToolResultsAfter).toBe(3);
  });
});
