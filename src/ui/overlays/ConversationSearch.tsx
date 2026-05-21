/**
 * ConversationSearch — Ctrl+F inline search overlay.
 *
 * Renders a small single-row search bar at the top of the chat. The
 * actual match-highlight rendering happens in the message renderers,
 * which read the active query through the helper exposed here. This
 * file owns:
 *
 *   - The presentational bar (`[ search: foo… ]  [3/12 matches]`).
 *   - A pure helper (`findMatches`) that computes per-message hit
 *     ranges, used by both ChatScreen and the test suite.
 *   - A search-cursor reducer-like helper (`stepCursor`) for next /
 *     previous navigation.
 *
 * Security
 * --------
 * Matching is plain case-insensitive `String.indexOf` only. There is
 * NO regex compilation here — user input is forwarded byte-for-byte
 * with `.toLowerCase()` applied to both sides, eliminating the ReDoS
 * surface that the spec calls out explicitly. The query is also
 * lightly stripped of common markdown formatting tokens before being
 * matched against the content; see `stripMarkdownLite`.
 *
 * Hotkeys (wired by ChatScreen)
 * ----------------------------
 *   Ctrl+F   open (or focus if already open)
 *   n        next match
 *   p        previous match
 *   Esc      close + clear highlights
 *
 * The overlay itself does NOT call `useInput`. ChatScreen owns the
 * dispatcher, computes the active mode, and routes keys here via
 * callbacks. This matches the slash-menu / approval-prompt isolation
 * contract.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { dimSeparator, noxPalette, textMuted } from '../theme.js';
import type { Message } from '../../types/global.js';

/**
 * Lightweight markdown stripper used for the case-insensitive search.
 * We DON'T want fenced-code or inline-code markers to break a search
 * for the underlying token (`writeFile` should still match a phrase
 * containing `` `writeFile` ``). Same for bold/italic stars. The
 * function intentionally does NOT touch newlines or word boundaries.
 *
 * Kept stand-alone so tests can pin its behaviour.
 */
export function stripMarkdownLite(text: string): string {
  if (text.length === 0) return text;
  // Drop fenced code marker rows (```lang). Keep the inner content.
  // We only strip the marker glyphs themselves so embedded backticks
  // in identifiers (`foo`) still match.
  return text
    .replace(/```[a-zA-Z0-9_-]*/g, '')
    .replace(/[`*_~]/g, '');
}

/** A single hit inside a message body — half-open `[start, end)`. */
export interface MessageHit {
  /** Underlying `Message.id` */
  readonly messageId: string;
  /** Index in the full messages array — used for the cursor jump. */
  readonly messageIndex: number;
  /** Start offset in the ORIGINAL `content` (not the stripped form). */
  readonly start: number;
  /** End offset, exclusive. */
  readonly end: number;
}

/**
 * Locate every occurrence of `query` (case-insensitive) inside every
 * message body, returning a flat list of hits in chat order. Empty or
 * whitespace-only queries produce no hits — same convention as
 * VS Code's quick-find bar.
 *
 * The function preserves ORIGINAL offsets even though it strips
 * markdown for matching: positions in the stripped form are mapped
 * back to the original via a parallel index table. This keeps the
 * downstream `<Text inverse>` decoration honest — we never insert
 * characters in the rendered string.
 */
export function findMatches(
  messages: readonly Message[],
  query: string,
): readonly MessageHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const needleStripped = stripMarkdownLite(trimmed).toLowerCase();
  if (needleStripped.length === 0) return [];
  const out: MessageHit[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m === undefined) continue;
    if (typeof m.content !== 'string') continue;
    const content = m.content;
    if (content.length === 0) continue;
    // Build a stripped haystack plus an index map back to the original
    // string. For every char we kept, `map[k] = original_index`.
    const map: number[] = [];
    let stripped = '';
    for (let k = 0; k < content.length; k += 1) {
      const ch = content[k];
      if (ch === undefined) continue;
      if (ch === '`' || ch === '*' || ch === '_' || ch === '~') continue;
      stripped += ch;
      map.push(k);
    }
    const lower = stripped.toLowerCase();
    let from = 0;
    while (from <= lower.length - needleStripped.length) {
      const at = lower.indexOf(needleStripped, from);
      if (at === -1) break;
      const startOrig = map[at] ?? at;
      const endIdxStripped = at + needleStripped.length - 1;
      const lastOrig = map[endIdxStripped] ?? endIdxStripped;
      const endOrig = lastOrig + 1;
      out.push({
        messageId: m.id,
        messageIndex: i,
        start: startOrig,
        end: endOrig,
      });
      from = at + Math.max(1, needleStripped.length);
    }
  }
  return out;
}

/** Step a cursor across the hit list — clamped to [0, hits.length-1]. */
export function stepCursor(
  currentIndex: number,
  hitsLength: number,
  direction: 'next' | 'prev',
): number {
  if (hitsLength <= 0) return -1;
  if (currentIndex < 0) return direction === 'next' ? 0 : hitsLength - 1;
  if (direction === 'next') {
    return (currentIndex + 1) % hitsLength;
  }
  return (currentIndex - 1 + hitsLength) % hitsLength;
}

/**
 * Decorate a single message body with `<Text inverse>` spans around
 * every hit. Returns a `React.ReactNode` array suitable for embedding
 * inside an `<Text>` parent.
 *
 * The function tolerates overlapping hits by skipping any range that
 * starts before the cursor we've already emitted — `findMatches`
 * never produces overlaps so this is purely defensive.
 *
 * `activeIdx` (optional) — when supplied, the hit at that global index
 * (i.e. in the parent's flat `hits` list) is rendered with the yellow
 * accent so the user sees which one the cursor is sitting on.
 */
export function decorateMatches(
  content: string,
  hits: readonly MessageHit[],
  messageId: string,
  baseHitIndex: number,
  activeIdx: number,
): readonly React.ReactNode[] {
  if (hits.length === 0) return [content];
  // Filter hits to this message; preserve their position in `hits`
  // so we can correlate with `activeIdx`.
  const local: { readonly hit: MessageHit; readonly globalIndex: number }[] = [];
  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i];
    if (h === undefined) continue;
    if (h.messageId !== messageId) continue;
    local.push({ hit: h, globalIndex: baseHitIndex + i });
  }
  if (local.length === 0) return [content];
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < local.length; i += 1) {
    const entry = local[i];
    if (entry === undefined) continue;
    const { hit, globalIndex } = entry;
    if (hit.start < cursor) continue;
    if (hit.start > cursor) {
      out.push(content.slice(cursor, hit.start));
    }
    const slice = content.slice(hit.start, hit.end);
    const isActive = globalIndex === activeIdx;
    out.push(
      <Text
        key={`hit-${hit.messageId}-${hit.start}`}
        inverse
        color={isActive ? noxPalette.yellow : noxPalette.highlight}
      >
        {slice}
      </Text>,
    );
    cursor = hit.end;
  }
  if (cursor < content.length) {
    out.push(content.slice(cursor));
  }
  return out;
}

export interface ConversationSearchProps {
  /** When false the bar renders `null` (default state). */
  readonly visible: boolean;
  /** Current query — owned by ChatScreen. */
  readonly query: string;
  /** Total hit count for `[N of M matches]`. */
  readonly totalMatches: number;
  /**
   * Currently focused hit index (0-based). -1 when no hits or the
   * cursor hasn't landed on any. The bar displays `cursorIndex + 1`
   * to be 1-based for human eyes.
   */
  readonly cursorIndex: number;
}

function ConversationSearchImpl({
  visible,
  query,
  totalMatches,
  cursorIndex,
}: ConversationSearchProps): React.JSX.Element | null {
  if (!visible) return null;
  const display = query.length === 0 ? '_' : query;
  const counter =
    totalMatches === 0
      ? 'no matches'
      : `${Math.max(0, cursorIndex) + 1} of ${totalMatches} matches`;
  return (
    <Box
      flexDirection="row"
      paddingX={1}
      borderStyle="round"
      borderColor={dimSeparator}
    >
      <Text color={noxPalette.highlight} bold>
        search:
      </Text>
      <Text> </Text>
      <Text color={noxPalette.white}>{display}</Text>
      <Text> </Text>
      <Text color={textMuted} dimColor>
        [{counter}]
      </Text>
      <Text> </Text>
      <Text color={textMuted} dimColor>
        — n/p to step · Esc to close
      </Text>
    </Box>
  );
}

const ConversationSearch = React.memo(ConversationSearchImpl);

export default ConversationSearch;

export const __test__ = {
  stripMarkdownLite,
  findMatches,
  stepCursor,
  decorateMatches,
};
