/**
 * Modal confirmation for "Delete project from LocalCode". Focus-trapped,
 * Enter to confirm, ESC to cancel. Owned by Sidebar.tsx — kept inline
 * here to keep the sidebar surface area contained.
 */

import { useEffect, useRef } from 'react';

import { useT } from '../i18n';
import styles from './ConfirmDeleteProjectDialog.module.css';

export interface ConfirmDeleteProjectDialogProps {
  label: string;
  sessionCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDeleteProjectDialog({
  label,
  sessionCount,
  onCancel,
  onConfirm,
}: ConfirmDeleteProjectDialogProps): JSX.Element {
  const t = useT();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Tab') {
        // Two-element trap.
        const focusables = [confirmRef.current, cancelRef.current].filter(
          (el): el is HTMLButtonElement => el !== null,
        );
        if (focusables.length === 0) return;
        const active = document.activeElement;
        const idx = focusables.findIndex((el) => el === active);
        if (idx === -1) {
          e.preventDefault();
          focusables[0]?.focus();
          return;
        }
        const dir = e.shiftKey ? -1 : 1;
        const nextIdx = (idx + dir + focusables.length) % focusables.length;
        e.preventDefault();
        focusables[nextIdx]?.focus();
      } else if (e.key === 'Enter') {
        // Default Enter on the focused button is already handled by the
        // browser; skip the global handler when focus is inside the
        // modal so we don't double-fire.
        const active = document.activeElement;
        if (
          active === confirmRef.current ||
          active === cancelRef.current ||
          active instanceof HTMLButtonElement
        ) {
          return;
        }
        e.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className={styles.backdrop} role="presentation" onClick={onCancel}>
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmDeleteProjectTitle"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirmDeleteProjectTitle" className={styles.title}>
          {t('confirmDelete.title')}
        </h2>
        <p className={styles.body}>
          {t('confirmDelete.body', { label, count: sessionCount })}
        </p>
        <div className={styles.actions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.cancel}
            onClick={onCancel}
          >
            {t('confirmDelete.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={styles.confirm}
            onClick={onConfirm}
          >
            {t('confirmDelete.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
