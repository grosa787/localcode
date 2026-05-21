/**
 * ApprovalDialog — modal overlay for approving a tool invocation.
 *
 * Spec:
 *   - Overlay rgba(20,9,31,0.72), centred dialog max-width 720px.
 *   - --bg-elevated, radius 12px, padding 24px.
 *   - Header: "Approve action" 16px 500.
 *   - Body: tool description + preview (diff/command/url).
 *   - Footer: [Reject] ghost + [Approve] primary.
 *   - ESC = reject. Cmd/Ctrl+Enter = approve.
 *
 * The component never blocks on its own — the parent wires the resolve
 * promise. The parent supplies `pending` (from the WS event) and
 * decides what happens on approve/reject.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import type { ToolPreviewWire } from '../../../src/web/protocol/messages.js';

import { useT } from '../i18n';
import { AlertTriangle, Loader2, X } from '../icons';

import { InlineDiff } from './InlineDiff';

import styles from './ApprovalDialog.module.css';

export interface ApprovalDialogProps {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  preview?: ToolPreviewWire;
  /** Called when the user approves. Should return when the response is sent. */
  onApprove: (toolCallId: string) => void | Promise<void>;
  /** Called when the user rejects (or hits Escape). */
  onReject: (toolCallId: string) => void | Promise<void>;
}

export function ApprovalDialog(props: ApprovalDialogProps): JSX.Element {
  const t = useT();
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const approveBtnRef = useRef<HTMLButtonElement>(null);

  const onApprove = useCallback(async () => {
    if (submitting !== null) return;
    setSubmitting('approve');
    try {
      await props.onApprove(props.toolCallId);
    } finally {
      // The dialog should be removed by the parent on success; if it
      // isn't, fall back to clearing the submitting state.
      setSubmitting(null);
    }
  }, [props, submitting]);

  const onReject = useCallback(async () => {
    if (submitting !== null) return;
    setSubmitting('reject');
    try {
      await props.onReject(props.toolCallId);
    } finally {
      setSubmitting(null);
    }
  }, [props, submitting]);

  // Keyboard handlers — ESC reject, Cmd/Ctrl+Enter approve.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void onReject();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void onApprove();
      }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); };
  }, [onApprove, onReject]);

  // Focus management — pull focus into the Approve button on mount.
  useEffect(() => {
    approveBtnRef.current?.focus();
  }, []);

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
      onClick={(e) => {
        // Click on the dim backdrop dismisses (matches platform expectation).
        if (e.target === e.currentTarget && submitting === null) {
          void onReject();
        }
      }}
    >
      <div className={styles.dialog} ref={dialogRef}>
        <div className={styles.header}>
          <h2 id="approval-title" className={styles.title}>{t('approval.title')}</h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={() => { void onReject(); }}
            aria-label={t('approval.reject')}
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.intro}>
            {t('approval.intro.before')}{' '}
            <code className={styles.tool}>{props.toolName}</code>
            {t('approval.intro.after')}
          </p>
          {renderPreview(props.preview, props.args, t)}
        </div>

        <div className={styles.footer}>
          <button
            type="button"
            className={styles.ghost}
            onClick={() => { void onReject(); }}
            disabled={submitting !== null}
          >
            {submitting === 'reject' ? (
              <Loader2 className={styles.spin} size={14} strokeWidth={1.5} />
            ) : null}
            {t('approval.reject')}
          </button>
          <button
            ref={approveBtnRef}
            type="button"
            className={styles.primary}
            onClick={() => { void onApprove(); }}
            disabled={submitting !== null}
          >
            {submitting === 'approve' ? (
              <Loader2 className={styles.spin} size={14} strokeWidth={1.5} />
            ) : null}
            {t('approval.approve')}
          </button>
        </div>

        <p className={styles.hint}>
          <kbd className={styles.kbd}>Esc</kbd> {t('approval.reject')} ·{' '}
          <kbd className={styles.kbd}>⌘ Enter</kbd> {t('approval.approve')}
        </p>
      </div>
    </div>
  );
}

function renderPreview(
  preview: ToolPreviewWire | undefined,
  args: unknown,
  t: (key: import('../i18n').TranslationKey) => string,
): JSX.Element {
  if (preview === undefined) {
    return (
      <div className={styles.argsBox}>
        <span className={styles.argsLabel}>{t('approval.arguments')}</span>
        <pre className={styles.argsPre}>{safeStringify(args)}</pre>
      </div>
    );
  }
  switch (preview.kind) {
    case 'diff':
      return (
        <InlineDiff
          path={preview.path}
          oldContent={preview.oldContent}
          newContent={preview.newContent}
        />
      );
    case 'command':
      return (
        <div className={styles.commandBox}>
          <div className={styles.commandLabel}>{t('approval.command')}</div>
          <pre className={styles.commandText}>$ {preview.command}</pre>
          <div className={styles.commandLabel}>{t('approval.cwd')}</div>
          <code className={styles.cwd}>{preview.cwd}</code>
        </div>
      );
    case 'fetch_image':
      return (
        <div className={styles.urlBox}>
          <span className={styles.urlLabel}>{t('approval.openUrl')}</span>
          <a
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.urlLink}
          >
            {preview.url}
          </a>
        </div>
      );
    case 'generic':
      return (
        <div className={styles.genericBox}>
          <AlertTriangle size={14} strokeWidth={1.5} />
          <span>{preview.summary}</span>
        </div>
      );
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
