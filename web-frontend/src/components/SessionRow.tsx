/**
 * SessionRow — single session entry inside a folder group.
 *
 * Includes a hover-revealed delete affordance (Trash2). Click on the row
 * selects the session; click on the delete button stops propagation and
 * triggers an `onDelete` callback (with native confirm at the call site).
 */

import type { MouseEvent } from 'react';

import type { SessionSummaryWire } from '../../../src/web/protocol/rest-types.js';
import { useT } from '../i18n';
import { Trash2 } from '../icons';
import { useStore, type SessionRunStatus } from '../state/store';
import { relativeTime } from '../util/format-time';
import { truncate } from '../util/truncate';
import styles from './SessionRow.module.css';

export interface SessionRowProps {
  session: SessionSummaryWire;
  active: boolean;
  /** When true, sit inside a folder group (extra left indent). */
  nested?: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function SessionRow({
  session,
  active,
  nested = false,
  onSelect,
  onDelete,
}: SessionRowProps): JSX.Element {
  const t = useT();
  const storeHandler = useStore((s) => s.deleteSessionHandler);
  const effectiveDelete = onDelete ?? storeHandler;
  const runStatus: SessionRunStatus =
    useStore((s) => s.sessionStatus[session.id]?.status) ?? 'idle';

  const dotClass =
    runStatus === 'streaming'
      ? `${styles.dot} ${styles.dotStreaming}`
      : runStatus === 'recently-finished'
        ? `${styles.dot} ${styles.dotFinished}`
        : `${styles.dot} ${styles.dotIdle}`;
  const dotLabel =
    runStatus === 'streaming'
      ? t('sessionRow.streaming')
      : runStatus === 'recently-finished'
        ? t('sessionRow.recentlyFinished')
        : t('sessionRow.idle');

  const title =
    session.title !== null && session.title.length > 0
      ? truncate(session.title, 36)
      : t('sessionRow.newChat');
  const subtitle = `${relativeTime(session.updatedAt)} · ${session.model}`;

  const handleDelete = (e: MouseEvent<HTMLSpanElement>): void => {
    e.stopPropagation();
    e.preventDefault();
    effectiveDelete?.(session.id);
  };

  const handleDeleteKey = (e: React.KeyboardEvent<HTMLSpanElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation();
      e.preventDefault();
      effectiveDelete?.(session.id);
    }
  };

  return (
    <div
      className={`${styles.root} ${active ? styles.active : ''} ${
        nested ? styles.nested : ''
      }`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(session.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(session.id);
        }
      }}
      aria-current={active ? 'true' : undefined}
      title={session.title ?? t('sessionRow.newChat')}
    >
      <span
        className={dotClass}
        aria-label={dotLabel}
        title={dotLabel}
        role="status"
      />
      <div className={styles.text}>
        <span className={styles.title}>{title}</span>
        <span className={styles.subtitle}>{subtitle}</span>
      </div>
      {effectiveDelete !== null && effectiveDelete !== undefined ? (
        <span
          className={styles.delete}
          role="button"
          tabIndex={-1}
          aria-label={t('sessionRow.delete')}
          title={t('sessionRow.delete')}
          onClick={handleDelete}
          onKeyDown={handleDeleteKey}
        >
          <Trash2 size={14} strokeWidth={1.5} />
        </span>
      ) : null}
    </div>
  );
}
