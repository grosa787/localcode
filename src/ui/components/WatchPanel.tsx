/**
 * WatchPanel — 1-row strip rendered ABOVE the InputBar / StatusPill
 * whenever ≥1 long-running process is registered with the
 * `ProcessMonitor`. Renders nothing when the registry is empty (the
 * common case for users who never invoke `/watch`).
 *
 * Visual contract
 * ---------------
 *   📡 watched(N) • <label> (<state> <dur>) • <label2> (<state> <dur>)
 *
 * `state` colour follows a 3-step ladder mirroring the
 * `LintDiagnostic`/StatusPill vocabulary used elsewhere:
 *
 *   - running (alive)                 → green
 *   - exiting (killed)                → yellow
 *   - exited with non-zero exit code  → red
 *   - exited cleanly (code 0)         → muted grey
 *
 * The panel is purely presentational — the parent (`ChatScreen`) feeds
 * a `WatchedProcess[]` snapshot in via props. ChatScreen subscribes to
 * the `ProcessMonitor` event emitter and re-renders when the list
 * changes. Tests construct props directly so we never spawn real
 * children to verify rendering.
 *
 * Truncation
 * ----------
 * The 1-row contract is hard. Labels get truncated symmetrically with
 * an ellipsis so the row never wraps; if the terminal is narrow enough
 * that even the header `📡 watched(N)` overflows, we surface only the
 * header. The reserved budget per entry shrinks as more entries fit.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
import type { WatchedProcess } from '../../process-monitor/types.js';

export interface WatchPanelProps {
  /** Snapshot from `ProcessMonitor.list()`. */
  readonly processes: readonly WatchedProcess[];
  /**
   * Terminal width in columns. The panel uses this to compute the
   * per-entry label budget so the row never wraps.
   */
  readonly columns: number;
  /**
   * Optional "now" override for the duration formatter. Tests inject a
   * fixed value so `formatDuration` is deterministic; production
   * callers omit this and the panel reads `Date.now()`.
   */
  readonly now?: number;
}

/** Per-state colour role used by the panel (and exposed for tests). */
export const WATCH_PANEL_COLORS: Readonly<{
  readonly header: string;
  readonly running: string;
  readonly exiting: string;
  readonly exitedError: string;
  readonly exitedClean: string;
  readonly separator: string;
}> = {
  header: noxPalette.highlight,
  // Ink does not consume the hex `noxPalette.green` slot (the palette
  // intentionally avoids it), so we use ink's built-in named colours
  // for state hues — they map onto the user's terminal palette and
  // contrast cleanly with the lavender header.
  running: 'green',
  exiting: 'yellow',
  exitedError: 'red',
  exitedClean: textMuted,
  separator: textMuted,
} as const;

/**
 * Classify a `WatchedProcess` into one of the four UI states. Exposed
 * for tests so we can assert the mapping table directly.
 */
export type WatchPanelState = 'running' | 'exiting' | 'exitedError' | 'exitedClean';

export function classifyState(p: WatchedProcess): WatchPanelState {
  if (p.health === 'alive') return 'running';
  if (p.health === 'killed') return 'exiting';
  if (p.exitCode !== null && p.exitCode !== 0) return 'exitedError';
  return 'exitedClean';
}

/** Short label for the state, e.g. `running 12s`. */
export function stateLabel(state: WatchPanelState): string {
  switch (state) {
    case 'running':
      return 'running';
    case 'exiting':
      return 'exiting';
    case 'exitedError':
      return 'exited';
    case 'exitedClean':
      return 'done';
  }
}

/** Format a millisecond duration into a 1..3 char tail. */
export function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '0s';
  if (ms < 1000) return `${Math.max(0, Math.floor(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

/**
 * Cut a label so the visible length is at most `max` codepoints,
 * adding an ellipsis when truncated. Returns the original label
 * unchanged when it already fits.
 */
export function truncateLabel(label: string, max: number): string {
  if (max <= 0) return '';
  if (label.length <= max) return label;
  if (max <= 1) return label.slice(0, max);
  return `${label.slice(0, Math.max(0, max - 1))}…`;
}

interface RenderEntry {
  readonly id: string;
  readonly label: string;
  readonly state: WatchPanelState;
  readonly duration: string;
}

/**
 * Plan the entries the panel will render given the column budget.
 * Returns the entries that fit (in input order) and a flag telling
 * the renderer whether to suppress entries entirely because not even
 * the header fits. Pure — exposed for tests.
 */
export function planEntries(
  processes: readonly WatchedProcess[],
  columns: number,
  now: number,
): { readonly header: string; readonly entries: readonly RenderEntry[] } {
  const header = `📡 watched(${processes.length})`;
  // Drop a tiny margin so we never collide with the right edge.
  const budget = Math.max(0, columns - 2);
  if (budget <= header.length) {
    return { header, entries: [] };
  }
  // Reserve room for `header`, then split the rest evenly between
  // entries. Each entry costs ` • ` (3 cols) plus its label + state +
  // duration suffix. We compute a per-entry budget that always leaves
  // at least 8 cols for the label fragment.
  const remaining = budget - header.length;
  const SEPARATOR_COST = 3; // ` • `
  // Fixed suffix shape is `(<state> <dur>)` — `state` max length is
  // 'exiting' (7) and duration tops out at 4 chars (e.g. `999m` is
  // already exceptional). Cap the suffix at 16 incl parens + space.
  const SUFFIX_RESERVED = 16;
  const minPerEntry = SEPARATOR_COST + SUFFIX_RESERVED + 4; // 4 cols for label.
  const maxEntries = Math.max(1, Math.floor(remaining / minPerEntry));
  const visible = processes.slice(0, maxEntries);
  const perEntryBudget = visible.length > 0
    ? Math.floor(remaining / visible.length)
    : 0;
  const entries: RenderEntry[] = [];
  for (const p of visible) {
    const state = classifyState(p);
    // For active processes the duration counts up from `startedAt`.
    // For exited processes we freeze it at `exitedAt`.
    const endpoint = p.exitedAt ?? now;
    const dur = formatDuration(Math.max(0, endpoint - p.startedAt));
    const suffix = `(${stateLabel(state)} ${dur})`;
    const labelBudget = Math.max(
      4,
      perEntryBudget - SEPARATOR_COST - suffix.length - 1,
    );
    entries.push({
      id: p.id,
      label: truncateLabel(p.label, labelBudget),
      state,
      duration: dur,
    });
  }
  return { header, entries };
}

function stateColor(state: WatchPanelState): string {
  switch (state) {
    case 'running':
      return WATCH_PANEL_COLORS.running;
    case 'exiting':
      return WATCH_PANEL_COLORS.exiting;
    case 'exitedError':
      return WATCH_PANEL_COLORS.exitedError;
    case 'exitedClean':
      return WATCH_PANEL_COLORS.exitedClean;
  }
}

/**
 * Presentational component. Returns `null` when no processes are
 * watched — ChatScreen relies on this to stay clean in the common case.
 */
function WatchPanelImpl(props: WatchPanelProps): React.JSX.Element | null {
  const { processes, columns } = props;
  if (processes.length === 0) return null;
  const now = props.now ?? Date.now();
  const plan = planEntries(processes, columns, now);
  return (
    <Box paddingX={1} flexDirection="row" width="100%">
      <Text color={WATCH_PANEL_COLORS.header}>{plan.header}</Text>
      {plan.entries.map((entry) => (
        <React.Fragment key={entry.id}>
          <Text color={WATCH_PANEL_COLORS.separator}> • </Text>
          <Text>
            {entry.label}{' '}
          </Text>
          <Text color={stateColor(entry.state)}>
            ({stateLabel(entry.state)} {entry.duration})
          </Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

const WatchPanel = React.memo(WatchPanelImpl);

export default WatchPanel;
