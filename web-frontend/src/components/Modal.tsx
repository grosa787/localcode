/**
 * Modal — shared overlay primitive used by every dialog / overlay in
 * the web frontend. Owns:
 *   - Backdrop dim + click-to-close
 *   - Escape key handler
 *   - Focus trap (cycle Tab inside dialog, restore focus on close)
 *   - Body scroll lock while open
 *   - aria-modal + role="dialog" + aria-label / aria-labelledby wiring
 *   - prefers-reduced-motion honored via CSS @media query
 *
 * The composition is `<Modal><ModalBody>…</ModalBody><ModalFooter>…</ModalFooter></Modal>`,
 * matching the slot model the overlays were already using. Modal does
 * NOT render anything when `open === false` so callers can keep their
 * "render only when open" guard at the parent level if they prefer.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { useT } from '../i18n';
import { X } from '../icons';
import { useEscapeClose } from '../hooks/useEscapeClose';
import { useFocusTrap } from '../hooks/useFocusTrap';

import styles from './Modal.module.css';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  /** When `false`, Modal renders nothing. Mirrors the pattern other overlays use. */
  open: boolean;
  /** Called on ESC, backdrop click, and close-button click. */
  onClose: () => void;
  /** Title rendered in the header. Either `title` or `ariaLabel` must be set. */
  title?: ReactNode;
  /** Optional one-line subtitle rendered below the title. */
  subtitle?: ReactNode;
  /** Optional icon node rendered to the left of the title. */
  icon?: ReactNode;
  /** Accessible label when no visible title is provided. */
  ariaLabel?: string;
  /** Width preset — defaults to `md` (560px). */
  size?: ModalSize;
  /** When `true`, hide the close (X) button — caller owns dismissal. */
  hideCloseButton?: boolean;
  /** When `true`, ignore backdrop clicks (still closes on ESC). */
  disableBackdropClose?: boolean;
  /** When `true`, ignore ESC presses (still closes on backdrop click). */
  disableEscapeClose?: boolean;
  /** ARIA role override — default `dialog`. Use `alertdialog` for confirms. */
  role?: 'dialog' | 'alertdialog';
  /** Children rendered inside the body slot when not using ModalBody. */
  children: ReactNode;
}

const sizeClass: Record<ModalSize, string> = {
  sm: styles.sizeSm ?? '',
  md: styles.sizeMd ?? '',
  lg: styles.sizeLg ?? '',
  xl: styles.sizeXl ?? '',
};

/** Lock body scroll while at least one Modal is open. Stack-aware. */
let scrollLockCount = 0;
let savedOverflow: string | null = null;
function acquireScrollLock(): void {
  if (typeof document === 'undefined') return;
  if (scrollLockCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLockCount += 1;
}
function releaseScrollLock(): void {
  if (typeof document === 'undefined') return;
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = savedOverflow ?? '';
    savedOverflow = null;
  }
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  ariaLabel,
  size = 'md',
  hideCloseButton = false,
  disableBackdropClose = false,
  disableEscapeClose = false,
  role = 'dialog',
  children,
}: ModalProps): JSX.Element | null {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEscapeClose(onClose, open && !disableEscapeClose);
  useFocusTrap(dialogRef, open);

  // Body scroll lock — engages exactly while open.
  useEffect(() => {
    if (!open) return;
    acquireScrollLock();
    return () => {
      releaseScrollLock();
    };
  }, [open]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>): void => {
      if (disableBackdropClose) return;
      if (e.target === e.currentTarget) onClose();
    },
    [onClose, disableBackdropClose],
  );

  if (!open) return null;

  const useTitleId = title !== undefined && title !== null;
  const dialogProps: {
    'aria-labelledby'?: string;
    'aria-label'?: string;
  } = {};
  if (useTitleId) {
    dialogProps['aria-labelledby'] = titleId;
  } else if (ariaLabel !== undefined) {
    dialogProps['aria-label'] = ariaLabel;
  }

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        className={`${styles.dialog} ${sizeClass[size]}`}
        role={role}
        aria-modal="true"
        tabIndex={-1}
        {...dialogProps}
      >
        {(title !== undefined && title !== null) ||
        icon !== undefined ||
        !hideCloseButton ? (
          <header className={styles.head}>
            {icon !== undefined ? (
              <span className={styles.headIcon} aria-hidden="true">
                {icon}
              </span>
            ) : null}
            {title !== undefined && title !== null ? (
              <div className={styles.titleWrap}>
                <h2 id={titleId} className={styles.title}>
                  {title}
                </h2>
                {subtitle !== undefined && subtitle !== null ? (
                  <p className={styles.subtitle}>{subtitle}</p>
                ) : null}
              </div>
            ) : (
              <div className={styles.titleWrap} />
            )}
            {!hideCloseButton ? (
              <button
                type="button"
                className={styles.close}
                onClick={onClose}
                aria-label={t('common.close')}
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            ) : null}
          </header>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export interface ModalBodyProps {
  children: ReactNode;
  /** Optional custom className for one-off overrides. */
  className?: string;
}

export function ModalBody({ children, className }: ModalBodyProps): JSX.Element {
  const cls = className === undefined ? styles.body : `${styles.body} ${className}`;
  return <div className={cls}>{children}</div>;
}

export interface ModalFooterProps {
  children: ReactNode;
  className?: string;
}

export function ModalFooter({
  children,
  className,
}: ModalFooterProps): JSX.Element {
  const cls = className === undefined ? styles.footer : `${styles.footer} ${className}`;
  return <footer className={cls}>{children}</footer>;
}
