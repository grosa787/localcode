/**
 * AgentInlineMessage — collapsible block rendering a single TeamBus
 * message inline in the main chat stream.
 *
 *   ▾ a1b2c3 · debugger · 12:31:05
 *     Worker said: "investigating the crash; the stack points to
 *     `parseConfig` — looks like a missing await."
 *
 * Layout invariants
 * -----------------
 *   - **Default collapsed.** The header alone takes one row so a long
 *     fan-out of `agent_team_message` events never dominates the
 *     viewport. The user expands via Enter / Right arrow when the
 *     'agent-tail' dispatcher mode is active.
 *
 *   - **Muted header.** Foreground sits on `textMuted` so the inline
 *     block reads as ambient telemetry, not a normal assistant message.
 *
 *   - **No mutation of session history.** The component is pure
 *     presentational chrome — props in, JSX out. The host (ChatScreen)
 *     owns the open/close state via the agent-tail store / reducer so
 *     scroll behaviour stays predictable when the entry is re-rendered.
 */

import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import {
  useInputModeHandler,
  type InputEvent,
} from './InputDispatcher.js';
import { noxPalette, textMuted } from '../theme.js';
import type { AgentTailEntry } from '../agent-tail-store.js';

export interface AgentInlineMessageProps {
  readonly entry: AgentTailEntry;
  /** Whether the body is expanded (rendered) or collapsed (header only). */
  readonly expanded: boolean;
  /**
   * When true, the inline block participates in the 'agent-tail'
   * dispatcher mode: it owns Enter and the Right arrow key to toggle
   * expansion. The reducer wires this to the focused entry index so
   * only one block at a time hears the keystroke; ChatScreen ensures
   * that's the case before passing `focused={true}` down.
   */
  readonly focused: boolean;
  /** Called when the focused block handled an expansion keystroke. */
  readonly onToggleExpand: () => void;
}

/**
 * Format a `Date.now()` timestamp into `HH:MM:SS` for the header. Local
 * time, zero-padded — matches the convention used by the worktree GC's
 * logs.
 */
export function formatTailTimestamp(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function AgentInlineMessageImpl({
  entry,
  expanded,
  focused,
  onToggleExpand,
}: AgentInlineMessageProps): React.JSX.Element {
  const handle = useCallback(
    (event: InputEvent): boolean | void => {
      if (!focused) return;
      if (event.key.return || event.key.rightArrow) {
        onToggleExpand();
        return true;
      }
      return undefined;
    },
    [focused, onToggleExpand],
  );

  useInputModeHandler('agent-tail', handle);

  const arrow = expanded ? '▾' : '▸';
  const ts = formatTailTimestamp(entry.at);
  // Header glyph swaps colour when this entry is focused so the user
  // can tell which block Enter is going to expand.
  const arrowColor = focused ? noxPalette.yellow : textMuted;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row">
        <Text color={arrowColor}>{arrow} </Text>
        <Text color={textMuted}>
          {entry.agentId} · {entry.templateName} · {ts}
        </Text>
        {entry.to !== 'all' && entry.to !== 'lead' && (
          <Text color={textMuted}>{` → ${entry.to}`}</Text>
        )}
      </Box>
      {expanded && entry.message.length > 0 && (
        <Box paddingLeft={2}>
          <Text color={textMuted}>{entry.message}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Memoised export — the inline block re-renders frequently (every
 * keystroke into the composer bumps ChatScreen's parent). Memoising
 * on (entry identity, expanded, focused) keeps the dim block stable
 * during streaming.
 */
export const AgentInlineMessage = React.memo(
  AgentInlineMessageImpl,
  (a, b) =>
    a.entry === b.entry &&
    a.expanded === b.expanded &&
    a.focused === b.focused &&
    a.onToggleExpand === b.onToggleExpand,
);

export default AgentInlineMessage;
