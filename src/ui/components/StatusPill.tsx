/**
 * Wave 5A — TUI input bar polish.
 *
 * Pill row rendered IMMEDIATELY above the InputBar. Shape (full layout):
 *
 *   [ provider · model · 42% · default · concise ]
 *
 * On narrow terminals (< 80 columns) the pill collapses to a tighter
 * form that only carries the two pieces of information most users
 * actually scan for during a long session:
 *
 *   [ model · 42% ]
 *
 * Colours follow the same escalation ladder as `ctxColor()` so the user
 * can tell at a glance whether the next message is about to push the
 * context window. The thresholds intentionally match
 * `web-frontend/src/components/ProjectBar.tsx` (`tokenClass`) so the
 * TUI and web client agree on what counts as "warming up" vs
 * "compress incoming":
 *
 *   - < 60%   → green (calm — `--success`)
 *   - 60..85% → yellow (warming up — `--warning`)
 *   - >= 85%  → red (compress incoming — `--danger`)
 *
 * The component is purely presentational — the parent owns every value
 * and feeds it in. We never read from `process.env` or any config
 * manager here, so tests just construct props directly.
 *
 * NOTE: We deliberately don't subscribe to the terminal width here —
 * the parent (`<InputBar>`) reads the width via `useTerminalWidth()`
 * once and forwards the `compact` decision down. This lets the input
 * bar swap between layouts atomically with the rest of the row.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';

export interface StatusPillProps {
  /** Backend / provider identifier (e.g. `openrouter`, `lmstudio`). */
  readonly provider: string;
  /** Current model identifier (e.g. `qwen3-coder:32b`). */
  readonly model: string;
  /** Context-window fill percentage, 0..100. */
  readonly contextPercent: number;
  /** Active permission profile (e.g. `default`, `plan`). */
  readonly profile: string;
  /** Active output-style (e.g. `concise`). */
  readonly outputStyle: string;
  /**
   * When true, collapse to the `model · pct%` form. The parent decides
   * this based on `useTerminalWidth()` so the whole row reflows
   * together.
   */
  readonly compact?: boolean;
  /**
   * When true (terminal width below ~40 columns), render NOTHING. The
   * parent already inserts a single decorative line in that case.
   */
  readonly hidden?: boolean;
}

/**
 * Threshold breakpoints. Held as module constants so the test file (and
 * any sibling component that wants to match the same escalation ladder)
 * can import them directly instead of duplicating the magic numbers.
 *
 * The pair `(60, 85)` intentionally mirrors `web-frontend/src/components/
 * ProjectBar.tsx` so TUI and web present the SAME signal at the SAME fill.
 */
export const PILL_WARNING_PCT = 60;
export const PILL_DANGER_PCT = 85;

/**
 * Brand-aligned token palette mirroring the web tokens
 * (`--success`, `--warning`, `--danger`). Kept as a named export so
 * sibling components can stay perfectly in sync without re-deriving the
 * thresholds (or worse — re-typing the hex codes).
 */
export const PILL_COLORS = {
  /** `< 60%` — calm. */
  success: '#86efac',
  /** `60..85%` — warming up (matches `noxPalette.yellow`). */
  warning: noxPalette.yellow,
  /** `>= 85%` — compress incoming. */
  danger: '#fca5a5',
} as const;

/**
 * Threshold-driven colour selector. Mirrors `ctxColor()` in theme.ts
 * but returns the raw hex string so we can hand it to ink's `<Text color>`
 * prop without re-routing through a chalk colourizer. Exposed for the
 * threshold escalation test.
 */
export function pillColorFor(percent: number): string {
  if (percent >= PILL_DANGER_PCT) return PILL_COLORS.danger;
  if (percent >= PILL_WARNING_PCT) return PILL_COLORS.warning;
  return PILL_COLORS.success;
}

/** Round + clamp percentage to the 0..100 integer band for display. */
function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) return '0%';
  const clamped = Math.max(0, Math.min(100, percent));
  return `${Math.round(clamped)}%`;
}

/**
 * Render the pill body — a row of `·`-separated segments wrapped in
 * `[` and `]` and coloured by the threshold. Each segment is its own
 * `<Text>` node so ink can wrap cleanly if the terminal is narrow.
 */
function PillBody({
  segments,
  color,
}: {
  readonly segments: readonly string[];
  readonly color: string;
}): React.JSX.Element {
  return (
    <Text color={color}>
      <Text color={textMuted}>[ </Text>
      {segments.map((seg, i) => (
        <React.Fragment key={`${i}-${seg}`}>
          {i > 0 && <Text color={textMuted}> · </Text>}
          <Text color={color}>{seg}</Text>
        </React.Fragment>
      ))}
      <Text color={textMuted}> ]</Text>
    </Text>
  );
}

function StatusPillImpl(props: StatusPillProps): React.JSX.Element | null {
  if (props.hidden === true) return null;

  const color = pillColorFor(props.contextPercent);
  const pct = formatPercent(props.contextPercent);

  const segments: string[] =
    props.compact === true
      ? [props.model, pct]
      : [props.provider, props.model, pct, props.profile, props.outputStyle];

  return (
    <Box flexDirection="row" paddingX={1}>
      <PillBody segments={segments} color={color} />
    </Box>
  );
}

/**
 * Memoised: every prop is a primitive so `Object.is` comparison is
 * correct. Cuts noise when the parent re-renders for an unrelated
 * reason (e.g. cursor blink, paste pill animation).
 */
const StatusPill = React.memo(StatusPillImpl);

export default StatusPill;

/** Test-only namespace export. Mirrors the convention in InputBar.tsx. */
export const __test__ = {
  pillColorFor,
  formatPercent,
  PILL_COLORS,
  PILL_WARNING_PCT,
  PILL_DANGER_PCT,
};
