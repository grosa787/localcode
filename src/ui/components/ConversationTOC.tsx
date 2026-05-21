/**
 * ConversationTOC — narrow left-column table-of-contents for chat history.
 *
 * Purpose
 * -------
 * Long conversations grow past the natural scrollback of a terminal,
 * and `<Static>` rows are owned by the terminal itself (we can't
 * "scroll programmatically"). The TOC offers a fast index instead:
 * a 28-column-wide list of user-turn headers (first ~50 chars of each
 * `role === 'user'` message) plus a relative timestamp.
 *
 * Visibility contract
 * -------------------
 * - Hidden by default. ChatScreen toggles via `Ctrl+T`.
 * - When hidden the component returns `null` so the chat surface keeps
 *   its full horizontal real estate for casual users.
 *
 * Navigation
 * ----------
 * ChatScreen subscribes the arrow keys + Enter on `'input'` mode while
 * the TOC is visible; this component just receives `selectedIdx` and
 * an `onSelect` callback. It is intentionally a pure render — no
 * `useInput` here (same isolation contract as `<SlashMenu>`).
 *
 * Width / shape
 * -------------
 * - Outer column: fixed 28 chars (column-width independent of theme).
 * - Title row: dim `Outline (N)`.
 * - Entry: `▎ first-50-chars-of-message  +<rel>` — the bar uses the
 *   same lavender as user-message-bar so the link to a user turn is
 *   visually obvious.
 * - Selected entry: inverse video for the title line so the eye lands
 *   on it without ambiguity.
 *
 * The component never mutates any external state — it is purely
 * presentational, matching the pattern used by every sibling overlay
 * in this directory.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { dimSeparator, noxPalette, textMuted } from '../theme.js';
import type { Message } from '../../types/global.js';

/** Hard-coded column width — keeps the chat reflow predictable. */
export const TOC_WIDTH = 28;

/** Maximum characters of the user-message preview shown per entry. */
export const TOC_PREVIEW_LEN = 50;

export interface ConversationTOCEntry {
  /** Stable id — `Message.id` of the user-role row. */
  readonly id: string;
  /** Original index in the full `messages` array (caller-provided). */
  readonly messageIndex: number;
  /** Preview text — already truncated to TOC_PREVIEW_LEN. */
  readonly preview: string;
  /** Original `createdAt` in ms (used for the relative time string). */
  readonly createdAt: number;
}

export interface ConversationTOCProps {
  /** When false, the component renders `null` (default state). */
  readonly visible: boolean;
  /** The user-role messages, oldest first. ChatScreen builds this. */
  readonly entries: readonly ConversationTOCEntry[];
  /**
   * Highlighted entry index (within `entries`, NOT the full message
   * list). When out of range or `entries.length === 0` no highlight is
   * shown — the caller does not need to clamp.
   */
  readonly selectedIdx: number;
  /** Optional override for "now" — tests inject a fixed clock here. */
  readonly nowMs?: number;
}

/**
 * Trim + collapse a user-message body into a single line. Newlines are
 * collapsed to a single space so multi-paragraph prompts still render
 * cleanly on one row. We slice at TOC_PREVIEW_LEN AFTER the collapse,
 * so multi-line drafts get the full preview budget on visible text.
 */
export function buildPreview(content: string): string {
  const flattened = content.replace(/\s+/g, ' ').trim();
  if (flattened.length <= TOC_PREVIEW_LEN) return flattened;
  // Visually distinguish trimmed entries with an ellipsis. We cut at
  // PREVIEW_LEN - 1 so the resulting string is still bounded.
  return `${flattened.slice(0, TOC_PREVIEW_LEN - 1)}…`;
}

/**
 * Pure helper — derive the TOC entries from a `messages` array. Used by
 * tests and by ChatScreen so the projection has a single canonical
 * implementation. `messages` here is the same readonly slice the screen
 * receives via props.
 */
export function buildTOCEntries(
  messages: readonly Message[],
): readonly ConversationTOCEntry[] {
  const out: ConversationTOCEntry[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role !== 'user') continue;
    if (typeof m.content !== 'string') continue;
    const preview = buildPreview(m.content);
    if (preview.length === 0) continue;
    out.push({
      id: m.id,
      messageIndex: i,
      preview,
      createdAt: m.createdAt,
    });
  }
  return out;
}

/**
 * Format a delta in ms as a coarse human string. Mirrors the cadence
 * Claude Code / VS Code timeline panels use — a single non-zero unit
 * is enough at this density.
 *
 *   < 60s          → `Xs`
 *   < 60m          → `Xm`
 *   < 24h          → `Xh`
 *   otherwise      → `Xd`
 *
 * For `delta < 0` (clock skew, paused machine) we clamp to `0s`.
 */
export function formatRelativeTime(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return '0s';
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function ConversationTOCImpl({
  visible,
  entries,
  selectedIdx,
  nowMs,
}: ConversationTOCProps): React.JSX.Element | null {
  // Hooks must run unconditionally — keep the clamp / now-snapshot
  // ABOVE the visibility short-circuit so the React rules-of-hooks
  // are honoured even when the parent toggles `visible` mid-mount.
  const clampedIdx = useMemo(() => {
    if (entries.length === 0) return -1;
    if (selectedIdx < 0) return 0;
    if (selectedIdx >= entries.length) return entries.length - 1;
    return selectedIdx;
  }, [entries.length, selectedIdx]);

  // Hidden state is the default — opt-in via Ctrl+T in ChatScreen.
  if (!visible) return null;
  const now = nowMs ?? Date.now();

  return (
    <Box
      flexDirection="column"
      width={TOC_WIDTH}
      flexShrink={0}
      borderStyle="single"
      borderColor={dimSeparator}
      paddingX={1}
    >
      <Box marginBottom={1}>
        <Text color={textMuted} bold>{`Outline (${entries.length})`}</Text>
      </Box>
      {entries.length === 0 ? (
        <Text color={textMuted} dimColor>
          No user turns yet.
        </Text>
      ) : (
        entries.map((entry, i) => {
          const isSelected = i === clampedIdx;
          const rel = formatRelativeTime(now - entry.createdAt);
          // Width budget: TOC_WIDTH minus padding (2) minus borders (2)
          // minus bar glyph (2: bar + space). Then subtract the time
          // segment we'll print on the right. We keep the layout
          // predictable by truncating preview to fit the residual.
          const reserved = ` +${rel}`;
          // 4 = bar+space (`▎ `) + 2 for the time-segment padding.
          const previewBudget = Math.max(
            8,
            TOC_WIDTH - 4 - reserved.length - 2,
          );
          const truncatedPreview =
            entry.preview.length <= previewBudget
              ? entry.preview
              : `${entry.preview.slice(0, Math.max(1, previewBudget - 1))}…`;
          return (
            <Box key={entry.id} flexDirection="row">
              <Text color={noxPalette.light}>
                {isSelected ? '▶' : '▎'}
              </Text>
              <Text> </Text>
              <Text
                color={isSelected ? noxPalette.white : textMuted}
                inverse={isSelected}
              >
                {truncatedPreview}
              </Text>
              <Text color={textMuted} dimColor>
                {reserved}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

/**
 * Memoised: every prop is a primitive or a readonly array reference
 * supplied stably from `useMemo` upstream, so `Object.is` is correct.
 */
const ConversationTOC = React.memo(ConversationTOCImpl);

export default ConversationTOC;

export const __test__ = {
  buildPreview,
  buildTOCEntries,
  formatRelativeTime,
  TOC_WIDTH,
  TOC_PREVIEW_LEN,
};
