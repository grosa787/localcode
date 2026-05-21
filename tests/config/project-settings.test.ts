/**
 * R5/R6 — per-project `.localcode/settings.json` (FIX #35).
 *
 *   - `readProjectSettings(nonexistent)` → null.
 *   - `writeProjectSettings(root, partial)` creates the file and maps
 *     camelCase → snake_case on disk.
 *   - `readProjectSettings` round-trips writes.
 *   - Forward-compat: unrelated top-level keys are preserved by
 *     `writeProjectSettings`.
 *   - `resolveGeneration` source tagging: 'global' / 'mixed' / 'project'.
 *   - Malformed JSON tolerated → null (no throw).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdir,
  rm,
  writeFile as fsWriteFile,
  readFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';

let tmpDir = '';
let projectRoot = '';
let configPath = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-proj-settings-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  projectRoot = path.join(tmpDir, 'project');
  await mkdir(projectRoot, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeManager(): ConfigManager {
  const mgr = new ConfigManager(configPath);
  const base = getDefaultConfig('ollama');
  base.model.current = 'm';
  base.model.available = ['m'];
  base.onboarding.completed = true;
  mgr.write(base);
  return mgr;
}

// ---------- readProjectSettings ----------

describe('ConfigManager.readProjectSettings', () => {
  test('returns null when no .localcode/settings.json exists', () => {
    const mgr = makeManager();
    expect(mgr.readProjectSettings(projectRoot)).toBeNull();
  });

  test('returns null when generation block is missing', async () => {
    const mgr = makeManager();
    const dir = path.join(projectRoot, '.localcode');
    await mkdir(dir, { recursive: true });
    await fsWriteFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ unrelated: { foo: 'bar' } }),
      'utf8',
    );
    expect(mgr.readProjectSettings(projectRoot)).toBeNull();
  });

  test('malformed JSON returns null (no throw)', async () => {
    const mgr = makeManager();
    const dir = path.join(projectRoot, '.localcode');
    await mkdir(dir, { recursive: true });
    await fsWriteFile(
      path.join(dir, 'settings.json'),
      '{ this is not: valid json',
      'utf8',
    );
    let threw = false;
    let result: unknown;
    try {
      result = mgr.readProjectSettings(projectRoot);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeNull();
  });

  test('snake_case wire keys are mapped to camelCase', async () => {
    const mgr = makeManager();
    const dir = path.join(projectRoot, '.localcode');
    await mkdir(dir, { recursive: true });
    await fsWriteFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        generation: {
          temperature: 0.7,
          top_p: 0.85,
          repeat_penalty: 1.2,
          max_tokens: 1024,
        },
      }),
      'utf8',
    );
    const out = mgr.readProjectSettings(projectRoot);
    expect(out).not.toBeNull();
    expect(out!.temperature).toBe(0.7);
    expect(out!.topP).toBe(0.85);
    expect(out!.repeatPenalty).toBe(1.2);
    expect(out!.maxTokens).toBe(1024);
  });

  test('partial fields → only the present ones are returned', async () => {
    const mgr = makeManager();
    const dir = path.join(projectRoot, '.localcode');
    await mkdir(dir, { recursive: true });
    await fsWriteFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ generation: { temperature: 0.5 } }),
      'utf8',
    );
    const out = mgr.readProjectSettings(projectRoot);
    expect(out).not.toBeNull();
    expect(out!.temperature).toBe(0.5);
    expect(out!.topP).toBeUndefined();
    expect(out!.repeatPenalty).toBeUndefined();
    expect(out!.maxTokens).toBeUndefined();
  });
});

// ---------- writeProjectSettings ----------

describe('ConfigManager.writeProjectSettings', () => {
  test('creates the file at <root>/.localcode/settings.json', async () => {
    const mgr = makeManager();
    mgr.writeProjectSettings(projectRoot, { temperature: 0.5 });
    const p = path.join(projectRoot, '.localcode', 'settings.json');
    const text = await readFile(p, 'utf8');
    const parsed = JSON.parse(text) as {
      generation?: Record<string, number>;
    };
    expect(parsed.generation).toBeDefined();
    expect(parsed.generation!.temperature).toBe(0.5);
  });

  test('on-disk file uses snake_case keys (top_p, repeat_penalty, max_tokens)', async () => {
    const mgr = makeManager();
    mgr.writeProjectSettings(projectRoot, {
      temperature: 0.4,
      topP: 0.7,
      repeatPenalty: 1.05,
      maxTokens: 512,
    });
    const p = path.join(projectRoot, '.localcode', 'settings.json');
    const text = await readFile(p, 'utf8');
    expect(text).toContain('"temperature"');
    expect(text).toContain('"top_p"');
    expect(text).toContain('"repeat_penalty"');
    expect(text).toContain('"max_tokens"');
    // No camelCase leak.
    expect(text).not.toContain('topP');
    expect(text).not.toContain('repeatPenalty');
    expect(text).not.toContain('maxTokens');
  });

  test('readProjectSettings round-trips the writes (camelCase → snake_case → camelCase)', () => {
    const mgr = makeManager();
    mgr.writeProjectSettings(projectRoot, { temperature: 0.5 });
    const out = mgr.readProjectSettings(projectRoot);
    expect(out).toEqual({ temperature: 0.5 });
  });

  test('preserves unrelated top-level keys (forward-compat)', async () => {
    const mgr = makeManager();
    const dir = path.join(projectRoot, '.localcode');
    await mkdir(dir, { recursive: true });
    await fsWriteFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        future_section: { x: 1 },
        another: 'yes',
        generation: { temperature: 0.1 },
      }),
      'utf8',
    );

    mgr.writeProjectSettings(projectRoot, { topP: 0.5 });
    const text = await readFile(
      path.join(dir, 'settings.json'),
      'utf8',
    );
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.future_section).toEqual({ x: 1 });
    expect(parsed.another).toBe('yes');

    const gen = parsed.generation as Record<string, unknown>;
    // top_p got merged in; existing temperature preserved.
    expect(gen.top_p).toBe(0.5);
    expect(gen.temperature).toBe(0.1);
  });

  test('subsequent partial writes merge into existing generation block', () => {
    const mgr = makeManager();
    mgr.writeProjectSettings(projectRoot, { temperature: 0.5 });
    mgr.writeProjectSettings(projectRoot, { repeatPenalty: 1.3 });
    const out = mgr.readProjectSettings(projectRoot);
    expect(out).toEqual({ temperature: 0.5, repeatPenalty: 1.3 });
  });
});

// ---------- resolveGeneration ----------

describe('ConfigManager.resolveGeneration', () => {
  test('no project settings → source = "global", values from global config', () => {
    const mgr = makeManager();
    const r = mgr.resolveGeneration(projectRoot);
    expect(r.source).toBe('global');
    expect(r.generation.temperature).toBe(0.2);
    expect(r.generation.topP).toBe(0.9);
    expect(r.generation.repeatPenalty).toBe(1.1);
    expect(r.generation.maxTokens).toBe(4096);
  });

  test('project overrides 2 of 4 fields → source = "mixed"', () => {
    const mgr = makeManager();
    mgr.writeProjectSettings(projectRoot, {
      temperature: 0.7,
      topP: 0.5,
    });
    const r = mgr.resolveGeneration(projectRoot);
    expect(r.source).toBe('mixed');
    // Project values
    expect(r.generation.temperature).toBe(0.7);
    expect(r.generation.topP).toBe(0.5);
    // Global fall-throughs
    expect(r.generation.repeatPenalty).toBe(1.1);
    expect(r.generation.maxTokens).toBe(4096);
  });

  test('project overrides all 4 fields → source = "project"', () => {
    const mgr = makeManager();
    mgr.writeProjectSettings(projectRoot, {
      temperature: 0.55,
      topP: 0.5,
      repeatPenalty: 1.2,
      maxTokens: 1234,
    });
    const r = mgr.resolveGeneration(projectRoot);
    expect(r.source).toBe('project');
    expect(r.generation.temperature).toBe(0.55);
    expect(r.generation.topP).toBe(0.5);
    expect(r.generation.repeatPenalty).toBe(1.2);
    expect(r.generation.maxTokens).toBe(1234);
  });

  test('project overrides 1 of 4 fields → source = "mixed"', () => {
    const mgr = makeManager();
    mgr.writeProjectSettings(projectRoot, { maxTokens: 2048 });
    const r = mgr.resolveGeneration(projectRoot);
    expect(r.source).toBe('mixed');
    expect(r.generation.maxTokens).toBe(2048);
    expect(r.generation.temperature).toBe(0.2);
    expect(r.generation.topP).toBe(0.9);
    expect(r.generation.repeatPenalty).toBe(1.1);
  });

  test('malformed project file → falls back silently to global', async () => {
    const mgr = makeManager();
    const dir = path.join(projectRoot, '.localcode');
    await mkdir(dir, { recursive: true });
    await fsWriteFile(path.join(dir, 'settings.json'), '{ broken', 'utf8');
    const r = mgr.resolveGeneration(projectRoot);
    expect(r.source).toBe('global');
    expect(r.generation.temperature).toBe(0.2);
  });
});
