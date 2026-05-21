/**
 * R5 additions to ConfigManager / Config schema:
 *   - `[sound]` block with `enabled`, `onCompletion`, `onApproval`, `onError`,
 *     `volume`, `completionFile`, `approvalFile`, `errorFile`.
 *   - Each field carries a default; the entire block carries a default so
 *     legacy configs without `[sound]` parse cleanly.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';

let tmpDir = '';
let configPath = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-sound-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeLegacyConfig(): Promise<void> {
  // Pre-R5 TOML — no [sound] block.
  const toml = `
[backend]
type = "ollama"
baseUrl = "http://localhost:11434"

[model]
current = "qwen2.5-coder:32b"
available = ["qwen2.5-coder:32b"]

[onboarding]
completed = true
`;
  await fsWriteFile(configPath, toml, 'utf8');
}

describe('Config — fresh defaults for [sound]', () => {
  test('getDefaultConfig produces sound block with enabled:false, volume:0.5, all files null', () => {
    const cfg = getDefaultConfig('ollama');
    expect(cfg.sound.enabled).toBe(false);
    expect(cfg.sound.volume).toBe(0.5);
    expect(cfg.sound.completionFile).toBeNull();
    expect(cfg.sound.approvalFile).toBeNull();
    expect(cfg.sound.errorFile).toBeNull();
    // Per-event toggles are pre-armed so flipping enabled does something.
    expect(cfg.sound.onCompletion).toBe(true);
    expect(cfg.sound.onApproval).toBe(true);
    expect(cfg.sound.onError).toBe(true);
  });

  test('writing then reading the default config round-trips the sound block', () => {
    const mgr = new ConfigManager(configPath);
    mgr.write(getDefaultConfig('ollama'));
    const reread = mgr.read();
    expect(reread.sound.enabled).toBe(false);
    expect(reread.sound.volume).toBe(0.5);
    expect(reread.sound.completionFile).toBeNull();
    expect(reread.sound.approvalFile).toBeNull();
    expect(reread.sound.errorFile).toBeNull();
    expect(reread.sound.onCompletion).toBe(true);
    expect(reread.sound.onApproval).toBe(true);
    expect(reread.sound.onError).toBe(true);
  });
});

describe('Config — legacy TOML migration for [sound]', () => {
  test('reading legacy TOML without [sound] fills defaults', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);
    const cfg = mgr.read();
    expect(cfg.sound).toBeDefined();
    expect(cfg.sound.enabled).toBe(false);
    expect(cfg.sound.volume).toBe(0.5);
    expect(cfg.sound.completionFile).toBeNull();
    expect(cfg.sound.approvalFile).toBeNull();
    expect(cfg.sound.errorFile).toBeNull();
    expect(cfg.sound.onCompletion).toBe(true);
    expect(cfg.sound.onApproval).toBe(true);
    expect(cfg.sound.onError).toBe(true);
  });

  test('reading legacy TOML preserves other config sections', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);
    const cfg = mgr.read();
    expect(cfg.backend.type).toBe('ollama');
    expect(cfg.model.current).toBe('qwen2.5-coder:32b');
    expect(cfg.onboarding.completed).toBe(true);
  });

  test('partial [sound] block fills missing fields with defaults', async () => {
    const partial = `
[backend]
type = "ollama"
baseUrl = "http://localhost:11434"

[model]
current = "x"
available = ["x"]

[onboarding]
completed = true

[sound]
enabled = true
`;
    await fsWriteFile(configPath, partial, 'utf8');
    const mgr = new ConfigManager(configPath);
    const cfg = mgr.read();
    // Field that was set:
    expect(cfg.sound.enabled).toBe(true);
    // Fields filled by defaults:
    expect(cfg.sound.volume).toBe(0.5);
    expect(cfg.sound.completionFile).toBeNull();
    expect(cfg.sound.onCompletion).toBe(true);
    expect(cfg.sound.onApproval).toBe(true);
    expect(cfg.sound.onError).toBe(true);
  });
});

describe('Config — deep-merge update for [sound]', () => {
  test('updating sound.enabled preserves all sibling fields', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);
    // First read seeds the defaults.
    const before = mgr.read();
    expect(before.sound.volume).toBe(0.5);

    const merged = mgr.update({ sound: { enabled: true } });
    expect(merged.sound.enabled).toBe(true);
    expect(merged.sound.volume).toBe(0.5);
    expect(merged.sound.completionFile).toBeNull();
    expect(merged.sound.onCompletion).toBe(true);

    // Persisted to disk.
    const reread = new ConfigManager(configPath).read();
    expect(reread.sound.enabled).toBe(true);
    expect(reread.sound.volume).toBe(0.5);
  });

  test('updating sound.volume preserves enabled + per-event toggles', async () => {
    const mgr = new ConfigManager(configPath);
    mgr.write(getDefaultConfig('ollama'));
    mgr.update({ sound: { enabled: true, onApproval: false } });
    const merged = mgr.update({ sound: { volume: 0.25 } });
    expect(merged.sound.volume).toBe(0.25);
    expect(merged.sound.enabled).toBe(true);
    expect(merged.sound.onApproval).toBe(false);
    expect(merged.sound.onCompletion).toBe(true);
    expect(merged.sound.onError).toBe(true);
  });

  test('updating sound.completionFile sets a path; null clears it', async () => {
    const mgr = new ConfigManager(configPath);
    mgr.write(getDefaultConfig('ollama'));
    const customPath = '/tmp/ding.wav';
    const merged = mgr.update({ sound: { completionFile: customPath } });
    expect(merged.sound.completionFile).toBe(customPath);
    // Other file paths still null.
    expect(merged.sound.approvalFile).toBeNull();
    expect(merged.sound.errorFile).toBeNull();

    const cleared = mgr.update({ sound: { completionFile: null } });
    expect(cleared.sound.completionFile).toBeNull();
  });

  test('rejects volume out of range (> 1)', async () => {
    const mgr = new ConfigManager(configPath);
    mgr.write(getDefaultConfig('ollama'));
    let threw = false;
    try {
      mgr.update({ sound: { volume: 1.5 } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('rejects volume out of range (< 0)', async () => {
    const mgr = new ConfigManager(configPath);
    mgr.write(getDefaultConfig('ollama'));
    let threw = false;
    try {
      mgr.update({ sound: { volume: -0.1 } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('boundary volumes 0 and 1 are accepted', async () => {
    const mgr = new ConfigManager(configPath);
    mgr.write(getDefaultConfig('ollama'));
    const v0 = mgr.update({ sound: { volume: 0 } });
    expect(v0.sound.volume).toBe(0);
    const v1 = mgr.update({ sound: { volume: 1 } });
    expect(v1.sound.volume).toBe(1);
  });
});
