/**
 * ErrorBanner — visible recovery banner shown when the most recent
 * stream emitted an `error` (whether from the adapter, a tool failure,
 * or the watchdog force-reset). Distinct from QueueErrorBanner: this
 * one fires for ANY stream error, regardless of pending-queue state,
 * and lets the user resend the last message they sent.
 *
 * Stateless / controlled — the parent (ChatView/App) supplies the
 * message string + retry callback. Hidden when `message === null`.
 */

import type { JSX } from 'react';

import { useT } from '../i18n';
import { AlertTriangle } from '../icons';

import styles from './ErrorBanner.module.css';

export interface ErrorBannerProps {
  /** The error string surfaced by the runtime. `null` hides the banner. */
  message: string | null;
  /**
   * Resend the user's most recent message. The parent is responsible
   * for tracking what to resend; the banner is purely a trigger.
   * Hidden when `null` (e.g. no message ever sent in this session).
   */
  onRetry: (() => void) | null;
  /** Dismiss without resending. */
  onDismiss: () => void;
}

export function ErrorBanner({
  message,
  onRetry,
  onDismiss,
}: ErrorBannerProps): JSX.Element | null {
  const t = useT();
  if (message === null || message.length === 0) return null;
  return (
    <div className={styles.root} role="alert" aria-live="assertive">
      <span className={styles.icon} aria-hidden="true">
        <AlertTriangle size={14} strokeWidth={1.75} />
      </span>
      <span className={styles.message}>
        {/* Keep the runtime's verbatim error visible so the user can
            triage. Truncation is left to CSS (`text-overflow: ellipsis`
            + `title` attr) so screen-readers still get the full text. */}
        <span className={styles.prefix}>
          {t('chat.streamError') ?? 'Stream errored'}:
        </span>{' '}
        <span className={styles.detail} title={message}>
          {message}
        </span>
      </span>
      <div className={styles.actions}>
        {onRetry !== null ? (
          <button
            type="button"
            className={styles.button}
            onClick={onRetry}
          >
            {t('chat.retryLast') ?? 'Retry last'}
          </button>
        ) : null}
        <button
          type="button"
          className={`${styles.button} ${styles.buttonMuted}`}
          onClick={onDismiss}
        >
          {t('chat.dismiss') ?? 'Dismiss'}
        </button>
      </div>
    </div>
  );
}
