/**
 * BrowserActionLog — scrollable list of recent browser console entries.
 *
 * Auto-scrolls to bottom on new entry; pauses auto-scroll when user
 * scrolls up.
 */

import { useEffect, useRef, useState, type JSX } from 'react';

import { useT } from '../i18n';
import type { BrowserConsoleEntry } from '../state/store';

import styles from './BrowserActionLog.module.css';

const VISIBLE_CAP = 50;

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function levelClass(
  level: BrowserConsoleEntry['level'],
): string | undefined {
  switch (level) {
    case 'error':
      return styles.levelError;
    case 'warn':
      return styles.levelWarn;
    case 'debug':
      return styles.levelDebug;
    default:
      return styles.levelInfo;
  }
}

interface RowProps {
  entry: BrowserConsoleEntry;
}

function LogRow({ entry }: RowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const truncated = entry.text.length > 160;
  const display =
    expanded || !truncated ? entry.text : `${entry.text.slice(0, 160)}…`;
  return (
    <li
      className={styles.row}
      onClick={() => {
        if (truncated) setExpanded((v) => !v);
      }}
    >
      <span className={styles.time}>{formatTime(entry.receivedAt)}</span>
      <span className={`${styles.pill} ${levelClass(entry.level) ?? ''}`}>
        {entry.level}
      </span>
      <span className={styles.text}>{display}</span>
    </li>
  );
}

export interface BrowserActionLogProps {
  entries: readonly BrowserConsoleEntry[];
}

export function BrowserActionLog({
  entries,
}: BrowserActionLogProps): JSX.Element {
  const t = useT();
  const scrollerRef = useRef<HTMLUListElement | null>(null);
  const stickToBottomRef = useRef(true);

  const visible = entries.slice(Math.max(0, entries.length - VISIBLE_CAP));

  useEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visible.length]);

  const handleScroll = (): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 16;
  };

  if (visible.length === 0) {
    return <div className={styles.empty}>{t('browserLog.empty')}</div>;
  }

  return (
    <ul
      ref={scrollerRef}
      className={styles.list}
      onScroll={handleScroll}
      aria-label={t('browserLog.aria')}
    >
      {visible.map((e) => (
        <LogRow key={e.id} entry={e} />
      ))}
    </ul>
  );
}
