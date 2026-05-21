import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigManager,
  ConfigReadError,
  ConfigValidationError,
  deepMerge,
} from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';
import type { Config } from '@/config/types';

let tmpDir = '';
let configPath = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-config-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('ConfigManager.write / read round-trip', () => {
  test('writes + reads a valid default config', () => {
    const mgr = new ConfigManager(configPath);
    const cfg = getDefaultConfig('ollama');
    cfg.model.current = 'llama3';
    cfg.model.available = ['llama3', 'qwen'];
    cfg.onboarding.completed = true;

    mgr.write(cfg);
    expect(mgr.exists()).toBe(true);
    const read = mgr.read();
    expect(read).toEqual(cfg);
  });
});

describe('ConfigManager.read error cases', () => {
  test('missing file throws ConfigReadError', () => {
    const mgr = new ConfigManager(configPath);
    let caught: unknown = null;
    try {
      mgr.read();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigReadError);
  });

  test('malformed TOML throws ConfigReadError', async () => {
    await fsWriteFile(configPath, '!!! not toml !!!', 'utf8');
    const mgr = new ConfigManager(configPath);
    let caught: unknown = null;
    try {
      mgr.read();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigReadError);
  });

  test('valid TOML but invalid schema throws ConfigValidationError', async () => {
    // Missing most of the required shape.
    const bad = `
[backend]
type = "not-a-real-backend"
baseUrl = "http://x"

[model]
current = "x"
available = []

[onboarding]
completed = true
`;
    await fsWriteFile(configPath, bad, 'utf8');
    const mgr = new ConfigManager(configPath);
    let caught: unknown = null;
    try {
      mgr.read();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
  });
});

describe('ConfigManager.update', () => {
  test('deep-merges partial patch', () => {
    const mgr = new ConfigManager(configPath);
    const cfg = getDefaultConfig('ollama');
    cfg.model.current = 'old';
    cfg.model.available = ['old'];
    mgr.write(cfg);

    const merged = mgr.update({ model: { current: 'new' } });
    expect(merged.model.current).toBe('new');
    // available untouched
    expect(merged.model.available).toEqual(['old']);
    // backend untouched
    expect(merged.backend.type).toBe('ollama');
  });

  test('update replaces arrays rather than merging them', () => {
    const mgr = new ConfigManager(configPath);
    const cfg = getDefaultConfig('ollama');
    cfg.model.current = 'x';
    cfg.model.available = ['a', 'b'];
    mgr.write(cfg);

    const merged = mgr.update({ model: { available: ['c'] } });
    expect(merged.model.available).toEqual(['c']);
  });
});

describe('deepMerge helper', () => {
  test('merges nested plain objects', () => {
    const base: Config = getDefaultConfig('lmstudio');
    const patch = { model: { current: 'foo' } };
    const out = deepMerge(base, patch);
    expect(out.model.current).toBe('foo');
    expect(out.model.available).toEqual(base.model.available);
  });

  test('arrays are replaced, not concatenated', () => {
    const base = { arr: [1, 2, 3], keep: true };
    const patch = { arr: [9] };
    const out = deepMerge(base, patch);
    expect(out.arr).toEqual([9]);
    expect(out.keep).toBe(true);
  });
});

// ---------- Security H2 — chmod 0600 on every write ----------

describe('security H2 — config file mode is 0600 after write', () => {
  // chmod only applies on POSIX; skip on Win32 where the mode bits are
  // synthesised by libuv and don't match the unix semantics we test.
  const isWin = process.platform === 'win32';

  test.skipIf(isWin)('write() lands the file as user-rw only (0600)', () => {
    const mgr = new ConfigManager(configPath);
    const cfg = getDefaultConfig('openai');
    cfg.model.current = 'gpt-x';
    cfg.model.available = ['gpt-x'];
    cfg.onboarding.completed = true;
    cfg.backend.apiKey = 'sk-secret-key';
    mgr.write(cfg);

    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test.skipIf(isWin)('update() preserves 0600 after subsequent write', () => {
    const mgr = new ConfigManager(configPath);
    const cfg = getDefaultConfig('ollama');
    cfg.model.current = 'm';
    cfg.model.available = ['m'];
    cfg.onboarding.completed = true;
    mgr.write(cfg);
    mgr.update({ model: { current: 'm2' } });

    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
