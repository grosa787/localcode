/**
 * LocaleToggle — small EN/RU pill that flips between English and
 * Russian. Persists via the store (which also writes to localStorage
 * and updates `<html lang>` so screen readers + CSS `:lang()` selectors
 * stay in sync).
 *
 * Hover reveals a tiny `Languages` icon — same affordance language as
 * `ThemeToggle`, but with text labels so the current locale is always
 * legible at a glance.
 */

import type { JSX } from 'react';

import { useT } from '../i18n';
import { Languages } from '../icons';
import { useStore } from '../state/store';

import styles from './LocaleToggle.module.css';

export function LocaleToggle(): JSX.Element {
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);
  const t = useT();

  const next = locale === 'en' ? 'ru' : 'en';
  const label = t('locale.change');

  return (
    <button
      type="button"
      className={styles.btn}
      onClick={() => setLocale(next)}
      aria-label={label}
      title={label}
    >
      <span className={styles.icon} aria-hidden="true">
        <Languages size={12} strokeWidth={1.75} />
      </span>
      <span className={styles.label}>{locale.toUpperCase()}</span>
    </button>
  );
}
