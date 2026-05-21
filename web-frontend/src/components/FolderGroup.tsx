/**
 * FolderGroup — collapsible folder header in the sidebar tree.
 *
 * Renders the folder chevron + basename + child count. The full path is
 * exposed via the `title` attribute for hover tooltips. Children are
 * rendered by the caller and shown only when `expanded` is true.
 */

import type { ReactNode } from 'react';

import { ChevronDown, ChevronRight, Folder, FolderOpen } from '../icons';
import styles from './FolderGroup.module.css';

export interface FolderGroupProps {
  /** Absolute project root path — surfaced via title. */
  path: string;
  /** Display label (typically basename of `path`). */
  label: string;
  /** Number of sessions in this folder, shown as a small badge. */
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}

export function FolderGroup({
  path,
  label,
  count,
  expanded,
  onToggle,
  children,
}: FolderGroupProps): JSX.Element {
  const Chev = expanded ? ChevronDown : ChevronRight;
  const Fold = expanded ? FolderOpen : Folder;
  return (
    <div className={styles.root}>
      <button
        type="button"
        className={styles.header}
        onClick={onToggle}
        aria-expanded={expanded}
        title={path}
      >
        <Chev size={14} strokeWidth={1.5} className={styles.chev} />
        <Fold size={14} strokeWidth={1.5} className={styles.folder} />
        <span className={styles.label}>{label}</span>
        <span className={styles.count}>{count}</span>
      </button>
      {expanded ? <div className={styles.body}>{children}</div> : null}
    </div>
  );
}
