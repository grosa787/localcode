/**
 * DropOverlay — full-viewport dim + centered caption rendered while the
 * user is dragging files over the chat area. Presentational only; the
 * Composer owns the dragenter/leave counter that drives `visible`.
 */

import type { JSX } from 'react';

import { useT } from '../i18n';

import styles from './DropOverlay.module.css';

export interface DropOverlayProps {
  visible: boolean;
}

export function DropOverlay(props: DropOverlayProps): JSX.Element | null {
  const t = useT();
  if (!props.visible) return null;
  return (
    <div className={styles.root} role="status" aria-live="polite">
      <span className={styles.caption}>{t('composer.drop.attach')}</span>
    </div>
  );
}
