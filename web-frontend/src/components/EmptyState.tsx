/**
 * EmptyState — generic empty/zero-state slot.
 *
 * Used for empty session lists, empty file trees, empty model picker, and
 * the chat surface placeholder until Agent F's ChatView lands.
 */

import type { ComponentType, ReactNode, SVGProps } from 'react';

import styles from './EmptyState.module.css';

/**
 * Loose icon-component shape — compatible with both lucide-react's
 * `ForwardRefExoticComponent<LucideProps & RefAttributes<SVGSVGElement>>`
 * and any plain SVG functional component.
 */
export type IconLike = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }
>;

export interface EmptyStateProps {
  icon: IconLike;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: EmptyStateProps): JSX.Element {
  return (
    <div className={styles.root} role="status">
      <div className={styles.iconWrap}>
        <Icon size={24} strokeWidth={1.5} />
      </div>
      <p className={styles.title}>{title}</p>
      {description !== undefined ? (
        <p className={styles.description}>{description}</p>
      ) : null}
      {action !== undefined ? (
        <div className={styles.action}>{action}</div>
      ) : null}
    </div>
  );
}
