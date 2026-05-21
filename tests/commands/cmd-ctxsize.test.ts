/**
 * /ctxsize — inspect or change max context tokens + keep-alive seconds.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import { createCtxSizeCommand } from '@/commands/cmd-ctxsize';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext } from '@/types/global';

let tmpDir = '';
let configPath = '';
let cfgMgr: ConfigManager;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-ctxsize-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
  cfgMgr = new ConfigManager(configPath);
  const cfg = getDefaultConfig('ollama');
  cfg.model.current = 'x';
  cfg.model.available = ['x'];
  cfg.onboarding.completed = true;
  cfgMgr.write(cfg);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function buildCtx(): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  const config: AppConfig = cfgMgr.read();
  const ctx: CommandContext = {
    projectRoot: tmpDir,
    sessionId: null,
    config,
    print: (t) => output.push(t),
    setScreen: () => {
      /* no-op */
    },
  };
  return { ctx, output };
}

describe('/ctxsize — print current', () => {
  test('no args prints current maxTokens and keep-alive', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Context window');
    expect(joined).toContain('8192');
    expect(joined).toContain('Keep-alive');
    expect(joined).toContain('1800s');
  });

  test('prints backend hint (ollama)', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    const joined = output.join('\n');
    // Either word — hint depends on backend; we wrote ollama.
    expect(joined).toMatch(/Ollama/);
  });
});

describe('/ctxsize <N>', () => {
  test('updates context.maxTokens', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    await cmd.execute('32768', buildCtx().ctx);
    expect(cfgMgr.read().context.maxTokens).toBe(32768);
  });

  test('rejects below range (1)', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('1', ctx);
    const joined = output.join('\n');
    expect(joined).toMatch(/out of range|range/i);
    // And no change to config.
    expect(cfgMgr.read().context.maxTokens).toBe(8192);
  });

  test('rejects non-integer', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('4.5', ctx);
    expect(output.join('\n')).toMatch(/Invalid|integer/);
  });

  test('rejects text garbage', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('pleeease', ctx);
    expect(output.join('\n')).toMatch(/Invalid|integer/);
  });

  test('rejects above ceiling', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('99999999', ctx);
    expect(output.join('\n')).toMatch(/out of range|range/i);
  });
});

describe('/ctxsize keepalive', () => {
  test('keepalive <N> updates context.keepAliveSeconds', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    await cmd.execute('keepalive 600', buildCtx().ctx);
    expect(cfgMgr.read().context.keepAliveSeconds).toBe(600);
  });

  test('keep-alive alias works', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    await cmd.execute('keep-alive 60', buildCtx().ctx);
    expect(cfgMgr.read().context.keepAliveSeconds).toBe(60);
  });

  test('keepalive with no value prints usage', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('keepalive', ctx);
    expect(output.join('\n')).toContain('Usage');
  });

  test('keepalive out of range rejected', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('keepalive 100000', ctx);
    expect(output.join('\n')).toMatch(/out of range|range/i);
  });
});
