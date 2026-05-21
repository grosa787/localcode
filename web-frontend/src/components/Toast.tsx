/**
 * ToastStack — top-right notification stack. Auto-dismiss durations
 * scale with the severity of the message:
 *
 *   info / success   →  5s
 *   warning          →  8s
 *   error            → 12s (sticky when message > 200 chars)
 *
 * Optional per-toast `duration` (ms) overrides the level default.
 * Pass `duration: 0` to render a sticky toast (manual dismiss only).
 */

import { useEffect } from 'react';

import { AlertTriangle, Check, Info, X as XIcon } from 'lucide-react';

import { useT } from '../i18n';
import { type UIToast, useStore } from '../state/store';
import styles from './Toast.module.css';

/** Auto-dismiss timeouts (ms) keyed by severity. 0 = sticky. */
const DURATION_BY_LEVEL: Record<UIToast['level'], number> = {
  info: 5_000,
  success: 5_000,
  warning: 8_000,
  error: 12_000,
};

/** Errors with very long bodies stay sticky so users can read them. */
const LONG_ERROR_THRESHOLD = 200;
const LONG_ERROR_DURATION = 20_000;

export function dismissDurationFor(toast: UIToast): number {
  // Per-toast override wins (including the explicit-sticky 0 sentinel).
  if (toast.duration !== undefined) return toast.duration;
  if (toast.level === 'error' && toast.message.length > LONG_ERROR_THRESHOLD) {
    return LONG_ERROR_DURATION;
  }
  return DURATION_BY_LEVEL[toast.level];
}

interface ToastViewProps {
  toast: UIToast;
  onDismiss: (id: string) => void;
}

function iconFor(level: UIToast['level']): {
  Icon: typeof AlertTriangle;
  className: string;
} {
  switch (level) {
    case 'success':
      return { Icon: Check, className: styles.iconSuccess ?? '' };
    case 'warning':
      return { Icon: AlertTriangle, className: styles.iconWarning ?? '' };
    case 'error':
      return { Icon: AlertTriangle, className: styles.iconError ?? '' };
    case 'info':
    default:
      return { Icon: Info, className: styles.iconInfo ?? '' };
  }
}

function ToastView({ toast, onDismiss }: ToastViewProps): JSX.Element {
  const t = useT();
  useEffect(() => {
    const duration = dismissDurationFor(toast);
    if (duration <= 0) return; // sticky — user must dismiss manually
    const timer = setTimeout(() => onDismiss(toast.id), duration);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  const { Icon, className } = iconFor(toast.level);

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span className={`${styles.icon} ${className}`}>
        <Icon size={16} strokeWidth={1.5} />
      </span>
      <p className={styles.message}>{toast.message}</p>
      <button
        type="button"
        className={styles.dismiss}
        onClick={() => onDismiss(toast.id)}
        aria-label={t('toast.dismiss')}
      >
        <XIcon size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}

export function ToastStack(): JSX.Element | null {
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className={styles.stack} aria-live="polite">
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} onDismiss={dismissToast} />
      ))}
    </div>
  );
}
