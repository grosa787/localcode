import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { en } from './en';
import { ru } from './ru';
import type { Locale, Strings } from './types';

export type { Locale, Strings };

const STORAGE_KEY = 'localcode.locale';

const STRINGS: Record<Locale, Strings> = { en, ru };

interface I18nContextValue {
  readonly locale: Locale;
  readonly t: Strings;
  readonly setLocale: (next: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectInitial(): Locale {
  if (typeof window === 'undefined') return 'en';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'en' || stored === 'ru') return stored;
  const nav = window.navigator.language.toLowerCase();
  return nav.startsWith('ru') ? 'ru' : 'en';
}

export function I18nProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => detectInitial());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      t: STRINGS[locale],
      setLocale: (next: Locale): void => {
        setLocaleState(next);
        try {
          window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // localStorage unavailable (private mode, SSR fallback) — ignore.
        }
      },
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (ctx === null) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
