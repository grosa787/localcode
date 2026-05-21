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
 *
 * LOCALE-APPLY-SECTION — every print path goes through the i18n `t()`
 * helper so the response immediately reflects the new locale (the
 * confirmation line on `/language ru` is rendered in Russian because
 * `configManager.update` ran BEFORE the print, and `LocaleProvider` in
 * `app.tsx` pushed the new value into the module-level mirror on the
 * very next render). LOCALE-APPLY-SECTION-END
 */

import type { ConfigManager } from '@/config/config-manager';
import { LocaleSchema } from '@/config/types';
import { t, setActiveLocale } from '@/i18n';
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
        // LOCALE-APPLY-SECTION — fall-back print path runs through the
        // active locale; tests without `openPicker` exercise this branch.
        const label =
          current === undefined
            ? t('language.notSet')
            : LOCALE_LABELS[current];
        ctx.print(t('language.current', { name: label }));
        for (const code of Object.keys(LOCALE_LABELS) as Locale[]) {
          const marker = code === current ? '*' : ' ';
          ctx.print(`  ${marker} ${code} — ${LOCALE_LABELS[code]}`);
        }
        ctx.print(t('language.switchHint'));
        // LOCALE-APPLY-SECTION-END
        return;
      }

      if (!isLocale(arg)) {
        // LOCALE-APPLY-SECTION
        ctx.print(t('language.unknown', { value: arg }));
        // LOCALE-APPLY-SECTION-END
        return;
      }

      if (arg === current) {
        // LOCALE-APPLY-SECTION
        ctx.print(t('language.alreadyOn', { name: LOCALE_LABELS[arg] }));
        // LOCALE-APPLY-SECTION-END
        return;
      }

      try {
        configManager.update({ locale: arg });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        // LOCALE-APPLY-SECTION
        ctx.print(t('language.failed', { msg }));
        // LOCALE-APPLY-SECTION-END
        return;
      }

      // LOCALE-APPLY-SECTION — push the new locale into the i18n module
      // mirror immediately so the confirmation print and any subsequent
      // synchronous slash-command output renders in the freshly-selected
      // language even before React commits the next paint. The provider
      // in `app.tsx` will overwrite the same value on its next render —
      // they converge on the same locale.
      setActiveLocale(arg);
      ctx.print(t('language.setTo', { name: LOCALE_LABELS[arg] }));
      // LOCALE-APPLY-SECTION-END
    },
  };
}
