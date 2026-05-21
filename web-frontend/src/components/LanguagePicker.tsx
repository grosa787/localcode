/**
 * Web LanguagePicker — modal shown on first SPA launch (or via the
 * `/language` slash command in the future). Mirrors the TUI picker:
 *   - Two rows (English / Русский).
 *   - Arrow-key navigation + Enter to confirm.
 *   - Click to select directly.
 *
 * The picker is purely presentational; the parent owns persistence.
 * It reads the active locale from the store on mount so the initially
 * highlighted row matches whatever value the user already has.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';

import { useT } from '../i18n';
import { useStore, type Locale } from '../state/store';
import styles from './LanguagePicker.module.css';

export interface LanguagePickerProps {
  /**
   * Called when the user confirms a row. The parent is responsible for
   * persisting (`useStore.setLocale(...)`) — the picker stays pure UI
   * so it's testable in isolation without a store.
   */
  readonly onSelect: (locale: Locale) => void;
}

interface Choice {
  readonly id: Locale;
  readonly flag: string;
  readonly labelKey: 'language.en' | 'language.ru';
}

const CHOICES: readonly Choice[] = [
  { id: 'en', flag: '🇬🇧', labelKey: 'language.en' },
  { id: 'ru', flag: '🇷🇺', labelKey: 'language.ru' },
];

export function LanguagePicker(props: LanguagePickerProps): JSX.Element {
  const t = useT();
  const activeLocale = useStore((s) => s.locale);
  const [index, setIndex] = useState<number>(() => {
    const i = CHOICES.findIndex((c) => c.id === activeLocale);
    return i < 0 ? 0 : i;
  });

  // Mirror locale changes while the picker is open so re-rendering the
  // store-driven copy never lags the highlight.
  useEffect(() => {
    const i = CHOICES.findIndex((c) => c.id === activeLocale);
    if (i >= 0) setIndex(i);
  }, [activeLocale]);

  const confirm = useCallback(
    (i: number): void => {
      const choice = CHOICES[i];
      if (choice === undefined) return;
      props.onSelect(choice.id);
    },
    [props],
  );

  // Track the live index in a ref so keyboard handlers bound on a single
  // row always see the latest active index, even after ArrowDown moved
  // the highlight to a sibling row.
  const indexRef = useRef<number>(index);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  const onRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIndex((cur) => (cur >= CHOICES.length - 1 ? 0 : cur + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((cur) => (cur <= 0 ? CHOICES.length - 1 : cur - 1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        confirm(indexRef.current);
      }
    },
    [confirm],
  );

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={t('language.title')}
    >
      <div className={styles.card}>
        <h2 className={styles.title}>{t('language.title')}</h2>
        <p className={styles.subtitle}>{t('language.subtitle')}</p>
        <div className={styles.rows} role="listbox" aria-label={t('language.subtitle')}>
          {CHOICES.map((c, i) => {
            const isActive = i === index;
            const label = t(c.labelKey);
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className={`${styles.row}${isActive ? ` ${styles.active}` : ''}`}
                onClick={() => confirm(i)}
                onMouseEnter={() => setIndex(i)}
                onKeyDown={onRowKeyDown}
                data-testid={`language-row-${c.id}`}
              >
                <span className={styles.flag} aria-hidden="true">
                  {c.flag}
                </span>
                <span className={styles.label}>{label}</span>
              </button>
            );
          })}
        </div>
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.confirm}
            onClick={() => confirm(index)}
            data-testid="language-confirm"
          >
            {t('language.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default LanguagePicker;
