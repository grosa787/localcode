/**
 * R5/R6 — `[generation]` config block (FIX #35).
 *
 *   - The default config carries sensible sampling defaults.
 *   - Old TOML files that pre-date the section parse cleanly with
 *     defaults filled in by the Zod schema.
 *   - `update({ generation: { ... } })` deep-merges (other fields
 *     preserved) and writes successfully.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';

let tmpDir = '';
let configPath = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-cfg-gen-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('Default config — generation defaults', () => {
  test('getDefaultConfig fills in temperature/topP/repeatPenalty/maxTokens', () => {
    const cfg = getDefaultConfig('ollama');
    expect(cfg.generation).toBeDefined();
    expect(cfg.generation.temperature).toBe(0.2);
    expect(cfg.generation.topP).toBe(0.9);
    expect(cfg.generation.repeatPenalty).toBe(1.1);
    expect(cfg.generation.maxTokens).toBe(4096);
  });

  test('LM Studio backend has same generation defaults', () => {
    const cfg = getDefaultConfig('lmstudio');
    expect(cfg.generation.temperature).toBe(0.2);
    expect(cfg.generation.topP).toBe(0.9);
    expect(cfg.generation.repeatPenalty).toBe(1.1);
    expect(cfg.generation.maxTokens).toBe(4096);
  });
});

describe('ConfigManager.read — back-compat with old TOMLs', () => {
  test('TOML without [generation] block parses cleanly with defaults', async () => {
    // Hand-crafted older config that lacks the generation section
    // (every other R3/R4 field present).
    const oldToml = `
[backend]
type = "ollama"
baseUrl = "http://localhost:11434"

[model]
current = "llama3"
available = ["llama3"]

[onboarding]
completed = true

[permissions]
autoApprove = []

[context]
maxTokens = 8192
keepAliveSeconds = 1800

[sound]
enabled = false
onCompletion = true
onApproval = true
onError = true
volume = 0.5
completionFile = ""
approvalFile = ""
errorFile = ""
`;
    await fsWriteFile(configPath, oldToml, 'utf8');
    // The TOML above uses "" for nullable file fields — the actual schema
    // accepts string|null. Strip those rows to keep this minimal.
    const minimal = `
[backend]
type = "ollama"
baseUrl = "http://localhost:11434"

[model]
current = "llama3"
available = ["llama3"]

[onboarding]
completed = true

[permissions]
autoApprove = []

[context]
maxTokens = 8192
keepAliveSeconds = 1800
`;
    await fsWriteFile(configPath, minimal, 'utf8');

    const mgr = new ConfigManager(configPath);
    const cfg = mgr.read();
    expect(cfg.generation).toBeDefined();
    expect(cfg.generation.temperature).toBe(0.2);
    expect(cfg.generation.topP).toBe(0.9);
    expect(cfg.generation.repeatPenalty).toBe(1.1);
    expect(cfg.generation.maxTokens).toBe(4096);
  });

  test('partial [generation] block merges field-by-field with defaults', async () => {
    const partial = `
[backend]
type = "ollama"
baseUrl = "http://localhost:11434"

[model]
current = "llama3"
available = ["llama3"]

[onboarding]
completed = true

[permissions]
autoApprove = []

[context]
maxTokens = 8192
keepAliveSeconds = 1800

[generation]
temperature = 0.7
`;
    await fsWriteFile(configPath, partial, 'utf8');
    const mgr = new ConfigManager(configPath);
    const cfg = mgr.read();
    expect(cfg.generation.temperature).toBe(0.7);
    // Other three fields fall through to defaults.
    expect(cfg.generation.topP).toBe(0.9);
    expect(cfg.generation.repeatPenalty).toBe(1.1);
    expect(cfg.generation.maxTokens).toBe(4096);
  });
});

describe('ConfigManager.update — deep-merge of generation section', () => {
  test('updating one generation field preserves the others', () => {
    const mgr = new ConfigManager(configPath);
    const initial = getDefaultConfig('ollama');
    initial.model.current = 'm';
    initial.model.available = ['m'];
    initial.onboarding.completed = true;
    mgr.write(initial);

    const merged = mgr.update({ generation: { temperature: 0.7 } });
    expect(merged.generation.temperature).toBe(0.7);
    // Other generation knobs unchanged.
    expect(merged.generation.topP).toBe(0.9);
    expect(merged.generation.repeatPenalty).toBe(1.1);
    expect(merged.generation.maxTokens).toBe(4096);

    // Other top-level sections preserved.
    expect(merged.backend.type).toBe('ollama');
    expect(merged.model.current).toBe('m');
    expect(merged.context.maxTokens).toBe(8192);

    // Round-trip the file: re-reading must produce the same merged
    // result so the patch was actually persisted, not just returned.
    const reread = mgr.read();
    expect(reread.generation.temperature).toBe(0.7);
    expect(reread.generation.topP).toBe(0.9);
  });

  test('updating multiple generation fields works in a single call', () => {
    const mgr = new ConfigManager(configPath);
    const initial = getDefaultConfig('ollama');
    initial.model.current = 'm';
    initial.model.available = ['m'];
    initial.onboarding.completed = true;
    mgr.write(initial);

    const merged = mgr.update({
      generation: { temperature: 0.55, topP: 0.5, maxTokens: 8192 },
    });
    expect(merged.generation.temperature).toBe(0.55);
    expect(merged.generation.topP).toBe(0.5);
    expect(merged.generation.maxTokens).toBe(8192);
    // repeatPenalty was not patched → preserved from defaults.
    expect(merged.generation.repeatPenalty).toBe(1.1);
  });

  test('written TOML on disk includes the generation section', async () => {
    const mgr = new ConfigManager(configPath);
    const initial = getDefaultConfig('lmstudio');
    initial.model.current = 'lm';
    initial.model.available = ['lm'];
    initial.onboarding.completed = true;
    mgr.write(initial);

    const text = await readFile(configPath, 'utf8');
    expect(text).toContain('[generation]');
    expect(text).toContain('temperature');
    // Number 0.2 is fine to look for since Default writes carry it.
    expect(text).toMatch(/temperature\s*=\s*0\.2/);
  });
});
