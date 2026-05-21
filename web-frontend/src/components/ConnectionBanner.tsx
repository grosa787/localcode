/**
 * ConnectionBanner — sticky bar at top of the main column when the WS
 * connection is not open. Shows status + a manual retry button.
 */

import type { JSX } from 'react';

import { useT } from '../i18n';
import { AlertTriangle, Loader2, RefreshCw } from '../icons';
import { useStore } from '../state/store';

import styles from './ConnectionBanner.module.css';

export interface ConnectionBannerProps {
  /** Trigger a manual reconnect attempt. */
  onRetry: () => void;
}

export function ConnectionBanner({ onRetry }: ConnectionBannerProps): JSX.Element | null {
  const t = useT();
  const status = useStore((s) => s.connection.status);
  if (status === 'open') return null;

  const reconnecting = status === 'reconnecting' || status === 'connecting';
  const message = reconnecting ? t('connection.reconnecting') : t('connection.lost');
  const Icon = reconnecting ? Loader2 : AlertTriangle;

  return (
    <div className={styles.root} role="status" aria-live="polite">
      <span
        className={`${styles.icon} ${reconnecting ? styles.spin : ''}`}
        aria-hidden="true"
      >
        <Icon size={14} strokeWidth={1.75} />
      </span>
      <span className={styles.message}>{message}</span>
      <button
        type="button"
        className={styles.retry}
        onClick={onRetry}
        aria-label={t('connection.retryAria')}
      >
        <RefreshCw size={12} strokeWidth={1.75} />
        <span>{t('connection.retry')}</span>
      </button>
    </div>
  );
}
