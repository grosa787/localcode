/**
 * ModalFrame — polished overlay frame used by the new exclusive-overlay
 * machinery (`OverlayHost`). Composes the shared `<Modal>` primitive
 * (which already owns backdrop, ESC, focus trap, scroll lock, and a11y
 * wiring) and adds:
 *
 *   - A deliberately sized card (max-width 960px, max-height 80vh)
 *   - Header bar with title slot + close (X) button
 *   - Body slot — vertical scroll
 *   - Optional footer slot for action buttons
 *   - Stronger enter / exit animation (handled by ModalFrame.module.css)
 *   - `prefers-reduced-motion` respected via CSS @media
 *
 * Existing overlays may continue to use `<Modal>` directly; new overlays
 * (or migrated overlays that want the polished look) should wrap their
 * body in `<ModalFrame>` instead.
 */

import type { JSX, ReactNode } from 'react';

import { Modal, ModalBody, ModalFooter } from './Modal';
import styles from './ModalFrame.module.css';

export type ModalFrameSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalFrameProps {
  /** When `false`, ModalFrame renders nothing — match `<Modal>`'s open contract. */
  open?: boolean;
  /** Fires on ESC, backdrop click, and close-button click. */
  onClose: () => void;
  /** Header title rendered top-left. Either this or `ariaLabel` must be set. */
  title?: ReactNode;
  /** Optional one-line subtitle below the title. */
  subtitle?: ReactNode;
  /** Optional icon node painted to the left of the title. */
  icon?: ReactNode;
  /** Accessible label used when no visible title is provided. */
  ariaLabel?: string;
  /** Width preset — default `lg` (matches the 960px requirement). */
  size?: ModalFrameSize;
  /** Hide the close (X) button — caller owns dismissal. */
  hideCloseButton?: boolean;
  /** Body content. */
  children: ReactNode;
  /** Optional footer (action buttons row). */
  footer?: ReactNode;
}

/**
 * Polished modal frame. Backdrop dim + blur + focus trap + ESC handling
 * are inherited from the underlying `<Modal>` primitive. The extra
 * styling here lives in `ModalFrame.module.css`.
 */
export function ModalFrame({
  open = true,
  onClose,
  title,
  subtitle,
  icon,
  ariaLabel,
  size = 'lg',
  hideCloseButton = false,
  children,
  footer,
}: ModalFrameProps): JSX.Element | null {
  return (
    <Modal
      open={open}
      onClose={onClose}
      {...(title !== undefined ? { title } : {})}
      {...(subtitle !== undefined ? { subtitle } : {})}
      {...(icon !== undefined ? { icon } : {})}
      {...(ariaLabel !== undefined ? { ariaLabel } : {})}
      size={size}
      hideCloseButton={hideCloseButton}
    >
      <ModalBody className={styles.body}>{children}</ModalBody>
      {footer !== undefined && footer !== null ? (
        <ModalFooter className={styles.footer}>{footer}</ModalFooter>
      ) : null}
    </Modal>
  );
}
