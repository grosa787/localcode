/**
 * Arrow-navigable list of available models. Shown when the user runs
 * `/model` without arguments (or triggers it from anywhere else).
 *
 * Hotkeys (browse mode — default):
 *   ↑/↓        navigate (wraps at edges)
 *   Enter      select and dispatch `onSelect(model)`
 *   /          enter search mode (live substring filter)
 *   r          refresh (if `onRefresh` provided)
 *   Esc        `onCancel()` and return to the chat
 *
 * Hotkeys (search mode — after `/`):
 *   <chars>    typing updates the filter live
 *   Enter      exit search mode (filter stays applied; first match
 *              becomes the highlighted row)
 *   Esc        exit search mode (filter stays applied)
 *
 * R28 (Agent 4) — windowed scrolling. The full model list used to render
 * every entry, which on a small registry was fine but on OpenRouter
 * (200+ models) filled and overflowed the terminal: arrow navigation
 * moved the highlight off the visible area, leaving the user with no
 * idea which row was selected. The screen now mirrors the SlashMenu R19
 * pattern: at most `WINDOW_SIZE` (= 10) rows are rendered at a time and
 * the window slides only when the selection would otherwise leave the
 * visible band. A larger WINDOW_SIZE than SlashMenu (10 vs 7) is
 * deliberate — model lists are typically longer and the screen is
 * full-height (not inline), so we have headroom.
 *
 *   - Selection moves with ↑/↓; the window slides only when the
 *     selection would otherwise leave the visible band.
 *   - Wrap-around: ↓ on the last item jumps to index 0 (and resets the
 *     window to the top); ↑ on the first item jumps to the last (and
 *     anchors the window so the last item is visible).
 *   - When more items exist above/below the window, a small "↑ N more"
 *     / "↓ N more" hint is rendered to signal there's content to
 *     scroll into. Hints are dim and decorative.
 *   - When the list fits inside the window (≤ 10 items), no scrolling
 *     occurs and no hints are rendered — same behaviour as before R28.
 *
 * R29 (Agent 4) — inline filter / search. With OpenRouter exposing
 * 200+ models, browsing alone is unusably slow even with windowed
 * scroll. Two complementary affordances were added:
 *
 *   1. `initialFilter` prop — the slash-command parser can pre-seed
 *      the filter (e.g. `/model claude` lands on a list pre-narrowed
 *      to Claude models). Agent 8 will wire this through.
 *   2. Inline search input. `/` enters search mode, where typing
 *      updates `filter` live. Esc/Enter exits search mode but keeps
 *      the filter applied — the user is then back in browse mode,
 *      arrowing through the narrowed list. Esc in browse mode still
 *      cancels the overlay (existing behaviour).
 *
 * Selection state (`index`, `windowStart`) operates over the
 * *filtered* list, not the raw `available` list. Whenever the filter
 * changes, both reset to 0 so the user always sees the first match
 * highlighted (otherwise typing a query that excludes the current
 * highlight could leave the cursor floating off-list).
 *
 * Empty result handling — if `filter` matches nothing we render a
 * yellow "No models match …" hint inside the same vertical slot the
 * list would have used, so the layout below (footer hint) doesn't
 * jump as the user types.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { theme } from '../theme.js';

export interface ModelSelectScreenProps {
  readonly available: readonly string[];
  readonly current: string;
  readonly onSelect: (model: string) => void;
  readonly onCancel: () => void;
  readonly onRefresh?: () => void;
  /**
   * Pre-seeded filter query — typically supplied by the slash-command
   * parser when the user types e.g. `/model claude`. The screen opens
   * in browse mode (not search mode) with this filter already applied,
   * so arrows navigate the narrowed list immediately. The user can
   * still press `/` to refine further.
   */
  readonly initialFilter?: string;
}

/**
 * Maximum number of models rendered at once. Picked to match the
 * "comfortable to scan" range used by IDE quick-pick dropdowns while
 * leaving headroom for the screen header (logo + prompt) and the
 * footer hint above/below the list inside an 80x24 terminal.
 *
 * Exported so any future test can pin assertions to the actual constant
 * rather than hard-coding 10 in two places (drift-free).
 */
export const WINDOW_SIZE = 10;

/**
 * Pick the windowStart that keeps `selected` in view while preferring
 * not to leave blank rows at the bottom. Pure function — easy to reason
 * about and easy to unit-test if/when needed.
 *
 * Mirrors `SlashMenu.clampWindow` (R19) so the two menus behave
 * identically from a user's perspective.
 */
export function clampWindow(
  prevStart: number,
  selected: number,
  total: number,
): number {
  if (total <= WINDOW_SIZE) return 0;
  let start = prevStart;
  // Selection above current window — scroll up so it becomes the top row.
  if (selected < start) start = selected;
  // Selection below current window — scroll down so it becomes the
  // bottom row.
  if (selected >= start + WINDOW_SIZE) start = selected - WINDOW_SIZE + 1;
  // Don't leave trailing blank rows at the bottom of the list.
  const maxStart = Math.max(0, total - WINDOW_SIZE);
  if (start > maxStart) start = maxStart;
  if (start < 0) start = 0;
  return start;
}

/**
 * Apply the (case-insensitive, trimmed) substring filter to the raw
 * model list. Exported for symmetry with `clampWindow` so any future
 * test can pin behaviour without reaching into the component.
 */
export function applyFilter(
  available: readonly string[],
  filter: string,
): readonly string[] {
  const q = filter.trim().toLowerCase();
  if (q.length === 0) return available;
  return available.filter((m) => m.toLowerCase().includes(q));
}

function ModelSelectScreen({
  available,
  current,
  onSelect,
  onCancel,
  onRefresh,
  initialFilter,
}: ModelSelectScreenProps): React.JSX.Element {
  const [filter, setFilter] = useState<string>(initialFilter ?? '');
  const [searchMode, setSearchMode] = useState<boolean>(false);

  const filtered = useMemo(
    () => applyFilter(available, filter),
    [available, filter],
  );

  // Initial selection — when an `initialFilter` is supplied the list
  // is already narrowed; we still try to anchor on `current` if it
  // survived the filter, otherwise fall back to the first row.
  const initialIdx = useMemo(() => {
    if (filtered.length === 0) return 0;
    const i = filtered.findIndex((m) => m === current);
    return i >= 0 ? i : 0;
  }, [filtered, current]);

  const [index, setIndex] = useState<number>(initialIdx);
  const [windowStart, setWindowStart] = useState<number>(() =>
    clampWindow(0, initialIdx, filtered.length),
  );

  // Reset cursor + window every time the filter changes — typing a
  // narrower query that excludes the current highlight should snap us
  // back to the top so the user sees the first match.
  //
  // Using `filter` (the trimmed-case-insensitive normalisation happens
  // inside `applyFilter`) is correct here — we want the reset on every
  // keystroke, including ones that don't change `filtered.length`
  // (e.g. typing then deleting back to the same prefix).
  useEffect(() => {
    setIndex(0);
    setWindowStart(0);
  }, [filter]);

  // Defensive clamp when the underlying *filtered* list shrinks beneath
  // the current selection (e.g. after the user types more characters,
  // or after a refresh removed entries). Keeps the highlight on a
  // valid row and the window in bounds.
  useEffect(() => {
    if (filtered.length === 0) {
      if (index !== 0) setIndex(0);
      if (windowStart !== 0) setWindowStart(0);
      return;
    }
    if (index >= filtered.length) {
      const next = filtered.length - 1;
      setIndex(next);
      setWindowStart((s) => clampWindow(s, next, filtered.length));
    }
  }, [filtered.length, index, windowStart]);

  const moveSelection = useCallback(
    (delta: 1 | -1): void => {
      const total = filtered.length;
      if (total === 0) return;
      setIndex((prev) => {
        const next =
          delta === 1
            ? (prev + 1) % total // wrap forward
            : (prev - 1 + total) % total; // wrap backward
        setWindowStart((start) => clampWindow(start, next, total));
        return next;
      });
    },
    [filtered.length],
  );

  // Browse-mode input handler — runs when `searchMode` is false.
  const handleBrowseInput = useCallback(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
      },
    ): void => {
      if (key.escape) {
        onCancel();
        return;
      }
      // `/` enters search mode regardless of whether the list is
      // currently empty — the user might be filtering an empty
      // registry on purpose (no harm done, and feels consistent).
      if (input === '/') {
        setSearchMode(true);
        return;
      }
      if (filtered.length === 0) {
        if (input.toLowerCase() === 'r' && onRefresh !== undefined) {
          onRefresh();
        }
        return;
      }
      if (key.upArrow) {
        moveSelection(-1);
        return;
      }
      if (key.downArrow) {
        moveSelection(1);
        return;
      }
      if (key.return) {
        const chosen = filtered[index];
        if (chosen !== undefined) onSelect(chosen);
        return;
      }
      if (input.toLowerCase() === 'r' && onRefresh !== undefined) {
        onRefresh();
        return;
      }
    },
    [filtered, index, moveSelection, onCancel, onRefresh, onSelect],
  );

  // Search-mode input handler — runs when `searchMode` is true.
  // We deliberately do NOT handle typing or Enter here: the TextInput
  // owns those (typing → onChange → setFilter; Enter → onSubmit →
  // exit search mode). Only Esc is intercepted, which exits search
  // mode while keeping the filter applied. This mirrors SkillsScreen
  // R-prior's `handleAddInput` and avoids double-handling characters.
  const handleSearchInput = useCallback(
    (_input: string, key: { escape?: boolean }): void => {
      if (key.escape) {
        setSearchMode(false);
      }
    },
    [],
  );

  useInput(searchMode ? handleSearchInput : handleBrowseInput);

  // ---- Derived render data ------------------------------------------
  const total = filtered.length;
  const start = clampWindow(windowStart, index, total);
  const end = Math.min(start + WINDOW_SIZE, total);
  const visible = filtered.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;

  const filterDisplay = filter.trim();
  const hasActiveFilter = filterDisplay.length > 0;

  const footerHint = searchMode
    ? '(esc) exit search · filter stays applied · (enter) accept'
    : `↑/↓ navigate · Enter select · / filter${
        onRefresh !== undefined ? ' · r refresh' : ''
      } · Esc cancel`;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>{theme.logo}</Text>
      <Box marginTop={1}>
        <Text>
          Select a model
          {available.length > 0
            ? hasActiveFilter
              ? ` (${total} of ${available.length} match)`
              : ` (${available.length} available)`
            : ''}
          :
        </Text>
      </Box>

      {/* Filter row — always rendered when there are any models, so the
          layout doesn't shift the moment the user presses `/`. */}
      {available.length > 0 && (
        <Box marginTop={1} flexDirection="row">
          <Text color={searchMode ? 'cyan' : 'gray'}>
            {searchMode ? '> Filter: ' : '  Filter: '}
          </Text>
          {searchMode ? (
            <TextInput
              defaultValue={filter}
              placeholder="type to filter…"
              onChange={setFilter}
              onSubmit={() => setSearchMode(false)}
            />
          ) : (
            <Text color={hasActiveFilter ? 'cyan' : 'gray'} dimColor={!hasActiveFilter}>
              {hasActiveFilter ? filterDisplay : '(press / to filter)'}
            </Text>
          )}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {available.length === 0 ? (
          <Text color="yellow">
            No models available.{' '}
            {onRefresh !== undefined ? 'Press [r] to refresh.' : ''}
          </Text>
        ) : total === 0 ? (
          <Text color="yellow">
            No models match &quot;{filterDisplay}&quot;. Try a shorter
            substring or clear the filter
            {searchMode ? ' (esc in search mode)' : ' (press / to edit)'}
            .
          </Text>
        ) : (
          <>
            {hiddenAbove > 0 && (
              <Text color="gray" dimColor>
                ↑ {hiddenAbove} more
              </Text>
            )}
            {visible.map((m, i) => {
              const absoluteIndex = start + i;
              const active = absoluteIndex === index;
              const isCurrent = m === current;
              const prefix = active ? '❯ ' : '  ';
              const badge = isCurrent ? ' (current)' : '';
              return (
                <Box key={m}>
                  <Text color={active ? 'green' : 'white'}>
                    {prefix}
                    {m}
                  </Text>
                  {isCurrent && <Text color="gray">{badge}</Text>}
                </Box>
              );
            })}
            {hiddenBelow > 0 && (
              <Text color="gray" dimColor>
                ↓ {hiddenBelow} more
              </Text>
            )}
          </>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">{footerHint}</Text>
      </Box>
    </Box>
  );
}

export default ModelSelectScreen;
