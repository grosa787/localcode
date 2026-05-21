/**
 * SessionTimeline — 1-row horizontal density bar for the session.
 *
 * Purpose
 * -------
 * Visualises the turn density of the current conversation as a single
 * row of glyphs. Each event in the message stream maps to one glyph:
 *
 *   - user message      → `●` (filled dot, lavender)
 *   - assistant message → `○` (hollow dot, white)
 *   - tool call         → `▪` (filled square, highlight)
 *
 * A `▼` cursor marks the user's current "visible scroll position" — by
 * default the last entry, but ChatScreen can drive it via `cursorIndex`
 * for `g` (first) / `G` (last) jumps. Click is not wired (ink has no
 * mouse contract); jumps land via key.
 *
 * Width / downsampling
 * --------------------
 * The bar must fit on a single row of width `columns`. When the event
 * count exceeds the available glyph budget we downsample: every `N`th
 * event becomes a tick. The downsample label appears at the right
 * (e.g. `(3x)`) so the user knows the granularity.
 *
 * Visibility contract
 * -------------------
 * Off by default — toggled via `Ctrl+Y` in ChatScreen. When hidden
 * the component returns `null` so the surface stays clean.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
import type { Message } from '../../types/global.js';

export type TimelineEventKind = 'user' | 'assistant' | 'tool';

export interface TimelineEvent {
  /** Stable id — typically the underlying `Message.id`. */
  readonly id: string;
  /** Index in the originating message array — used by jump callbacks. */
  readonly messageIndex: number;
  readonly kind: TimelineEventKind;
}

export interface SessionTimelineProps {
  /** When false, the component renders `null` (default state). */
  readonly visible: boolean;
  /** The terminal column count — drives downsampling. */
  readonly columns: number;
  /** Derived event stream — see `buildTimelineEvents`. */
  readonly events: readonly TimelineEvent[];
  /**
   * Cursor position within `events`. Out-of-range values are clamped
   * to the last event so the cursor is always visible when there is
   * any content.
   */
  readonly cursorIndex: number;
}

/** Per-kind glyph. Kept as a module constant for tests. */
export const TIMELINE_GLYPHS: Readonly<Record<TimelineEventKind, string>> = {
  user: '●',
  assistant: '○',
  tool: '▪',
} as const;

/** Cursor glyph rendered IN PLACE of the underlying tick. */
export const TIMELINE_CURSOR = '▼';

/**
 * Reserve space at the right for the downsample label (e.g. `(3x)`).
 * Computed once per render so the budget is predictable.
 */
function reservedForLabel(downsample: number): number {
  if (downsample <= 1) return 0;
  // ` (12x)` style — sign byte for the space + digits + `(x)`.
  const digits = Math.ceil(Math.log10(downsample + 1));
  return Math.max(5, digits + 4);
}

/**
 * Build the flat event stream from a messages array. Tool calls expand
 * inline — an assistant message with N tool calls becomes 1 assistant
 * event followed by N tool events, in array order. This matches the
 * temporal order the user sees in the chat log.
 */
export function buildTimelineEvents(
  messages: readonly Message[],
): readonly TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role === 'user') {
      out.push({ id: m.id, messageIndex: i, kind: 'user' });
      continue;
    }
    if (m.role === 'assistant') {
      out.push({ id: `${m.id}:msg`, messageIndex: i, kind: 'assistant' });
      const tcs = m.toolCalls;
      if (tcs !== undefined) {
        for (let j = 0; j < tcs.length; j += 1) {
          const tc = tcs[j];
          if (tc === undefined) continue;
          out.push({ id: `${m.id}:tc:${tc.id}`, messageIndex: i, kind: 'tool' });
        }
      }
    }
    // system / tool roles are intentionally suppressed — the
    // tool-call events above already represent the work; raw
    // tool-role rows would double-count.
  }
  return out;
}

/**
 * Decide the downsample factor for a given column budget. We reserve
 * room for the label up front, then pick the smallest integer N ≥ 1
 * such that `ceil(events / N) ≤ budget`. The cursor always replaces
 * a tick so it doesn't need its own slot.
 */
export function computeDownsample(
  eventCount: number,
  columns: number,
): { readonly factor: number; readonly budget: number } {
  // Account for outer padding (2 cols) so the bar doesn't overflow.
  const usable = Math.max(8, columns - 2);
  if (eventCount <= usable) {
    return { factor: 1, budget: usable };
  }
  // Iterate until the downsampled length fits including the label space.
  for (let factor = 2; factor <= eventCount; factor += 1) {
    const labelCost = reservedForLabel(factor);
    const budget = Math.max(4, usable - labelCost);
    const downsampledLen = Math.ceil(eventCount / factor);
    if (downsampledLen <= budget) return { factor, budget };
  }
  // Pathological fall-back — render a single tick + label.
  return { factor: eventCount, budget: 4 };
}

interface TickRender {
  readonly key: string;
  readonly glyph: string;
  readonly color: string;
  readonly isCursor: boolean;
}

/** Pure projector — emit the visible ticks for given events + cursor. */
export function projectTicks(
  events: readonly TimelineEvent[],
  cursorIndex: number,
  factor: number,
): readonly TickRender[] {
  if (events.length === 0) return [];
  const clampedCursor =
    cursorIndex < 0
      ? events.length - 1
      : cursorIndex >= events.length
        ? events.length - 1
        : cursorIndex;
  const ticks: TickRender[] = [];
  // Iterate using the downsample factor. We pick the FIRST event in
  // each bucket as the representative, except the bucket that contains
  // the cursor — there we keep the cursor as the representative so it
  // stays visible at the correct location.
  for (let start = 0; start < events.length; start += factor) {
    const end = Math.min(start + factor, events.length);
    const cursorInBucket =
      clampedCursor >= start && clampedCursor < end;
    const repIndex = cursorInBucket ? clampedCursor : start;
    const rep = events[repIndex];
    if (rep === undefined) continue;
    const kindColor =
      rep.kind === 'user'
        ? noxPalette.light
        : rep.kind === 'assistant'
          ? noxPalette.white
          : noxPalette.highlight;
    ticks.push({
      key: `${rep.id}-${start}`,
      glyph: cursorInBucket ? TIMELINE_CURSOR : TIMELINE_GLYPHS[rep.kind],
      color: cursorInBucket ? noxPalette.yellow : kindColor,
      isCursor: cursorInBucket,
    });
  }
  return ticks;
}

function SessionTimelineImpl({
  visible,
  columns,
  events,
  cursorIndex,
}: SessionTimelineProps): React.JSX.Element | null {
  if (!visible) return null;
  if (events.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={textMuted} dimColor>
          Timeline — no events yet.
        </Text>
      </Box>
    );
  }
  const { factor } = computeDownsample(events.length, columns);
  const ticks = projectTicks(events, cursorIndex, factor);
  const label = factor > 1 ? ` (${factor}x)` : '';
  return (
    <Box flexDirection="row" paddingX={1}>
      {ticks.map((t) => (
        <Text key={t.key} color={t.color} bold={t.isCursor}>
          {t.glyph}
        </Text>
      ))}
      {label.length > 0 && (
        <Text color={textMuted} dimColor>
          {label}
        </Text>
      )}
    </Box>
  );
}

const SessionTimeline = React.memo(SessionTimelineImpl);

export default SessionTimeline;

export const __test__ = {
  buildTimelineEvents,
  computeDownsample,
  projectTicks,
  reservedForLabel,
  TIMELINE_GLYPHS,
  TIMELINE_CURSOR,
};
