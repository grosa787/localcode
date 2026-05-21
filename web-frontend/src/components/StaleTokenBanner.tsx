/**
 * StaleTokenBanner — sticky full-width recovery banner shown when the
 * server rejects our CSRF token. The most common cause: the user
 * re-ran `localcode --web` (which rotates the per-boot token) but the
 * existing browser tab still holds the previous value in
 * `sessionStorage`. REST calls then 403 silently and the SPA looks
 * "wiped" — sidebar empty, settings reset — even though the backend
 * has the data fully persisted.
 *
 * The banner explains what happened and how to recover (open the new
 * URL printed in the terminal). Optionally dismissible — dismissal
 * does not fix anything, it just hides the banner.
 */

import { useState, type JSX } from 'react';

import { useT } from '../i18n';
import { AlertTriangle, X } from '../icons';

import styles from './StaleTokenBanner.module.css';

export interface StaleTokenBannerProps {
  /**
   * Optional dismiss handler. When provided, an `X` button is rendered;
   * clicking it invokes the handler. The banner does not self-hide —
   * the parent owns the visibility decision via store state.
   */
  onDismiss?: () => void;
}

export function StaleTokenBanner({
  onDismiss,
}: StaleTokenBannerProps): JSX.Element {
  const t = useT();
  const [showHowTo, setShowHowTo] = useState<boolean>(false);

  return (
    <div className={styles.root} role="alert" aria-live="assertive">
      <span className={styles.icon} aria-hidden="true">
        <AlertTriangle size={18} strokeWidth={2} />
      </span>
      <div className={styles.content}>
        <h2 className={styles.heading}>{t('staleToken.heading')}</h2>
        <p className={styles.body}>{t('staleToken.body')}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.actionButton}
            onClick={() => setShowHowTo((v) => !v)}
            aria-expanded={showHowTo}
          >
            {t('staleToken.openTerminal')}
          </button>
        </div>
        {showHowTo ? (
          <div className={styles.tooltip} role="note">
            {t('staleToken.howToOpen')}
          </div>
        ) : null}
      </div>
      {onDismiss !== undefined ? (
        <button
          type="button"
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label={t('staleToken.dismiss')}
          title={t('staleToken.dismiss')}
        >
          <X size={16} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}
