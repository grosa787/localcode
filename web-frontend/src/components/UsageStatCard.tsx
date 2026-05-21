/**
 * UsageStatCard — glassy stat card for the usage dashboard.
 *
 * Renders a small icon, a label, a big number, and an optional sublabel.
 * Used in the dashboard's top row for headline numbers (tokens, cost,
 * sessions, turns).
 */

import type { JSX, ReactNode } from 'react';

import styles from './UsageStatCard.module.css';

export interface UsageStatCardProps {
  /** Lucide-react icon component (we don't import a specific one — callers pass theirs). */
  icon?: ReactNode;
  /** Short uppercase label e.g. "Tokens". */
  label: string;
  /** Headline value (already formatted by the caller). */
  value: string;
  /** Optional smaller line under the value. */
  sublabel?: string;
  /** Optional accent variant — defaults to neutral. */
  tone?: 'neutral' | 'accent';
}

export function UsageStatCard({
  icon,
  label,
  value,
  sublabel,
  tone = 'neutral',
}: UsageStatCardProps): JSX.Element {
  const toneClass = tone === 'accent' ? styles.toneAccent ?? '' : '';
  return (
    <div className={`${styles.card} ${toneClass}`} role="group" aria-label={label}>
      <div className={styles.head}>
        {icon !== undefined ? (
          <span className={styles.icon} aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className={styles.label}>{label}</span>
      </div>
      <div className={styles.value}>{value}</div>
      {sublabel !== undefined ? (
        <div className={styles.sublabel}>{sublabel}</div>
      ) : null}
    </div>
  );
}
