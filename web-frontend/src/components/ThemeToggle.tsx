/**
 * ThemeToggle — small ghost button that flips between dark and light
 * themes. Persists the choice via the store (which writes to
 * localStorage and updates `<html data-theme>`).
 */

import type { JSX } from 'react';

import { useT } from '../i18n';
import { Moon, Sun } from '../icons';
import { useStore } from '../state/store';

import styles from './ThemeToggle.module.css';

export function ThemeToggle(): JSX.Element {
  const t = useT();
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  const isDark = theme === 'dark';
  const next = isDark ? 'light' : 'dark';
  const label = isDark ? t('theme.toLight') : t('theme.toDark');

  return (
    <button
      type="button"
      className={styles.btn}
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
    >
      {isDark ? (
        <Sun size={14} strokeWidth={1.5} />
      ) : (
        <Moon size={14} strokeWidth={1.5} />
      )}
    </button>
  );
}
