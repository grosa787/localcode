/**
 * AgentPanel — multi-agent worker list rendered UNDER the InputBar.
 *
 * Wave 5A (TA team — TA1). The TUI mirror of the web's AgentTeamPanel:
 * shows the active lead session at the top and every spawned worker
 * below, with status icons, last-message previews and a selected-row
 * highlight. When the user is in `agent-focus` input mode, arrow keys
 * walk the selection and Enter attaches the composer to that worker.
 *
 * Reactive data source
 * --------------------
 * The orchestrator emits events (`agent_spawned`, `agent_status`,
 * `agent_completed`, `agent_team_message`) and exposes a synchronous
 * `list(parentSessionId)` snapshot. Composition root subscribes once,
 * builds a `readonly AgentRow[]` from those events + the live snapshot,
 * and passes the array down here as `workers`. The panel is pure
 * presentational — no orchestrator reference; that keeps tests cheap
 * (one fixture array vs. a full orchestrator wire-up).
 *
 * Layout invariants
 * -----------------
 *   - **Never unmounts mid-session.** This is the same rule as `<Static>`:
 *     ink would otherwise reflow scrollback and the panel's lead row
 *     would visually drift between renders. So the empty-state case
 *     returns `null` from the *parent* (ChatScreen mounts it only when
 *     `workers.length > 0`), not from this component — once mounted,
 *     this component renders SOMETHING every frame.
 *   - **No height surprises.** Rows render flat (no nested borders), one
 *     terminal row per worker plus one for the lead. Maximum visible
 *     row count is capped at MAX_VISIBLE so a fan-out of 5 workers never
 *     dominates the viewport.
 *   - **Narrow-terminal fallback.** Below 60 columns, the last-message
 *     preview is dropped and only the id + status appear.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
import type { AgentStatus } from '@/agents/types';

/**
 * One row's worth of data the panel renders. Composition root populates
 * this from `orchestrator.list(sessionId)` + the latest status snapshot
 * (and from team-bus messages for `lastMessage`). The shape is kept
 * intentionally narrow so tests can supply a literal array without
 * dragging in the orchestrator factory.
 */
export interface AgentRow {
  readonly agentId: string;
  /** Template id (`debugger`, `reviewer`, …) or model id when absent. */
  readonly label: string;
  readonly status: AgentStatus;
  /**
   * Last visible text from the worker — trimmed to ~80 chars by the
   * orchestrator. May be undefined for a freshly-spawned worker that
   * hasn't streamed any text yet.
   */
  readonly lastMessage?: string;
}

export interface AgentPanelProps {
  readonly workers: readonly AgentRow[];
  readonly leadModel: string;
  readonly leadStreaming: boolean;
  /**
   * Index into `workers` of the currently-highlighted row. Out-of-range
   * values are clamped silently (the reducer guards this but defensive
   * narrowing keeps the panel safe when a fixture array is shorter than
   * the cached index).
   */
  readonly selectedIdx: number;
  /**
   * When true, the user has pressed Tab and the panel owns input. We
   * render the selected-row highlight with the brighter accent + arrow.
   * When false, the row still renders but without the selection chrome
   * — the panel is then read-only telemetry.
   */
  readonly focused: boolean;
  /**
   * Agent id the composer is currently attached to. `'lead'` means the
   * normal chat path. Marked with a small `→` chip next to the worker
   * row so the user knows where the next Enter lands.
   */
  readonly currentConversant: 'lead' | string;
  /**
   * Terminal width in columns; the panel uses this to decide whether to
   * render the `lastMessage` preview. Defaults to 80 when undefined.
   */
  readonly columns?: number;
  // AGENT-LIFECYCLE-SECTION
  /**
   * When false (default) the panel hides terminated agents
   * (done/failed/cancelled). When true it surfaces them under the live
   * roster with a faded chrome. Toggled at the composition-root level —
   * the panel itself stays purely presentational.
   */
  readonly showHistory?: boolean;
  // AGENT-LIFECYCLE-SECTION-END
}

/** Cap on visible worker rows. Excess rows render a `+N more` indicator. */
const MAX_VISIBLE = 5;

/** Below this column count the lastMessage preview is dropped. */
const PREVIEW_MIN_COLUMNS = 60;

/** Map a status to a single glyph + colour. */
function statusGlyph(status: AgentStatus): { glyph: string; color: string } {
  switch (status) {
    case 'running':
      // Half-circle — matches the running indicator used in the web
      // panel. The spinner-style animation would be nice but ink's
      // throttled re-render makes a single static glyph more reliable
      // on slow terminals (and avoids burning CPU at 80ms cadence).
      return { glyph: '◐', color: noxPalette.highlight };
    case 'done':
      return { glyph: '✓', color: '#86efac' };
    case 'failed':
      return { glyph: '✗', color: '#fca5a5' };
    case 'cancelled':
      return { glyph: '⏸', color: noxPalette.yellow };
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return { glyph: '·', color: textMuted };
    }
  }
}

/**
 * Compact preview — clamps to ~50 chars and replaces internal newlines
 * with spaces so the row stays single-line. Empty string returns null.
 */
function previewOf(text: string | undefined, max: number): string | null {
  if (text === undefined) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function AgentPanelImpl(props: AgentPanelProps): React.JSX.Element {
  const {
    workers,
    leadModel,
    leadStreaming,
    selectedIdx,
    focused,
    currentConversant,
    columns,
    showHistory = false,
  } = props;

  const showPreview =
    columns === undefined || columns >= PREVIEW_MIN_COLUMNS;
  const previewBudget = showPreview ? 50 : 0;

  // AGENT-LIFECYCLE-SECTION
  // By default the panel only renders currently-running workers — the
  // composition root keeps terminated rows around in case the user
  // toggles the history view (`showHistory`), but they don't dominate
  // the "what's still in flight" view that drives the operator's
  // attention.
  const visibleWorkers = showHistory
    ? workers
    : workers.filter((w) => w.status === 'running');
  // AGENT-LIFECYCLE-SECTION-END

  // Clamp selectedIdx defensively — the reducer guards normal flows but
  // a worker terminating between dispatch + render could leave it stale.
  const clampedIdx =
    visibleWorkers.length === 0
      ? 0
      : selectedIdx < 0
        ? 0
        : selectedIdx >= visibleWorkers.length
          ? visibleWorkers.length - 1
          : selectedIdx;

  const visible = visibleWorkers.slice(0, MAX_VISIBLE);
  const overflow = visibleWorkers.length - visible.length;

  const leadIsCurrent = currentConversant === 'lead';

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {/* Lead row — anchored at the top so the operator always knows
          the parent session's status even when scrolled past the lead's
          last message. */}
      <Box flexDirection="row">
        <Text color={noxPalette.primary}>{'▎ '}</Text>
        <Text color={noxPalette.white} bold>
          {'lead'}
        </Text>
        <Text color={textMuted}> · </Text>
        <Text color={textMuted}>{leadModel}</Text>
        <Text color={textMuted}> · </Text>
        <Text color={leadStreaming ? noxPalette.highlight : textMuted}>
          {leadStreaming ? 'streaming' : 'idle'}
        </Text>
        {leadIsCurrent && (
          <>
            <Text color={textMuted}>{'  '}</Text>
            <Text color={noxPalette.yellow}>{'→ active'}</Text>
          </>
        )}
      </Box>
      {visible.map((row, i) => {
        const isSelected = focused && i === clampedIdx;
        const isAttached = currentConversant === row.agentId;
        const { glyph, color } = statusGlyph(row.status);
        const preview = previewBudget > 0 ? previewOf(row.lastMessage, previewBudget) : null;
        return (
          <Box flexDirection="row" key={row.agentId}>
            <Text color={isSelected ? noxPalette.yellow : noxPalette.primary}>
              {isSelected ? '▶ ' : '▎ '}
            </Text>
            <Text color={color}>{glyph}</Text>
            <Text color={textMuted}> </Text>
            <Text
              color={isSelected ? noxPalette.white : textMuted}
              bold={isSelected}
            >
              {row.agentId}
            </Text>
            <Text color={textMuted}> · </Text>
            <Text color={textMuted}>{row.label}</Text>
            <Text color={textMuted}> · </Text>
            <Text color={color}>{row.status}</Text>
            {isAttached && (
              <>
                <Text color={textMuted}>{'  '}</Text>
                <Text color={noxPalette.yellow}>{'→ active'}</Text>
              </>
            )}
            {preview !== null && (
              <>
                <Text color={textMuted}>{'  | '}</Text>
                <Text color={textMuted} dimColor>
                  {preview}
                </Text>
              </>
            )}
          </Box>
        );
      })}
      {overflow > 0 && (
        <Box>
          <Text color={textMuted} dimColor>
            {`  +${overflow} more`}
          </Text>
        </Box>
      )}
      {focused && (
        <Box marginTop={0}>
          <Text color={textMuted} dimColor>
            {'  ↑/↓ select · Enter attach · Tab/Esc exit'}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * L5-style memo: the panel re-renders frequently (every orchestrator
 * event bumps `workers`). Memoise so unrelated parent re-renders (the
 * StreamTimer ticks, the spinner frame, etc.) don't re-paint the
 * row list when nothing actually changed.
 */
export const AgentPanel = React.memo(AgentPanelImpl);

export default AgentPanel;
