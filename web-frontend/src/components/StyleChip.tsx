/**
 * StyleChip — composer chip exposing the active output style. Click
 * opens a small dropdown listing the three styles (concise /
 * explanatory / verbose). Selecting one POSTs `/api/config/output-style`
 * and mirrors the result into the zustand store.
 *
 * Pattern mirrors ProfileChip — same chip / menu CSS, same optimistic-
 * update flow with rollback on persist failure.
 */

import { useCallback, useRef, useState, type JSX } from 'react';

import { useApiClients } from '../App';
import { ChevronDown, MessageSquare } from '../icons';
import { useStore, type OutputStyle } from '../state/store';
// POPOVER-FLIP-SECTION
import { usePopoverPosition } from '../util/use-popover-position';
// /POPOVER-FLIP-SECTION

import styles from './StyleChip.module.css';

export interface StyleChipProps {
  disabled?: boolean;
}

const STYLE_ORDER: readonly OutputStyle[] = [
  'concise',
  'explanatory',
  'verbose',
];

const STYLE_LABELS: Record<OutputStyle, string> = {
  concise: 'Concise',
  explanatory: 'Explanatory',
  verbose: 'Verbose',
};

const STYLE_HINTS: Record<OutputStyle, string> = {
  concise: 'Minimal narration, direct answers.',
  explanatory: 'Include rationale and tradeoffs.',
  verbose: 'Detailed step-by-step commentary.',
};

export function StyleChip({ disabled = false }: StyleChipProps): JSX.Element {
  const outputStyle = useStore((s) => s.outputStyle);
  const setOutputStyle = useStore((s) => s.setOutputStyle);
  const pushToast = useStore((s) => s.pushToast);
  const { rest } = useApiClients();
  const [open, setOpen] = useState(false);
  // POPOVER-FLIP-SECTION
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = usePopoverPosition({
    anchorRef,
    popoverRef: menuRef,
    preferredSide: 'top',
    gap: 6,
    open,
  });
  // /POPOVER-FLIP-SECTION

  const current: OutputStyle = outputStyle ?? 'concise';

  const handleSelect = useCallback(
    (next: OutputStyle): void => {
      setOpen(false);
      if (next === current) return;
      const previous = current;
      // Optimistic update so the chip flips instantly.
      setOutputStyle(next);
      void (async () => {
        try {
          await rest.setOutputStyle({ outputStyle: next });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          pushToast({
            level: 'error',
            message: `Failed to switch output style: ${message}`,
          });
          // Restore the previous selection on persist failure.
          setOutputStyle(previous);
        }
      })();
    },
    [current, pushToast, rest, setOutputStyle],
  );

  return (
    <div className={styles.wrap}>
      <button
        ref={anchorRef}
        type="button"
        className={styles.chip}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Output style: ${STYLE_LABELS[current]}`}
      >
        <MessageSquare size={14} strokeWidth={1.5} aria-hidden="true" />
        <span className={styles.label}>{STYLE_LABELS[current]}</span>
        <ChevronDown size={14} strokeWidth={1.5} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className={styles.menu}
          role="listbox"
          aria-label="Output style"
          style={placement.style}
          data-popover-side={placement.side}
        >
          {STYLE_ORDER.map((s) => {
            const active = s === current;
            return (
              <button
                key={s}
                type="button"
                className={`${styles.option} ${active ? styles.optionActive : ''}`}
                role="option"
                aria-selected={active}
                onClick={() => handleSelect(s)}
              >
                <span>{STYLE_LABELS[s]}</span>
                <span className={styles.optionHint}>{STYLE_HINTS[s]}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
