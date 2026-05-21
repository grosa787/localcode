/**
 * ProfileBanner — top-of-chat banner that surfaces the active permission
 * profile when it's anything other than `default`.
 *
 *   - `default`            → hidden.
 *   - `acceptEdits`        → yellow notice.
 *   - `plan`               → yellow notice ("Plan Mode — read-only").
 *   - `dontAsk`            → red WARNING banner.
 *   - `bypassPermissions`  → red WARNING banner (extra-loud copy).
 *
 * Hooked into the store via `useStore((s) => s.permissionProfile)` so a
 * `setProfile` mutation (REST POST → store action) updates the banner
 * synchronously across every consumer.
 */

import type { JSX } from 'react';

import { useT } from '../i18n';
import { AlertTriangle, Info, ShieldCheck } from '../icons';
import { useStore } from '../state/store';

import styles from './ProfileBanner.module.css';

export function ProfileBanner(): JSX.Element | null {
  const t = useT();
  const profile = useStore((s) => s.permissionProfile);

  if (profile === null || profile === 'default') return null;

  if (profile === 'plan') {
    return (
      <div className={`${styles.banner} ${styles.warn}`} role="status">
        <Info size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles.label}>{t('profile.banner.plan')}</span>
        <span className={styles.detail}>{t('profile.banner.plan.detail')}</span>
      </div>
    );
  }

  if (profile === 'acceptEdits') {
    return (
      <div className={`${styles.banner} ${styles.warn}`} role="status">
        <ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles.label}>{t('profile.banner.acceptEdits')}</span>
        <span className={styles.detail}>
          {t('profile.banner.acceptEdits.detail')}
        </span>
      </div>
    );
  }

  // dontAsk / bypassPermissions → red warning.
  const labelKey =
    profile === 'bypassPermissions'
      ? 'profile.banner.bypassPermissions'
      : 'profile.banner.dontAsk';
  const detailKey =
    profile === 'bypassPermissions'
      ? 'profile.banner.bypassPermissions.detail'
      : 'profile.banner.dontAsk.detail';
  return (
    <div className={`${styles.banner} ${styles.danger}`} role="alert">
      <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className={styles.label}>{t(labelKey)}</span>
      <span className={styles.detail}>{t(detailKey)}</span>
    </div>
  );
}
