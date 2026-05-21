/**
 * R2 additions to ConfigManager/Config schema:
 *   - `permissions.autoApprove` (default empty array)
 *   - `context.maxTokens` (default 8192)
 *   - `context.keepAliveSeconds` (default 1800)
 *
 *   - Reading an old TOML file (no `[permissions]`, no `[context]`)
 *     should succeed, with defaults filled in.
 *   - Updating these fields via `update(...)` round-trips correctly.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';

let tmpDir = '';
let configPath = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-config-r2-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// Helper: write a minimal pre-R2 config with no permissions / context
// blocks. The Zod schema should fill defaults on read.
async function writeLegacyConfig(backend = 'ollama'): Promise<void> {
  const toml = `
[backend]
type = "${backend}"
baseUrl = "http://localhost:11434"

[model]
current = "qwen2.5-coder:32b"
available = ["qwen2.5-coder:32b"]

[onboarding]
completed = true
`;
  await fsWriteFile(configPath, toml, 'utf8');
}

describe('ConfigManager — legacy TOML forward-compat', () => {
  test('read fills defaults for missing permissions + context blocks', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);
    const cfg = mgr.read();

    expect(cfg.permissions.autoApprove).toEqual([]);
    expect(cfg.context.maxTokens).toBe(8192);
    expect(cfg.context.keepAliveSeconds).toBe(1800);

    // Other fields retained.
    expect(cfg.backend.type).toBe('ollama');
    expect(cfg.model.current).toBe('qwen2.5-coder:32b');
    expect(cfg.onboarding.completed).toBe(true);
  });

  test('read fills defaults even when only partial permissions block is present', async () => {
    const partial = `
[backend]
type = "ollama"
baseUrl = "http://localhost:11434"

[model]
current = "x"
available = []

[onboarding]
completed = false

[permissions]
autoApprove = []
`;
    await fsWriteFile(configPath, partial, 'utf8');
    const mgr = new ConfigManager(configPath);
    const cfg = mgr.read();
    expect(cfg.permissions.autoApprove).toEqual([]);
    expect(cfg.context.maxTokens).toBe(8192);
    expect(cfg.context.keepAliveSeconds).toBe(1800);
  });
});

describe('ConfigManager — permissions.autoApprove round-trip', () => {
  test('add write_file to the list and read back', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);

    const merged = mgr.update({ permissions: { autoApprove: ['write_file'] } });
    expect(merged.permissions.autoApprove).toEqual(['write_file']);

    // Re-open to confirm it was written to disk (not just in memory).
    const mgr2 = new ConfigManager(configPath);
    const reread = mgr2.read();
    expect(reread.permissions.autoApprove).toEqual(['write_file']);
  });

  test('adding run_command then removing it again works', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);
    mgr.update({ permissions: { autoApprove: ['run_command'] } });
    const stage1 = mgr.read();
    expect(stage1.permissions.autoApprove).toEqual(['run_command']);

    mgr.update({ permissions: { autoApprove: [] } });
    const stage2 = mgr.read();
    expect(stage2.permissions.autoApprove).toEqual([]);
  });

  test('rejects unknown tool name when validating merged result', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);
    let threw = false;
    try {
      // @ts-expect-error — exercising runtime rejection of invalid enum values
      mgr.update({ permissions: { autoApprove: ['bogus_tool'] } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('ConfigManager — context block round-trip', () => {
  test('update context.maxTokens and read back', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);
    mgr.update({ context: { maxTokens: 32768 } });

    const reread = new ConfigManager(configPath).read();
    expect(reread.context.maxTokens).toBe(32768);
    // keepAliveSeconds should remain at default.
    expect(reread.context.keepAliveSeconds).toBe(1800);
  });

  test('update context.keepAliveSeconds and read back', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);
    mgr.update({ context: { keepAliveSeconds: 600 } });
    const reread = new ConfigManager(configPath).read();
    expect(reread.context.keepAliveSeconds).toBe(600);
    expect(reread.context.maxTokens).toBe(8192);
  });

  test('updating both at once merges correctly', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);
    mgr.update({
      context: { maxTokens: 16384, keepAliveSeconds: 3600 },
    });
    const reread = new ConfigManager(configPath).read();
    expect(reread.context.maxTokens).toBe(16384);
    expect(reread.context.keepAliveSeconds).toBe(3600);
  });

  test('rejects negative maxTokens', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);
    let threw = false;
    try {
      mgr.update({ context: { maxTokens: -1 } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('rejects negative keepAliveSeconds', async () => {
    await writeLegacyConfig();
    const mgr = new ConfigManager(configPath);
    let threw = false;
    try {
      mgr.update({ context: { keepAliveSeconds: -5 } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
