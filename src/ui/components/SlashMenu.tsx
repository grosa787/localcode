/**
 * Autocomplete menu for slash commands.
 *
 * Visible only while the user's draft starts with `/`. Filters the
 * registry by name `startsWith(query)`; Arrow Up / Arrow Down / Tab
 * moves the highlight; Enter selects; Escape closes without selection.
 *
 * R19 (Agent 4) — windowed scrolling. The full filtered list used to
 * render every command, which on a small registry was fine but on a
 * larger one (12+ items) filled the entire screen. The menu now shows
 * at most `WINDOW_SIZE` (= 7) commands at a time and scrolls the window
 * the same way VS Code / Sublime Text command palettes do:
 *   - Selection moves with ↑/↓/Tab; the window slides only when the
 *     selection would otherwise leave the visible band.
 *   - Wrap-around: ↓ on the last item jumps to index 0 (and resets the
 *     window to the top); ↑ on the first item jumps to the last (and
 *     anchors the window so the last item is visible).
 *   - When more items exist above/below the window, a small "↑ N more"
 *     / "↓ N more" hint is rendered to signal there's content to
 *     scroll into. Hints are dim and decorative.
 *   - When the filtered list fits inside the window (≤ 7 items), no
 *     scrolling occurs and no hints are rendered — same behaviour as
 *     before R19.
 */

import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { useInputModeHandler, type InputEvent } from './InputDispatcher.js';
import type { SlashCommand } from '../../types/global.js';

export interface SlashMenuProps {
  readonly query: string;
  readonly commands: readonly SlashCommand[];
  readonly onSelect: (cmd: SlashCommand) => void;
  readonly onCancel: () => void;
}

/**
 * Maximum number of commands rendered at once. Picked to match the
 * "comfortable to scan" range used by IDE command palettes (Sublime ~ 8,
 * VS Code ~ 7-10) while leaving headroom for transcript history above
 * the menu when ChatScreen mounts it inline above the InputBar.
 *
 * Exported so tests can pin assertions to the actual constant rather
 * than hard-coding 7 in two places (drift-free).
 */
export const WINDOW_SIZE = 7;

function filterCommands(
  query: string,
  commands: readonly SlashCommand[],
): SlashCommand[] {
  const q = query.replace(/^\//, '').trim().toLowerCase();
  if (q.length === 0) return [...commands];
  return commands.filter((c) => c.name.toLowerCase().startsWith(q));
}

/**
 * Pick the windowStart that keeps `selected` in view while preferring
 * not to leave blank rows at the bottom. Pure function — easy to reason
 * about and easy to unit-test if/when needed.
 *
 * Exported (alongside `WINDOW_SIZE`) so the pagination behaviour can be
 * verified in isolation by tests in
 * `tests/ui/slash-menu-pagination.test.ts` without spinning up an ink
 * render harness.
 */
export function clampWindow(
  prevStart: number,
  selected: number,
  total: number,
): number {
  if (total <= WINDOW_SIZE) return 0;
  let start = prevStart;
  if (selected < start) start = selected;
  if (selected >= start + WINDOW_SIZE) start = selected - WINDOW_SIZE + 1;
  // Don't leave trailing blank rows.
  const maxStart = Math.max(0, total - WINDOW_SIZE);
  if (start > maxStart) start = maxStart;
  if (start < 0) start = 0;
  return start;
}

function SlashMenu({ query, commands, onSelect, onCancel }: SlashMenuProps): React.JSX.Element | null {
  const filtered = useMemo(() => filterCommands(query, commands), [query, commands]);
  // M6 — reset selection + window during the same render as the filter
  // change, using the React docs "Storing information from previous
  // renders" pattern. The old effect ran AFTER the first render with a
  // new query, so there was a paint where `index` still pointed at a
  // stale row (and Enter could mis-fire on the row underneath).
  const [selection, setSelection] = useState<{
    readonly query: string;
    readonly index: number;
    readonly windowStart: number;
  }>(() => ({ query, index: 0, windowStart: 0 }));
  if (selection.query !== query) {
    // setState during render: React re-runs the component with the new
    // state without committing the in-progress render to the DOM. This
    // is the canonical "derive state from props on change" pattern.
    setSelection({ query, index: 0, windowStart: 0 });
  }
  const index = selection.query === query ? selection.index : 0;
  const windowStart = selection.query === query ? selection.windowStart : 0;

  // Defensive clamp when the underlying registry shrinks beneath the
  // current selection (e.g. dynamic command unloads — not used today,
  // but cheap insurance against a future state edge).
  useEffect(() => {
    if (filtered.length === 0) {
      if (index !== 0 || windowStart !== 0) {
        setSelection((s) => ({ ...s, index: 0, windowStart: 0 }));
      }
      return;
    }
    if (index >= filtered.length) {
      const nextIndex = filtered.length - 1;
      const nextWindow = clampWindow(windowStart, nextIndex, filtered.length);
      setSelection((s) => ({
        ...s,
        index: nextIndex,
        windowStart: nextWindow,
      }));
    }
  }, [filtered.length, index, windowStart]);

  const moveSelection = useCallback(
    (delta: 1 | -1): void => {
      const total = filtered.length;
      if (total === 0) return;
      const next =
        delta === 1
          ? (index + 1) % total // wrap forward
          : (index - 1 + total) % total; // wrap backward
      setSelection((s) => ({
        ...s,
        index: next,
        windowStart: clampWindow(s.windowStart, next, total),
      }));
    },
    [filtered.length, index],
  );

  const handleInput = useCallback(
    (event: InputEvent): boolean => {
      const { key } = event;
      if (filtered.length === 0) {
        if (key.escape) {
          onCancel();
          return true;
        }
        // No commands match — let printable text fall through to the
        // InputBar so the user can keep typing.
        return false;
      }
      if (key.upArrow) {
        moveSelection(-1);
        return true;
      }
      if (key.downArrow || key.tab) {
        moveSelection(1);
        return true;
      }
      if (key.return) {
        const chosen = filtered[index];
        if (chosen !== undefined) onSelect(chosen);
        return true;
      }
      if (key.escape) {
        onCancel();
        return true;
      }
      // R7 (Agent 4) — printable text and any other key falls through
      // to the InputBar handler in the same `'input'` mode. The
      // dispatcher walks subscribers LIFO; SlashMenu is registered
      // after InputBar so we get first crack, and returning `false`
      // here passes control down so the user can keep typing the
      // command name.
      return false;
    },
    [filtered, index, moveSelection, onCancel, onSelect],
  );

  // The menu subscribes to `'input'` mode and shares it with the
  // InputBar: navigation keys (↑/↓/Tab/Enter/Esc) are consumed here
  // (return `true`); everything else falls through to the InputBar
  // (return `false`). This replaces the pre-dispatcher pattern where
  // both components called `useInput` directly and the InputBar gated
  // its history-nav off via `disableHistoryNav` to avoid a collision.
  useInputModeHandler('input', handleInput);

  if (filtered.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="gray">No commands match "{query}"</Text>
      </Box>
    );
  }

  const total = filtered.length;
  const start = clampWindow(windowStart, index, total);
  const end = Math.min(start + WINDOW_SIZE, total);
  const visible = filtered.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;

  return (
    <Box flexDirection="column" paddingX={1}>
      {hiddenAbove > 0 && (
        <Text color="gray" dimColor>
          ↑ {hiddenAbove} more
        </Text>
      )}
      {visible.map((cmd, i) => {
        const absoluteIndex = start + i;
        const active = absoluteIndex === index;
        const nameStr = `/${cmd.name}`;
        const usageStr = cmd.usage ?? '';
        const row = active
          ? theme.selected(` ${nameStr.padEnd(12)} ${cmd.description} `)
          : `${theme.cmdName(nameStr.padEnd(12))} ${theme.cmdDesc(cmd.description)}`;
        return (
          <Box key={cmd.name} flexDirection="row">
            <Text>{row}</Text>
            {usageStr.length > 0 && !active && (
              <Text color="gray"> {usageStr}</Text>
            )}
          </Box>
        );
      })}
      {hiddenBelow > 0 && (
        <Text color="gray" dimColor>
          ↓ {hiddenBelow} more
        </Text>
      )}
    </Box>
  );
}

export default SlashMenu;
