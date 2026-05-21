/**
 * ModelPicker — searchable overlay listing available models for the
 * active provider. Mirrors the TUI `/model <query>` interaction.
 *
 * Keyboard:
 *   - ArrowUp / ArrowDown — move highlight
 *   - Enter — select highlighted model
 *   - Esc — close
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type RefObject,
} from 'react';

import { useT } from '../i18n';
import { Check, MessageSquare, Search } from '../icons';
import { useStore } from '../state/store';

import { EmptyState } from './EmptyState';

import styles from './ModelPicker.module.css';

export interface ModelPickerProps {
  onClose: () => void;
  onSelect: (model: string) => void;
  // POPOVER-FLIP-SECTION — parent ModelChip resolves placement and
  // hands the root ref + style to us so flip math can include the
  // overlay's real height.
  popoverRef?: RefObject<HTMLDivElement>;
  positionStyle?: CSSProperties;
  // /POPOVER-FLIP-SECTION
}

export function ModelPicker({
  onClose,
  onSelect,
  popoverRef,
  positionStyle,
}: ModelPickerProps): JSX.Element {
  const t = useT();
  const models = useStore((s) => s.models);
  const currentModel = useStore((s) => s.currentModel);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // POPOVER-FLIP-SECTION
  const internalRootRef = useRef<HTMLDivElement>(null);
  const rootRef = popoverRef ?? internalRootRef;
  // /POPOVER-FLIP-SECTION

  const filtered = useMemo(() => {
    if (query.trim().length === 0) return models;
    const q = query.toLowerCase();
    return models.filter((m) => m.toLowerCase().includes(q));
  }, [models, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep highlight in range when filter changes.
  useEffect(() => {
    if (highlight >= filtered.length) {
      setHighlight(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, highlight]);

  // Global Escape — close even if focus drifts off the dialog.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Close on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (
        listRef.current !== null &&
        e.target instanceof Node &&
        !listRef.current.contains(e.target) &&
        !(inputRef.current?.contains(e.target) ?? false)
      ) {
        onClose();
      }
    };
    // Delay subscription so the click that opened us doesn't close us.
    const t = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const choice = filtered[highlight];
      if (choice !== undefined) onSelect(choice);
      return;
    }
  }, [filtered, highlight, onClose, onSelect]);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      role="dialog"
      aria-label={t('modelPicker.aria')}
      onKeyDown={onKeyDown}
      style={positionStyle}
    >
      <div className={styles.searchRow}>
        <Search size={14} strokeWidth={1.5} />
        <input
          ref={inputRef}
          className={styles.search}
          type="text"
          placeholder={t('modelPicker.filter')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('modelPicker.filterAria')}
        />
      </div>
      {filtered.length === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            icon={MessageSquare}
            title={t('modelPicker.empty.title')}
            description={
              query.length > 0
                ? t('modelPicker.empty.queried', { query })
                : t('modelPicker.empty.none')
            }
          />
        </div>
      ) : (
        <ul className={styles.list} ref={listRef} role="listbox">
          {filtered.map((model, idx) => (
            <li
              key={model}
              role="option"
              aria-selected={model === currentModel}
              className={`${styles.item} ${
                idx === highlight ? styles.highlighted : ''
              } ${model === currentModel ? styles.active : ''}`}
              onMouseEnter={() => setHighlight(idx)}
              onClick={() => onSelect(model)}
            >
              <span className={styles.name}>{model}</span>
              {model === currentModel ? (
                <Check size={14} strokeWidth={1.5} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
