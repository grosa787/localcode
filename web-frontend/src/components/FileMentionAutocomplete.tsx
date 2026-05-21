/**
 * FileMentionAutocomplete — inline popup above the Composer that appears
 * while the user is typing an `@<query>` token. Filesystem entries are
 * fetched from `/api/files/tree` via the RestClient passed from the
 * Composer; results are filtered against the query substring.
 *
 * Purely presentational: the Composer owns keyboard interaction and
 * surfaces hover / click selection through `onPick`.
 */

import { useMemo, type JSX } from 'react';

import { useT } from '../i18n';
import { File as FileIcon, Folder } from '../icons';

import styles from './FileMentionAutocomplete.module.css';

export interface FileMentionEntry {
  /** Project-relative path (e.g. `src/components/Foo.tsx`). */
  path: string;
  /** Final path segment used as the visible label. */
  name: string;
  kind: 'file' | 'dir';
}

export interface FileMentionAutocompleteProps {
  /** Filtered, ordered entries — caller decides which to render. */
  entries: FileMentionEntry[];
  /** Index of the keyboard-highlighted row. */
  selectedIndex: number;
  /** Substring after `@` — used in the empty state hint. */
  query: string;
  /** True while the file tree request is in flight. */
  loading: boolean;
  /** Pick handler — Composer inserts the path into the textarea. */
  onPick: (entry: FileMentionEntry) => void;
  /** Mouse-hover keeps keyboard state in sync. */
  onHoverIndex?: (index: number) => void;
}

export function FileMentionAutocomplete(
  props: FileMentionAutocompleteProps,
): JSX.Element {
  const t = useT();
  const { entries, selectedIndex, query, loading, onPick, onHoverIndex } = props;

  const rows = useMemo(() => entries, [entries]);

  if (loading && rows.length === 0) {
    return (
      <div
        className={styles.popup}
        role="listbox"
        aria-label={t('composer.mention.aria')}
      >
        <div className={styles.empty}>{t('composer.mention.loading')}</div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        className={styles.popup}
        role="listbox"
        aria-label={t('composer.mention.aria')}
      >
        <div className={styles.empty}>
          {t('composer.mention.empty')}{' '}
          <code>@{query}</code>
        </div>
      </div>
    );
  }

  return (
    <div
      className={styles.popup}
      role="listbox"
      aria-label={t('composer.mention.aria')}
    >
      {rows.map((entry, idx) => {
        const selected = idx === selectedIndex;
        const Icon = entry.kind === 'dir' ? Folder : FileIcon;
        // Show the parent directory next to the leaf name so collisions
        // (e.g. several `index.ts`) are distinguishable.
        const slash = entry.path.lastIndexOf('/');
        const parent = slash === -1 ? '' : entry.path.slice(0, slash);
        return (
          <button
            type="button"
            key={`${entry.kind}:${entry.path}`}
            role="option"
            aria-selected={selected}
            className={styles.row}
            data-selected={selected ? 'true' : 'false'}
            onMouseDown={(e) => {
              // Prevent the textarea from losing focus before onClick.
              e.preventDefault();
              onPick(entry);
            }}
            onMouseEnter={() => onHoverIndex?.(idx)}
          >
            <span className={styles.icon} aria-hidden="true">
              <Icon size={12} strokeWidth={1.5} />
            </span>
            <span className={styles.name}>{entry.name}</span>
            {parent.length > 0 ? (
              <span className={styles.parent}>{parent}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
