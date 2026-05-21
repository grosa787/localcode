/**
 * SkeletonRow — placeholder row for sidebar/session list while loading.
 * 1.4s sine pulse on bg-hover ↔ bg-elevated, per design spec.
 */

import styles from './SkeletonRow.module.css';

export function SkeletonRow(): JSX.Element {
  return (
    <div className={styles.root} aria-hidden="true">
      <div className={`${styles.line} ${styles.lineTitle}`} />
      <div className={`${styles.line} ${styles.lineSub}`} />
    </div>
  );
}
