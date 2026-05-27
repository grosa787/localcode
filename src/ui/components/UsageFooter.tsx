/**
 * Compact usage footer rendered beneath an assistant message.
 *
 * Shape (all segments optional; missing segments are omitted):
 *   ↳ <Nin→Nout> tokens · <M.Ms> · session: <total>t · $<cost>
 *
 * Examples
 *   - Only duration known:        `↳ 3.4s`
 *   - Full:                       `↳ 120→45 tokens · 2.1s · session: 1240t · $0.0123`
 *   - No data at all:             renders nothing (null).
 *
 * Live cost meter: when `streamingCost` is supplied (a number) the footer
 * renders `$<cost> (streaming)` instead of the committed cost. Parent
 * components throttle updates to ~200ms via `useLiveCost` so the render
 * cycle stays cheap during high-frequency chunk emission.
 *
 * The segment joiner is a middle dot `·`. All text is dim so the footer
 * does not compete with the assistant content above it.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';

import { renderStatusline, type StatuslineVars } from '../statusline-template';
import { computeCost } from '@/llm/pricing';
import { pillColorFor } from './StatusPill.js';
// BUDGET-BAR-SECTION (start) — optional stacked breakdown bar that
// replaces the single `↳ <pct>` glyph when the caller passes a
// `budgetBreakdown` prop. When absent (default), the footer renders
// the legacy compact body unchanged so existing call sites pay no
// cost.
import ContextBudgetBar, {
  type ContextBudgetBreakdown,
} from './ContextBudgetBar.js';
// BUDGET-BAR-SECTION (end)

export interface UsageFooterProps {
  readonly tokensInput?: number;
  readonly tokensOutput?: number;
  readonly durationMs?: number;
  /** Cumulative output tokens across the session (optional). */
  readonly sessionTotalOut?: number;
  /**
   * Prompt tokens served from the provider's prefix cache. Surfaced
   * as a small `(N cached)` annotation when > 0 so the user can SEE
   * caching is paying off. Anthropic + OpenAI/OpenRouter populate
   * this; local providers leave it undefined.
   */
  readonly cachedInputTokens?: number;
  /**
   * Optional statusline template. When present (and `statuslineEnabled`
   * is true), `renderStatusline(template, statuslineVars)` replaces the
   * compact `↳ in→out · duration` body. Falls back to the legacy
   * compact format when absent / disabled.
   */
  readonly statuslineEnabled?: boolean;
  readonly statuslineTemplate?: string;
  readonly statuslineVars?: StatuslineVars;
  /**
   * Committed USD cost — rendered when `streamingCost` is undefined.
   * Computed by the caller (so the footer stays stateless) via
   * `computeCost(model, tokensIn, tokensOut, cachedIn?)` from
   * `@/llm/pricing`. Local-provider rows pass `0` for "no cost data";
   * the segment is omitted if the value is exactly `0`.
   */
  readonly cost?: number;
  /**
   * Live USD cost during the stream. When defined, replaces the
   * committed `cost` segment with `$<value> (streaming)`. The caller
   * is expected to throttle updates (e.g. 200ms) to avoid burning
   * render cycles on every chunk.
   */
  readonly streamingCost?: number;
  /**
   * Optional context-fill percentage (0..100). When supplied AND
   * finite, the footer's leading `↳` glyph and body text colour
   * escalate using the same thresholds as `StatusPill.pillColorFor`
   * (<60 green, <85 yellow, >=85 red). Mirrors the web ProjectBar
   * `tokenClass` ladder so the colour signal stays consistent
   * across surfaces.
   *
   * When undefined / non-finite, the footer falls back to the
   * historical "gray dim" treatment so no existing call sites have
   * to be touched.
   */
  readonly contextPercent?: number;
  // BUDGET-BAR-SECTION (start) — optional stacked-zone breakdown. When
  // supplied (and `contextPercent` is also set), the footer renders the
  // multi-coloured bar in front of the body segments. Computed by
  // `ContextManager.getBreakdown()` in the host.
  readonly budgetBreakdown?: ContextBudgetBreakdown;
  // BUDGET-BAR-SECTION (end)
  // COST-FOOTER-SECTION (start) — cumulative spend across the active
  // session and across every session since local midnight today. Both
  // are USD; the host (`ChatScreen` / `app.tsx`) computes them via
  // `SessionManager.getSessionCost(sid)` + `getTodayCost()` and passes
  // them through whenever the user is on a paid backend. Omitting both
  // keeps the footer body unchanged so legacy call sites are unaffected.
  /** Sum of cost_usd across the active session, in USD. */
  readonly sessionCostUsd?: number;
  /** Sum of cost_usd across every session since local midnight today, in USD. */
  readonly todayCostUsd?: number;
  // COST-FOOTER-SECTION (end)
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  // One decimal for sub-minute; whole seconds beyond.
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return `${minutes}m${rem.toString().padStart(2, '0')}s`;
}

function formatInt(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  return Math.round(n).toString();
}

/**
 * Format a USD cost for compact display. Uses 4 decimal places for tiny
 * amounts (`$0.0000`) and 2 for larger ones so the meter doesn't read
 * `$0.00` when the streaming counter is still climbing in fractions of
 * a cent.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '';
  if (usd === 0) return '$0.0000';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Build the list of segments that are present (non-empty strings only).
 * Exported for test/reuse; kept module-private to callers via the
 * component default export.
 */
function buildSegments(props: UsageFooterProps): string[] {
  const out: string[] = [];

  const hasTokens =
    (props.tokensInput !== undefined && Number.isFinite(props.tokensInput)) ||
    (props.tokensOutput !== undefined && Number.isFinite(props.tokensOutput));

  if (hasTokens) {
    const inStr = formatInt(props.tokensInput ?? 0);
    const outStr = formatInt(props.tokensOutput ?? 0);
    let segment = `${inStr}→${outStr} tokens`;
    // Surface cached prefix-cache hits when the provider reported any.
    // Lets the user SEE that prompt caching is saving tokens turn-over-turn.
    if (
      props.cachedInputTokens !== undefined &&
      Number.isFinite(props.cachedInputTokens) &&
      props.cachedInputTokens > 0
    ) {
      segment += ` (${formatInt(props.cachedInputTokens)} cached)`;
    }
    out.push(segment);
  }

  if (props.durationMs !== undefined && Number.isFinite(props.durationMs) && props.durationMs > 0) {
    const d = formatDuration(props.durationMs);
    if (d.length > 0) out.push(d);
  }

  if (
    props.sessionTotalOut !== undefined &&
    Number.isFinite(props.sessionTotalOut) &&
    props.sessionTotalOut > 0
  ) {
    out.push(`session: ${formatInt(props.sessionTotalOut)}t`);
  }

  // Live cost meter wins over the committed cost. Both segments use the
  // same `$X.XXXX` shape; the streaming variant tacks `(streaming)` on
  // the end so the user knows the number is still moving.
  if (
    props.streamingCost !== undefined &&
    Number.isFinite(props.streamingCost) &&
    props.streamingCost >= 0
  ) {
    out.push(`${formatCost(props.streamingCost)} (streaming)`);
  } else if (
    props.cost !== undefined &&
    Number.isFinite(props.cost) &&
    props.cost > 0
  ) {
    out.push(formatCost(props.cost));
  }

  // COST-FOOTER-SECTION (start) — cumulative session + today totals.
  // Both segments are appended only when their value is a positive
  // finite number so local-only or first-turn sessions never render
  // `$0.00` noise. Format mirrors the per-turn cost glyph for visual
  // continuity.
  const sessionCost = props.sessionCostUsd;
  const todayCost = props.todayCostUsd;
  const cumulativeParts: string[] = [];
  if (
    sessionCost !== undefined &&
    Number.isFinite(sessionCost) &&
    sessionCost > 0
  ) {
    cumulativeParts.push(`session: ${formatCost(sessionCost)}`);
  }
  if (
    todayCost !== undefined &&
    Number.isFinite(todayCost) &&
    todayCost > 0
  ) {
    cumulativeParts.push(`today: ${formatCost(todayCost)}`);
  }
  if (cumulativeParts.length > 0) {
    out.push(cumulativeParts.join(' · '));
  }
  // COST-FOOTER-SECTION (end)

  return out;
}

/**
 * Resolve the footer body colour. When `contextPercent` is a finite
 * number we escalate via the StatusPill threshold ladder; otherwise we
 * fall back to gray-dim so the visual treatment is unchanged for the
 * vast majority of footer rows that don't carry a context fill.
 *
 * Exported as part of `__test__` so the colour-escalation test can
 * assert the resolved hex without re-deriving thresholds.
 */
function footerColorFor(percent: number | undefined): string | undefined {
  if (percent === undefined || !Number.isFinite(percent)) return undefined;
  return pillColorFor(percent);
}

function UsageFooterImpl(props: UsageFooterProps): React.JSX.Element | null {
  const escalated = footerColorFor(props.contextPercent);

  // Custom-template path: when the user opted into a statusline template
  // we render that verbatim instead of the compact compact body. Empty
  // rendered output still suppresses the footer to keep the chat tight.
  if (
    props.statuslineEnabled === true &&
    typeof props.statuslineTemplate === 'string' &&
    props.statuslineTemplate.length > 0
  ) {
    const rendered = renderStatusline(
      props.statuslineTemplate,
      props.statuslineVars ?? {},
    ).trim();
    if (rendered.length === 0) return null;
    return (
      <Box flexDirection="row">
        {escalated !== undefined ? (
          <Text color={escalated}>↳ {rendered}</Text>
        ) : (
          <Text color="gray" dimColor>
            ↳ {rendered}
          </Text>
        )}
      </Box>
    );
  }

  const segments = buildSegments(props);
  // BUDGET-BAR-SECTION (start) — render the stacked bar when the host
  // supplied a breakdown; otherwise fall through to the legacy body.
  if (props.budgetBreakdown !== undefined) {
    return (
      <Box flexDirection="column">
        <ContextBudgetBar breakdown={props.budgetBreakdown} compact />
        {segments.length > 0 && (
          <Box flexDirection="row">
            {escalated !== undefined ? (
              <Text color={escalated}>↳ {segments.join(' · ')}</Text>
            ) : (
              <Text color="gray" dimColor>
                ↳ {segments.join(' · ')}
              </Text>
            )}
          </Box>
        )}
      </Box>
    );
  }
  // BUDGET-BAR-SECTION (end)
  if (segments.length === 0) return null;

  const body = segments.join(' · ');

  return (
    <Box flexDirection="row">
      {escalated !== undefined ? (
        <Text color={escalated}>↳ {body}</Text>
      ) : (
        <Text color="gray" dimColor>
          ↳ {body}
        </Text>
      )}
    </Box>
  );
}

/**
 * R7 (Agent 4) — flicker reduction.
 *
 * All four props are primitives or undefined, so the default
 * referential comparator `Object.is` is correct. Memoising avoids a
 * full repaint of the footer (and the line break it forces) every
 * time the parent re-renders for an unrelated reason — particularly
 * relevant inside committed assistant messages, which would otherwise
 * paint the same `↳ <tokens> · <duration>` string on every streamed
 * chunk above.
 */
const UsageFooter = React.memo(UsageFooterImpl);

export default UsageFooter;

/** Test-only namespace export. */
export const __test__ = {
  footerColorFor,
  buildSegments,
  formatDuration,
  formatInt,
  formatCost,
};

/**
 * Hook helper — throttles the live cost meter to one update every
 * `intervalMs` (default 200ms). Pass the latest streaming usage; the
 * hook computes cost via `computeCost(...)` and exposes the throttled
 * value so the parent component can pass it to `<UsageFooter
 * streamingCost={...} />` without thrashing renders on every chunk.
 *
 * Returns `undefined` when `isStreaming` is false — the caller renders
 * the committed `cost` segment instead.
 */
export function useLiveCost(input: {
  readonly isStreaming: boolean;
  readonly model: string | undefined;
  readonly tokensInput: number | undefined;
  readonly tokensOutput: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly intervalMs?: number;
}): number | undefined {
  const intervalMs = input.intervalMs ?? 200;
  const [throttled, setThrottled] = useState<number | undefined>(
    input.isStreaming ? 0 : undefined,
  );
  const lastUpdateRef = useRef<number>(0);
  const pendingRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!input.isStreaming) {
      // Hand off to the committed cost path on stream end.
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
      setThrottled(undefined);
      return;
    }
    if (input.model === undefined) return;

    const tokensIn = input.tokensInput ?? 0;
    const tokensOut = input.tokensOutput ?? 0;
    const cached = input.cachedInputTokens;
    const next = computeCost(input.model, tokensIn, tokensOut, cached);
    pendingRef.current = next;

    const now = Date.now();
    const sinceLast = now - lastUpdateRef.current;
    if (sinceLast >= intervalMs) {
      lastUpdateRef.current = now;
      setThrottled(next);
      pendingRef.current = null;
      return;
    }
    if (timerRef.current === null) {
      const delay = intervalMs - sinceLast;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (pendingRef.current !== null) {
          lastUpdateRef.current = Date.now();
          setThrottled(pendingRef.current);
          pendingRef.current = null;
        }
      }, delay);
    }
  }, [
    input.isStreaming,
    input.model,
    input.tokensInput,
    input.tokensOutput,
    input.cachedInputTokens,
    intervalMs,
  ]);

  // Final cleanup — clear any pending timer when the component unmounts
  // mid-stream so we don't leak a setTimeout into the test runner.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return throttled;
}
