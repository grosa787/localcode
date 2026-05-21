/**
 * SlashAutocomplete — inline popup that appears above the Composer
 * textarea when input matches `/^/[A-Za-z0-9_-]*$/`. The Composer owns
 * keyboard interaction; this component is purely presentational and
 * surfaces hover/click selection via `onPick`.
 */

import { useMemo, type JSX } from 'react';

import { useT } from '../i18n';
import type { CommandSummary } from '../state/store';
import { Slash } from '../icons';

import styles from './SlashAutocomplete.module.css';

export interface SlashAutocompleteProps {
  /** Filtered + sorted command list (caller decides which to render). */
  commands: CommandSummary[];
  /** Currently keyboard-highlighted index. */
  selectedIndex: number;
  /** The query the user typed after `/` — used for the empty-state. */
  query: string;
  /** Called when the user clicks (or hovers + clicks) a row. */
  onPick: (name: string) => void;
  /** Optional hover callback — Composer keeps keyboard + mouse in sync. */
  onHoverIndex?: (index: number) => void;
}

export function SlashAutocomplete(props: SlashAutocompleteProps): JSX.Element {
  const t = useT();
  const { commands, selectedIndex, query, onPick, onHoverIndex } = props;

  const items = useMemo(() => commands, [commands]);

  if (items.length === 0) {
    return (
      <div className={styles.popup} role="listbox" aria-label={t('slash.aria')}>
        <div className={styles.empty}>
          {t('slash.empty.query')} <code>/{query}</code>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.popup} role="listbox" aria-label={t('slash.aria')}>
      {items.map((cmd, idx) => {
        const selected = idx === selectedIndex;
        return (
          <button
            type="button"
            key={cmd.name}
            role="option"
            aria-selected={selected}
            className={styles.row}
            data-selected={selected ? 'true' : 'false'}
            onMouseDown={(e) => {
              // Prevent the textarea from losing focus before onClick fires.
              e.preventDefault();
              onPick(cmd.name);
            }}
            onMouseEnter={() => onHoverIndex?.(idx)}
          >
            <span className={styles.icon} aria-hidden="true">
              <Slash size={12} strokeWidth={1.5} />
            </span>
            <span className={styles.name}>{cmd.name}</span>
            <span className={styles.desc}>{cmd.description}</span>
            {cmd.usage !== undefined && cmd.usage.length > 0 ? (
              <span className={styles.usage}>{cmd.usage}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
