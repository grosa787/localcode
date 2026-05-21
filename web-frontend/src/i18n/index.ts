/**
 * i18n — runtime entry point.
 *
 * - `useT()` — React hook that returns a `t(key, vars?)` translator
 *   bound to the current locale slice in the zustand store.
 * - `translate(locale, key, vars?)` — pure helper for use outside
 *   React components (rare).
 *
 * Variable substitution: any `{name}` token in the value is replaced
 * with `vars[name]`. Missing vars are left as-is so the placeholder is
 * still readable in the UI.
 */

import { useStore } from '../state/store';
import { en } from './en';
import { ru } from './ru';
import type { Locale, TranslationKey } from './types';

const tables: Record<Locale, Record<TranslationKey, string>> = { en, ru };

export type Vars = Record<string, string | number>;

/** Substitute `{name}` placeholders. Missing keys are left intact. */
function substitute(template: string, vars: Vars | undefined): string {
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = vars[key];
    return v === undefined ? match : String(v);
  });
}

/** Pure: translate a key for an explicit locale. */
export function translate(
  locale: Locale,
  key: TranslationKey,
  vars?: Vars,
): string {
  const table = tables[locale];
  const raw = table[key];
  return substitute(raw, vars);
}

/**
 * React hook returning a stable `t(key, vars?)` translator. The function
 * identity changes only when the locale changes — safe to use as a
 * dependency in `useMemo` / `useCallback`.
 */
export function useT(): (key: TranslationKey, vars?: Vars) => string {
  const locale = useStore((s) => s.locale);
  return (key, vars) => translate(locale, key, vars);
}

export type { Locale, TranslationKey };
