/**
 * LOCALE-APPLY-SECTION — TUI i18n core.
 *
 * The TUI rendering layer is intentionally simple: a flat `Record<key,
 * string>` per locale plus a React context that propagates the currently
 * active locale to every child. Components consume `useT()` which returns
 * a memoised `t(key, vars?)` function tied to the active locale; whenever
 * `app.tsx` updates `config.locale` the provider re-renders, every
 * `useT()` consumer re-renders, and the visible strings flip.
 *
 * Design constraints honoured here:
 *   - No `any` / `@ts-ignore` (CI lint guard).
 *   - `noUncheckedIndexedAccess` safe — every lookup falls back to the
 *     English table when the requested key is absent from the active
 *     locale, then to the raw key as the last resort.
 *   - Zero dependencies — pure React + plain strings. No SDK to bundle.
 *   - Module-level `getActiveLocale()` / `setActiveLocale()` exposed so
 *     non-React surfaces (slash-command `ctx.print`) can render localised
 *     output without threading the React context through to them. The
 *     provider keeps this module-level mirror in sync on every render
 *     (see `LocaleProvider`).
 *
 * The fallback chain on a missing key is:
 *   1. active locale table
 *   2. English table (the canonical superset)
 *   3. the key itself (visible diagnostic for the developer)
 *
 * Placeholders use `{name}` syntax. Substitution is a plain string replace
 * — never inject user-controlled keys. Numeric pluralisation isn't
 * generalised here (Russian has 3 plural forms vs English's 2); when a
 * surface needs plural-correct copy we ship distinct keys
 * (`chat.queueCountOne` vs `chat.queueCountMany`) and pick at the call
 * site. This keeps the runtime tiny.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from 'react';

import { en, type StringKey, type StringTable } from './strings/en.js';
import { ru } from './strings/ru.js';

import type { Locale } from '../types/global.js';

export type { StringKey, StringTable, Locale };
export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'ru'] as const;

const TABLES: Readonly<Record<Locale, StringTable>> = {
  en,
  ru,
};

/**
 * Mirror of the currently active locale, kept in sync by `LocaleProvider`.
 * Slash-command print callbacks (and any other non-React caller) read
 * this to resolve strings. Lives at module scope on purpose — every TUI
 * process has exactly one foreground locale at a time.
 */
let activeLocale: Locale = 'en';

export function getActiveLocale(): Locale {
  return activeLocale;
}

/**
 * Replace the module-level active locale and notify subscribers. The
 * React provider calls this in a `useEffect` so it stays in lockstep
 * with the propagated context value; tests can call it directly to
 * exercise the non-React path of `t()`.
 */
export function setActiveLocale(next: Locale): void {
  if (activeLocale === next) return;
  activeLocale = next;
  for (const sub of subscribers) {
    try {
      sub(next);
    } catch {
      /* swallow — a misbehaving subscriber must not poison others */
    }
  }
}

type LocaleSubscriber = (locale: Locale) => void;
const subscribers: Set<LocaleSubscriber> = new Set();

/**
 * Subscribe to module-level locale changes. Returns an unsubscribe
 * function. Used by tests and by any non-React caller that wants to
 * react to `/language` switches without going through the React tree.
 */
export function subscribeLocale(sub: LocaleSubscriber): () => void {
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
  };
}

/**
 * Substitute `{name}` placeholders in `template` with the values from
 * `vars`. Keys missing from `vars` are left intact so the developer can
 * spot the omission. Substitution is a plain global string replace; we
 * never `eval` or template-engine the input.
 */
function format(
  template: string,
  vars: Readonly<Record<string, string | number>> | undefined,
): string {
  if (vars === undefined) return template;
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    // Reject any pathological key (e.g. injected `{$&}` group refs) by
    // doing a literal split/join instead of regex replace.
    out = out.split(`{${key}}`).join(String(value));
  }
  return out;
}

/**
 * Resolve a string key for the given locale.
 *
 *   - Hit in the active table → use it.
 *   - Miss → fall back to the English table.
 *   - Miss in English too → return the raw key (developer diagnostic).
 *
 * Substitution always runs last so placeholders survive the fallback.
 */
export function t(
  key: StringKey,
  vars?: Readonly<Record<string, string | number>>,
  locale: Locale = activeLocale,
): string {
  const table = TABLES[locale] ?? TABLES.en;
  const localised: string | undefined = table[key];
  if (localised !== undefined) return format(localised, vars);
  const english: string | undefined = TABLES.en[key];
  if (english !== undefined) return format(english, vars);
  return key;
}

// ---------- React integration ----------

const LocaleContext = createContext<Locale>('en');

export interface LocaleProviderProps {
  readonly locale: Locale;
  readonly children: React.ReactNode;
}

/**
 * React context provider for the active locale. Mount once at the
 * composition root and pass `config.locale ?? 'en'`. Every nested
 * `useT()` consumer re-renders when `locale` flips.
 *
 * The provider also pushes the value into the module-level mirror so
 * slash commands and other non-React callers stay in sync — verified by
 * `tests/i18n/tui-locale-apply.test.ts`.
 */
export function LocaleProvider({
  locale,
  children,
}: LocaleProviderProps): React.JSX.Element {
  useEffect(() => {
    setActiveLocale(locale);
  }, [locale]);
  return React.createElement(LocaleContext.Provider, { value: locale }, children);
}

export interface UseTResult {
  readonly locale: Locale;
  readonly t: (
    key: StringKey,
    vars?: Readonly<Record<string, string | number>>,
  ) => string;
}

/**
 * React hook returning the localised `t(key, vars?)` function bound to
 * the currently-active locale. Memoised on the locale value so callers
 * can pass `t` straight into `useMemo`/`useCallback` dependency arrays
 * without churn between renders that don't change the locale.
 */
export function useT(): UseTResult {
  const locale = useContext(LocaleContext);
  const bound = useCallback(
    (
      key: StringKey,
      vars?: Readonly<Record<string, string | number>>,
    ): string => t(key, vars, locale),
    [locale],
  );
  return useMemo(() => ({ locale, t: bound }), [locale, bound]);
}
// LOCALE-APPLY-SECTION-END
