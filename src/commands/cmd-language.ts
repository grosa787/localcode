/**
 * /language (alias /lang) — set or reopen the UI language picker.
 *
 * Usage:
 *   /language                  → print current locale + reopen the picker.
 *   /language en               → switch to English.
 *   /language ru               → switch to Russian.
 *
 * The selected locale is persisted at the TOP level of the config
 * (`locale`) so the next-turn / next-launch sees it via the same
 * ConfigManager pipeline used by `/style`, `/statusline`, etc.
 *
 * The TUI host (`src/app.tsx`) is responsible for routing the no-arg
 * path through `setScreen('languagePicker')` — see LANGUAGE-CMD-SECTION
 * there. We expose an explicit `openPicker` hook on the command's deps
 * so the command stays decoupled from the React composition root.
 */

import type { ConfigManager } from '@/config/config-manager';
import { LocaleSchema } from '@/config/types';
import type { CommandContext, Locale, SlashCommand } from '@/types/global';

export interface LanguageDeps {
  readonly configManager: ConfigManager;
  /**
   * Called when `/language` is invoked without arguments. The host
   * implementation flips the active screen to the language picker.
   * Optional so tests / alternate hosts can opt-out (in that case
   * the command falls back to printing the current locale + list).
   */
  readonly openPicker?: () => void;
}

const LANGUAGE_NAME = 'language';
const LANGUAGE_DESCRIPTION =
  'Switch the UI language (English / Русский).';
const LANGUAGE_USAGE = '/language [en|ru]';

const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  ru: 'Русский',
};

function isLocale(value: string): value is Locale {
  return LocaleSchema.safeParse(value).success;
}

export function createLanguageCommand(deps: LanguageDeps): SlashCommand {
  const { configManager, openPicker } = deps;

  return {
    name: LANGUAGE_NAME,
    description: LANGUAGE_DESCRIPTION,
    usage: LANGUAGE_USAGE,
    execute: (args: string, ctx: CommandContext): void => {
      const arg = args.trim().toLowerCase();
      const current: Locale | undefined = ctx.config.locale;

      if (arg.length === 0) {
        if (openPicker !== undefined) {
          openPicker();
          return;
        }
        const label =
          current === undefined ? '(not set)' : LOCALE_LABELS[current];
        ctx.print(`Current language: ${label}`);
        for (const code of Object.keys(LOCALE_LABELS) as Locale[]) {
          const marker = code === current ? '*' : ' ';
          ctx.print(`  ${marker} ${code} — ${LOCALE_LABELS[code]}`);
        }
        ctx.print('Switch with `/language <en|ru>`.');
        return;
      }

      if (!isLocale(arg)) {
        ctx.print(
          `Unknown language: '${arg}'. Valid options: en, ru.`,
        );
        return;
      }

      if (arg === current) {
        ctx.print(`Already on '${LOCALE_LABELS[arg]}'.`);
        return;
      }

      try {
        configManager.update({ locale: arg });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to switch language: ${msg}`);
        return;
      }

      ctx.print(`Language set to '${LOCALE_LABELS[arg]}'.`);
    },
  };
}
