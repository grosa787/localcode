/**
 * TasksLine — surfaces the active session's todos above the input bar.
 *
 * The component has two modes:
 *
 *   • Collapsed (default) — one-line summary:
 *       `Tasks: 2 done · 1 in progress · 3 pending (press T to expand)`
 *
 *   • Expanded — multi-line list, one row per todo:
 *       `✓ Refactor parser`
 *       `◐ Wire WakeupBadge — Wiring WakeupBadge`
 *       `○ Add tests for compress`
 *
 * Status icons:
 *   - `○` pending
 *   - `◐` in_progress — animated through a 4-frame spinner at 250ms
 *   - `✓` done (completed)
 *
 * Pressing `t` / `T` from `input` mode toggles between collapsed and
 * expanded. The toggle is wired via the existing `InputDispatcher` so
 * the keystroke does not leak into the editor buffer (the dispatcher's
 * LIFO walk lets us claim the key before `InputBar` sees it).
 *
 * Each expanded row is left-truncated to `terminalWidth - 4` characters
 * (icon + space + ellipsis) so rows never wrap mid-line. Empty list →
 * the whole component renders nothing.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text } from 'ink';

import type { Todo } from '@/sessions/session-manager';
import { useInputModeHandler } from './InputDispatcher.js';
import { noxPalette, textMuted } from '../theme.js';

/**
 * Animated spinner for in_progress rows. Four frames cycled at 250ms
 * keep the eye drawn to live work without burning render cycles — the
 * interval is paused (cleared) when the component is collapsed OR
 * there are no active todos so the React render loop stays quiet on
 * the dominant case.
 */
export const TASKS_SPINNER_FRAMES: readonly string[] = ['◐', '◓', '◑', '◒'];
export const TASKS_SPINNER_INTERVAL_MS = 250;

/** Icons for the three terminal states a todo can be in. */
export const TASKS_ICON_PENDING = '○';
export const TASKS_ICON_DONE = '✓';
/** Static fallback icon when the spinner is paused (collapsed mode). */
export const TASKS_ICON_IN_PROGRESS_STATIC = '◐';

export interface TasksLineProps {
  /** Current todos for the active session. Empty array = render nothing. */
  readonly todos: readonly Todo[];
  /**
   * Override the expanded state. When supplied, the component renders
   * the requested mode and ignores the `t`/`T` toggle. Tests pass this
   * directly so they don't have to dispatch keystrokes; production
   * callers leave it `undefined` so the internal toggle is wired up.
   */
  readonly expanded?: boolean;
  /**
   * Terminal width forwarded by the parent. Drives the truncation
   * cut-off for expanded rows. Defaults to 80 columns — the same
   * baseline `<InputBar>` uses when stdout reports an unknown width.
   */
  readonly terminalWidth?: number;
}

/**
 * Pure helper — builds the collapsed-mode summary segments. Exposed so
 * the test suite can validate the wording without mounting ink.
 */
export function buildSummarySegments(todos: readonly Todo[]): string[] {
  const done = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const pending = todos.filter((t) => t.status === 'pending').length;
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} done`);
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  if (pending > 0) parts.push(`${pending} pending`);
  return parts;
}

/**
 * Truncate a single line to `maxWidth` chars with a trailing ellipsis
 * when needed. Returns the input unchanged when it already fits.
 * `maxWidth` is clamped to a 4-char minimum so a tiny terminal still
 * renders something meaningful.
 */
export function truncateRow(text: string, maxWidth: number): string {
  const cap = Math.max(4, maxWidth);
  if (text.length <= cap) return text;
  return `${text.slice(0, cap - 1)}…`;
}

function statusColor(status: Todo['status']): string {
  switch (status) {
    case 'completed':
      return '#86efac'; // green — matches StatusPill success
    case 'in_progress':
      return noxPalette.yellow;
    case 'pending':
      return textMuted;
  }
}

interface RowProps {
  readonly todo: Todo;
  readonly spinnerFrame: string;
  readonly maxWidth: number;
}

function TaskRow({ todo, spinnerFrame, maxWidth }: RowProps): React.JSX.Element {
  // `activeForm` is only meaningful for in_progress entries; the schema
  // requires it for every Todo but the wording only reads sensibly
  // while the work is in flight.
  const trailing =
    todo.status === 'in_progress' &&
    typeof todo.activeForm === 'string' &&
    todo.activeForm.trim().length > 0 &&
    todo.activeForm.trim() !== todo.content.trim()
      ? ` — ${todo.activeForm.trim()}`
      : '';

  const icon =
    todo.status === 'pending'
      ? TASKS_ICON_PENDING
      : todo.status === 'completed'
        ? TASKS_ICON_DONE
        : spinnerFrame;

  // Reserve 2 cells for the icon + separator, leaving the rest for the
  // text. `truncateRow` enforces a sane minimum so tiny terminals don't
  // collapse into garbage.
  const textRoom = maxWidth - 2;
  const line = truncateRow(`${todo.content}${trailing}`, textRoom);

  return (
    <Box flexDirection="row">
      <Text color={statusColor(todo.status)}>{icon} </Text>
      <Text color={todo.status === 'completed' ? textMuted : undefined} dimColor={todo.status === 'completed'}>
        {line}
      </Text>
    </Box>
  );
}

function TasksLineImpl(props: TasksLineProps): React.JSX.Element | null {
  const [internalExpanded, setInternalExpanded] = useState<boolean>(false);
  const expanded =
    props.expanded !== undefined ? props.expanded : internalExpanded;

  // Spinner — only ticks when at least one in_progress row is visible
  // AND the panel is expanded. Otherwise the interval is left
  // uncreated so the React tree stays quiet (this is the cheap-path).
  const [spinnerIdx, setSpinnerIdx] = useState<number>(0);
  const hasInProgress = props.todos.some((t) => t.status === 'in_progress');
  useEffect(() => {
    if (!expanded || !hasInProgress) return undefined;
    const handle = setInterval(() => {
      setSpinnerIdx((prev) => (prev + 1) % TASKS_SPINNER_FRAMES.length);
    }, TASKS_SPINNER_INTERVAL_MS);
    return (): void => {
      clearInterval(handle);
    };
  }, [expanded, hasInProgress]);

  // `t` / `T` toggles collapsed ↔ expanded. We only listen while no
  // override is supplied (tests pass `expanded` directly). The
  // dispatcher is mode-aware so we don't have to re-check overlay /
  // approval state ourselves — it routes only when `mode === 'input'`.
  useInputModeHandler(
    'input',
    useCallback(
      ({ input, key }) => {
        if (props.expanded !== undefined) return; // controlled — no-op
        // Skip when modifier keys are held — `Ctrl+T` / `Meta+T` are
        // reserved for future bindings.
        if (key.ctrl || key.meta) return;
        if (input !== 't' && input !== 'T') return;
        setInternalExpanded((prev) => !prev);
        return true;
      },
      [props.expanded],
    ),
  );

  if (props.todos.length === 0) return null;

  const segments = buildSummarySegments(props.todos);
  const summary = segments.join(' · ');
  const width = props.terminalWidth ?? 80;

  if (!expanded) {
    return (
      <Box flexDirection="row" paddingX={1}>
        <Text dimColor>{'Tasks: '}</Text>
        <Text color="cyan">{summary}</Text>
        <Text color={textMuted} dimColor>{' (press T to expand)'}</Text>
      </Box>
    );
  }

  // Expanded — one row per todo. The header row keeps the summary
  // visible so the user always sees totals at a glance.
  const spinnerFrame =
    TASKS_SPINNER_FRAMES[spinnerIdx] ?? TASKS_ICON_IN_PROGRESS_STATIC;
  // Leave 2 cells of padding for the left gutter so the truncation cap
  // matches what `<Box paddingX={1}>` produces in practice.
  const rowMaxWidth = Math.max(8, width - 2);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row">
        <Text dimColor>{'Tasks: '}</Text>
        <Text color="cyan">{summary}</Text>
        <Text color={textMuted} dimColor>{' (press T to collapse)'}</Text>
      </Box>
      {props.todos.map((todo, i) => (
        <TaskRow
          key={`${i}-${todo.content}`}
          todo={todo}
          spinnerFrame={spinnerFrame}
          maxWidth={rowMaxWidth}
        />
      ))}
    </Box>
  );
}

/**
 * Memoised: every render path either reuses identical todos or rebuilds
 * the snapshot in app.tsx, so referential comparison is correct.
 */
export const TasksLine = React.memo(TasksLineImpl);

export default TasksLine;

/** Test-only namespace. */
export const __test__ = {
  buildSummarySegments,
  truncateRow,
  statusColor,
  TASKS_SPINNER_FRAMES,
  TASKS_SPINNER_INTERVAL_MS,
};
