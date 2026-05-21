/**
 * QueueErrorBanner — recovery banner shown when the last streamed turn
 * surfaced an error AND there are still type-ahead messages waiting in
 * the pending queue. Without the gate, a single transient upstream
 * failure fans out into a toast storm as each queued message
 * immediately fires another doomed request.
 *
 * The banner lives just above the QueueIndicator inside the chat
 * surface and is purely presentational — the parent (ChatView) owns
 * the queue/error state and the side effects of Retry / Discard.
 *
 * Styling uses design tokens (`--bg-elevated`, `--warning`,
 * `--text-muted`, …) so the look adapts to the light theme; the
 * previous inline-styled banner was hardcoded to the dark palette.
 */

import type { JSX } from 'react';

import { useT } from '../i18n';
import { AlertTriangle } from '../icons';

import styles from './QueueErrorBanner.module.css';

export interface QueueErrorBannerProps {
  /** Clears the error pause and re-fires the queued messages. */
  onRetry: () => void;
  /** Drops the queue and the error pause without sending. */
  onDiscard: () => void;
}

export function QueueErrorBanner({
  onRetry,
  onDiscard,
}: QueueErrorBannerProps): JSX.Element {
  const t = useT();
  return (
    <div className={styles.root} role="status" aria-live="polite">
      <span className={styles.icon} aria-hidden="true">
        <AlertTriangle size={14} strokeWidth={1.75} />
      </span>
      <span className={styles.message}>{t('chat.queuePaused')}</span>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          onClick={onRetry}
        >
          {t('chat.retry')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonMuted}`}
          onClick={onDiscard}
        >
          {t('chat.discard')}
        </button>
      </div>
    </div>
  );
}
