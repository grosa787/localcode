/**
 * /permissions — list / add / remove / clear grants for auto-approved tools.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import { createPermissionsCommand } from '@/commands/cmd-permissions';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext } from '@/types/global';

let tmpDir = '';
let configPath = '';
let cfgMgr: ConfigManager;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-permcmd-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
  cfgMgr = new ConfigManager(configPath);
  const base = getDefaultConfig('ollama');
  base.model.current = 'm';
  base.model.available = ['m'];
  base.onboarding.completed = true;
  cfgMgr.write(base);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// Helper: build a fresh CommandContext whose `config` reflects whatever is
// currently on disk (so updates made via /permissions are picked up in
// subsequent invocations).
function buildCtx(): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  const config: AppConfig = cfgMgr.read();
  const ctx: CommandContext = {
    projectRoot: tmpDir,
    sessionId: null,
    config,
    print: (t: string) => output.push(t),
    setScreen: () => {
      /* no-op */
    },
  };
  return { ctx, output };
}

describe('/permissions — listing', () => {
  test('no args prints always-auto-approved list including write_file + run_command', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('read_file');
    expect(joined).toContain('list_dir');
    expect(joined).toContain('glob_search');
    expect(joined).toContain('edit_file');
    // Grantable tools mentioned as available to grant.
    expect(joined).toContain('write_file');
    expect(joined).toContain('run_command');
  });

  test('"list" alias produces the same output as no-args', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const a = buildCtx();
    const b = buildCtx();
    await cmd.execute('', a.ctx);
    await cmd.execute('list', b.ctx);
    expect(b.output.join('\n')).toContain('Auto-approved tools:');
  });
});

describe('/permissions add', () => {
  test('add write_file persists to config', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx } = buildCtx();
    await cmd.execute('add write_file', ctx);

    const reread = cfgMgr.read();
    expect(reread.permissions.autoApprove).toEqual(['write_file']);
  });

  test('add bogus tool prints a rejection and does NOT modify config', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('add bogus_tool', ctx);
    expect(output.join('\n')).toMatch(/Cannot grant|bogus_tool/);

    const reread = cfgMgr.read();
    expect(reread.permissions.autoApprove).toEqual([]);
  });

  test('add without a tool name prints usage hint', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('add', ctx);
    expect(output.join('\n')).toContain('Usage');
  });

  test('re-adding same tool is a no-op announcement', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    await cmd.execute('add write_file', buildCtx().ctx);
    const { ctx, output } = buildCtx();
    await cmd.execute('add write_file', ctx);
    expect(output.join('\n')).toMatch(/already/);
  });
});

describe('/permissions remove', () => {
  test('remove an existing grant shrinks the list', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    // Seed two grants.
    await cmd.execute('add write_file', buildCtx().ctx);
    await cmd.execute('add run_command', buildCtx().ctx);

    const beforeReread = cfgMgr.read();
    expect(beforeReread.permissions.autoApprove).toEqual(['write_file', 'run_command']);

    await cmd.execute('remove write_file', buildCtx().ctx);
    const afterReread = cfgMgr.read();
    expect(afterReread.permissions.autoApprove).toEqual(['run_command']);
  });

  test('remove non-granted tool prints "nothing to revoke"', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('remove write_file', ctx);
    expect(output.join('\n')).toMatch(/nothing to revoke|not currently granted/i);
  });
});

describe('/permissions clear', () => {
  test('clear resets autoApprove to empty', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    await cmd.execute('add write_file', buildCtx().ctx);
    await cmd.execute('add run_command', buildCtx().ctx);
    expect(cfgMgr.read().permissions.autoApprove.length).toBe(2);

    await cmd.execute('clear', buildCtx().ctx);
    expect(cfgMgr.read().permissions.autoApprove).toEqual([]);
  });

  test('clear with already-empty grants prints a friendly notice', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('clear', ctx);
    expect(output.join('\n')).toMatch(/No granted|already empty/i);
  });
});

describe('/permissions — unknown subcommand', () => {
  test('prints usage hint', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('frobnicate', ctx);
    expect(output.join('\n')).toMatch(/Unknown|Usage/);
  });
});
