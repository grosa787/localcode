/**
 * WakeupBadge — small badge in the ProjectBar showing the count of
 * pending wakeups for the active session. Mounts only when at least
 * one wakeup is pending; hover reveals a tooltip with reason + first
 * 80 chars of the prompt for each entry.
 *
 * Data source: `pendingWakeups[activeSessionId]` from the zustand store,
 * fed by the `wakeups_updated` WS frame.
 */

import { useMemo, type JSX } from 'react';

import { Clock } from '../icons';
import { useStore } from '../state/store';

import styles from './WakeupBadge.module.css';

function fmtFireIn(fireAt: number, now: number): string {
  const deltaMs = Math.max(0, fireAt - now);
  const totalSec = Math.round(deltaMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
}

export function WakeupBadge(): JSX.Element | null {
  const activeSessionId = useStore((s) => s.activeSessionId);
  const pendingWakeups = useStore((s) => s.pendingWakeups);
  const wakeups = useMemo(
    () => (activeSessionId !== null ? pendingWakeups[activeSessionId] ?? [] : []),
    [activeSessionId, pendingWakeups],
  );

  if (wakeups.length === 0) return null;

  const now = Date.now();

  return (
    <div className={styles.wrap}>
      <span
        className={styles.badge}
        title={`${wakeups.length} pending wakeup${wakeups.length === 1 ? '' : 's'}`}
        aria-label={`Pending wakeups: ${wakeups.length}`}
      >
        <Clock size={12} strokeWidth={1.5} aria-hidden="true" />
        {wakeups.length}
      </span>
      <div className={styles.tooltip} role="tooltip">
        {wakeups.map((w) => (
          <div key={w.id} className={styles.tooltipRow}>
            <span className={styles.tooltipReason}>{w.reason}</span>
            <span className={styles.tooltipPrompt}>{w.prompt.slice(0, 80)}</span>
            <span className={styles.tooltipMeta}>
              fires in {fmtFireIn(w.fireAt, now)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
