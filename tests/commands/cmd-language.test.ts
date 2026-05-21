/**
 * /language (alias /lang) — UI language switching.
 *
 * Covers:
 *   - `/language en` persists locale to config.
 *   - `/language ru` persists locale to config.
 *   - `/language` no-args opens the picker via the injected callback.
 *   - `/language xx` rejects unknown locales without mutating config.
 *   - `/language en` while already on `en` is a no-op echo.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigManager } from '@/config/config-manager';
import { createLanguageCommand } from '@/commands/cmd-language';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext } from '@/types/global';

let tmpDir = '';
let configPath = '';
let cfgMgr: ConfigManager;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-langcmd-${crypto.randomUUID()}`);
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

describe('/language — setting a locale', () => {
  test('/language en persists locale=en to config', async () => {
    const cmd = createLanguageCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('en', ctx);
    const reread = cfgMgr.read();
    expect(reread.locale).toBe('en');
    expect(output.join('\n')).toContain('English');
  });

  test('/language ru persists locale=ru to config', async () => {
    const cmd = createLanguageCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('ru', ctx);
    const reread = cfgMgr.read();
    expect(reread.locale).toBe('ru');
    expect(output.join('\n')).toContain('Русский');
  });

  test('case-insensitive — /language EN works', async () => {
    const cmd = createLanguageCommand({ configManager: cfgMgr });
    const { ctx } = buildCtx();
    await cmd.execute('EN', ctx);
    const reread = cfgMgr.read();
    expect(reread.locale).toBe('en');
  });

  test('switching back and forth round-trips', async () => {
    const cmd = createLanguageCommand({ configManager: cfgMgr });
    await cmd.execute('ru', buildCtx().ctx);
    expect(cfgMgr.read().locale).toBe('ru');
    await cmd.execute('en', buildCtx().ctx);
    expect(cfgMgr.read().locale).toBe('en');
  });
});

describe('/language — error paths', () => {
  test('/language xx rejects unknown locale without modifying config', async () => {
    const cmd = createLanguageCommand({ configManager: cfgMgr });
    const before = cfgMgr.read();
    const { ctx, output } = buildCtx();
    await cmd.execute('xx', ctx);
    expect(output.join('\n').toLowerCase()).toContain('unknown');
    const after = cfgMgr.read();
    expect(after.locale).toBe(before.locale);
  });

  test('/language en while already on en prints a no-op echo', async () => {
    const cmd = createLanguageCommand({ configManager: cfgMgr });
    await cmd.execute('en', buildCtx().ctx);
    const { ctx, output } = buildCtx();
    await cmd.execute('en', ctx);
    expect(output.join('\n').toLowerCase()).toContain('already on');
  });
});

describe('/language — no-args reopens the picker', () => {
  test('with openPicker callback wired, no-args invokes it and skips print', async () => {
    let opened = 0;
    const cmd = createLanguageCommand({
      configManager: cfgMgr,
      openPicker: () => {
        opened += 1;
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(opened).toBe(1);
    // No fallback text-mode output when the picker is wired.
    expect(output).toEqual([]);
  });

  test('without openPicker, no-args falls back to current + options print', async () => {
    const cmd = createLanguageCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    const joined = output.join('\n');
    expect(joined.toLowerCase()).toContain('current language');
    expect(joined).toContain('en');
    expect(joined).toContain('ru');
  });
});
