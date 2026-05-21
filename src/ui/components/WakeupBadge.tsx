/**
 * Terminal counterpart of the web `WakeupBadge`. Renders a small pill
 * `⏰ N` showing how many wakeups the process scheduler is holding for
 * the active session. When the count is `0` the component renders
 * nothing — there's no value drawing attention to an empty queue and
 * the statusline row stays compact.
 *
 * Data flow:
 *   - Subscribes to the process-wide `WakeupRegistry` singleton via
 *     `registry.subscribe(...)`. The subscribe callback fires once
 *     eagerly on mount (see `WakeupRegistry.subscribe`) so the badge
 *     renders the correct count without a first-frame flash.
 *   - When `sessionId` is supplied, the badge filters the snapshot to
 *     entries that match that session id so the badge stays
 *     session-scoped (consistent with the web badge, which reads
 *     `pendingWakeups[activeSessionId]`).
 *   - When `sessionId` is omitted, the badge reflects the global
 *     pending count — useful for tests and the standalone launcher
 *     screen before a session has been picked.
 *
 * For details on the per-session count UI press `/wakeups` — the slash
 * command opens a full list. The badge is intentionally just a glance
 * widget; click is not a thing in a terminal.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

import { noxPalette, textMuted } from '../theme.js';
import {
  getProcessWakeupRegistry,
  type ScheduledWakeup,
  type WakeupRegistry,
} from '@/scheduling';

export interface WakeupBadgeProps {
  /**
   * Active session id. When supplied, the badge counts only wakeups
   * scheduled against this session. Undefined → counts every wakeup
   * the singleton registry holds (test + bootstrap behaviour).
   */
  readonly sessionId?: string;
  /**
   * Override the registry — tests inject a freshly constructed
   * `WakeupRegistry` so they don't depend on whatever the composition
   * root happened to install. Defaults to `getProcessWakeupRegistry()`.
   */
  readonly registry?: WakeupRegistry;
}

/**
 * Filter helper exposed for tests. Pulled out of the render so the
 * filter contract is verifiable without mounting ink.
 */
export function filterForSession(
  snapshot: readonly ScheduledWakeup[],
  sessionId: string | undefined,
): readonly ScheduledWakeup[] {
  if (sessionId === undefined) return snapshot;
  return snapshot.filter((w) => w.sessionId === sessionId);
}

function WakeupBadgeImpl(props: WakeupBadgeProps): React.JSX.Element | null {
  const registry = props.registry ?? getProcessWakeupRegistry();
  // We keep the raw snapshot in state because the registry-level
  // `subscribe` callback already fires once eagerly on subscription
  // (see `WakeupRegistry.subscribe`). Initialising via the lazy form
  // would mean two reads (one for state, one in the first effect tick)
  // — `[]` is the safe, allocation-free default.
  const [snapshot, setSnapshot] = useState<readonly ScheduledWakeup[]>(
    () => registry.list(),
  );

  useEffect(() => {
    // `subscribe` returns the unsubscribe fn AND fires the listener
    // once eagerly with the current list — so we don't need a
    // separate initial read.
    const unsubscribe = registry.subscribe((next) => {
      setSnapshot(next);
    });
    return unsubscribe;
  }, [registry]);

  const scoped = filterForSession(snapshot, props.sessionId);
  const count = scoped.length;

  if (count === 0) return null;

  return (
    <Box flexDirection="row" paddingX={1}>
      <Text color={textMuted}>[ </Text>
      <Text color={noxPalette.yellow}>{`⏰ ${count}`}</Text>
      <Text color={textMuted}> ]</Text>
    </Box>
  );
}

/**
 * `React.memo` — props are primitives + a stable reference to the
 * registry singleton, so `Object.is` is the correct comparator. Cuts
 * re-renders when the parent (e.g. statusline row) repaints for an
 * unrelated reason (cursor blink, paste-pill animation).
 */
const WakeupBadge = React.memo(WakeupBadgeImpl);

export default WakeupBadge;

/** Test-only namespace export. */
export const __test__ = {
  filterForSession,
};
