/**
 * QueueIndicator — small horizontal strip rendered just above the
 * Composer. Shows how many user messages are queued to auto-send after
 * the current turn finishes streaming. Clicking the count opens a
 * dropdown listing each queued message with a per-item delete button.
 *
 * Renders nothing when the queue is empty (no chrome cost on idle).
 *
 * Wire-up:
 *   - `pendingQueue` lives in the Zustand store; this component reads
 *     it directly so a single render-cycle reflects every enqueue/
 *     dequeue without prop drilling through ChatView.
 *   - The dropdown is a controlled popover; Esc / outside-click closes
 *     it; per-item delete calls `dequeueMessage(id)`; clear-all calls
 *     `clearPendingQueue()`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';

import { useT } from '../i18n';
import { Clock, X } from '../icons';
import { useStore } from '../state/store';

import styles from './QueueIndicator.module.css';

/** Lines kept per item in the dropdown before "…" suffix appears. */
const MAX_PREVIEW_LINES = 5;

export interface QueueIndicatorProps {
  /** Current queue length — passed by parent for render gating. */
  count: number;
}

/**
 * Truncate a queued message body for display in the dropdown:
 * keep up to MAX_PREVIEW_LINES lines and append a horizontal ellipsis
 * if any content was elided. Whitespace-only tails are stripped so the
 * "…" sticks to actual content, not a blank line.
 */
export function truncatePreview(content: string, max: number = MAX_PREVIEW_LINES): string {
  const lines = content.split('\n');
  if (lines.length <= max) return content;
  const head = lines.slice(0, max).join('\n').replace(/\s+$/u, '');
  return `${head}…`;
}

export function QueueIndicator(props: QueueIndicatorProps): JSX.Element | null {
  const t = useT();
  const pendingQueue = useStore((s) => s.pendingQueue);
  const dequeueMessage = useStore((s) => s.dequeueMessage);
  const clearPendingQueue = useStore((s) => s.clearPendingQueue);
  const pushToast = useStore((s) => s.pushToast);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown on outside click + Escape, mirroring the
  // existing popover patterns (NotificationCenter, PlusMenu).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (ev: MouseEvent): void => {
      const root = rootRef.current;
      if (root === null) return;
      if (ev.target instanceof Node && root.contains(ev.target)) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return (): void => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Auto-close when the queue empties (e.g. auto-drain after `done`).
  useEffect(() => {
    if (props.count === 0 && open) setOpen(false);
  }, [props.count, open]);

  const onClear = useCallback((): void => {
    clearPendingQueue();
    pushToast({ level: 'info', message: t('queue.cleared') });
    setOpen(false);
  }, [clearPendingQueue, pushToast, t]);

  const items = useMemo(
    () =>
      pendingQueue.map((it) => ({
        id: it.id,
        preview: truncatePreview(it.content),
      })),
    [pendingQueue],
  );

  if (props.count === 0) return null;

  const label =
    props.count === 1
      ? t('queue.one')
      : t('queue.many', { count: props.count });

  return (
    <div className={styles.root} role="status" aria-live="polite" ref={rootRef}>
      <button
        type="button"
        className={styles.summary}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('queue.toggleAria')}
        onClick={(): void => setOpen((v) => !v)}
      >
        <Clock size={12} strokeWidth={1.5} className={styles.icon} />
        <span className={styles.label}>{label}</span>
      </button>
      <button
        type="button"
        className={styles.clearBtn}
        onClick={onClear}
        aria-label={t('queue.clearAria')}
      >
        {t('queue.clear')}
      </button>
      {open ? (
        <ul
          className={styles.dropdown}
          role="listbox"
          aria-label={t('queue.listAria')}
        >
          {items.map((it, idx) => (
            <li key={it.id} className={styles.row} role="option" aria-selected="false">
              <span className={styles.rowIndex} aria-hidden="true">
                {idx + 1}.
              </span>
              <span className={styles.rowPreview}>{it.preview}</span>
              <button
                type="button"
                className={styles.rowDeleteBtn}
                onClick={(): void => dequeueMessage(it.id)}
                aria-label={t('queue.deleteItemAria', { index: idx + 1 })}
                title={t('queue.deleteItemAria', { index: idx + 1 })}
              >
                <X size={12} strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
