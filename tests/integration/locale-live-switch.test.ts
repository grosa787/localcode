/**
 * End-to-end-ish coverage for the `/language` mid-session switch path.
 *
 * Story: user runs `/language ru` mid-session. The slash-command
 * handler:
 *   1. Persists the choice via `configManager.update({ locale: 'ru' })`.
 *   2. Calls `setActiveLocale('ru')` so the module-level mirror flips
 *      BEFORE the confirmation print renders through `ctx.print`.
 *   3. Prints the localized confirmation in the new locale.
 *
 * The TUI host's `LocaleProvider` would then push the same value into
 * the mirror on the next React render — they converge.
 */

import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLanguageCommand } from '@/commands/cmd-language';
import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';
import { setActiveLocale, getActiveLocale } from '@/i18n';
import type { CommandContext } from '@/types/global';

function makeConfigManager(): ConfigManager {
  const dir = mkdtempSync(join(tmpdir(), 'localcode-locale-'));
  const path = join(dir, 'config.toml');
  const mgr = new ConfigManager(path);
  mgr.write(getDefaultConfig('ollama'));
  return mgr;
}

function makeCtx(locale: 'en' | 'ru' | undefined): {
  readonly ctx: CommandContext;
  readonly printed: string[];
} {
  const printed: string[] = [];
  const base = getDefaultConfig('ollama');
  const ctx: CommandContext = {
    projectRoot: '/tmp',
    sessionId: null,
    config: locale === undefined ? base : { ...base, locale },
    print: (line: string) => printed.push(line),
    setScreen: () => undefined,
  };
  return { ctx, printed };
}

test('/language ru flips the i18n mirror and prints the localized confirmation', () => {
  setActiveLocale('en');
  const mgr = makeConfigManager();
  const cmd = createLanguageCommand({ configManager: mgr });
  const { ctx, printed } = makeCtx('en');

  cmd.execute('ru', ctx);

  expect(getActiveLocale()).toBe('ru');
  expect(mgr.read().locale).toBe('ru');
  const last = printed[printed.length - 1] ?? '';
  expect(last).toContain('Язык установлен');
  expect(last).not.toContain('Language set');

  setActiveLocale('en');
});

test('/language en restores English mirror and copy', () => {
  setActiveLocale('ru');
  const mgr = makeConfigManager();
  mgr.update({ locale: 'ru' });
  const cmd = createLanguageCommand({ configManager: mgr });
  const { ctx, printed } = makeCtx('ru');

  cmd.execute('en', ctx);

  expect(getActiveLocale()).toBe('en');
  expect(mgr.read().locale).toBe('en');
  const last = printed[printed.length - 1] ?? '';
  expect(last).toContain('Language set');
  expect(last).not.toContain('Язык установлен');

  setActiveLocale('en');
});

test('/language ru without explicit ctx locale: prints localized header lines', () => {
  setActiveLocale('en');
  const mgr = makeConfigManager();
  // No openPicker → no-args path falls through to the print branch.
  const cmd = createLanguageCommand({ configManager: mgr });
  const { ctx, printed } = makeCtx(undefined);

  cmd.execute('', ctx);

  // The current-locale print uses `(not set)` / `(не задан)` depending
  // on the active mirror at print time. Mirror is 'en' here, so the
  // English label is what we should see.
  expect(printed[0]).toContain('Current language');
  setActiveLocale('en');
});
