/**
 * /cost — current-session breakdown overlay.
 *
 * Lists each assistant turn in the active session with token counts,
 * duration, model, and computed cost. Sticky total at the bottom so
 * the user can see what the conversation has burned without scrolling
 * past long histories.
 *
 *   ┌─ Cost (session) ────────────────────────────┐
 *   │ # turn    in   out  cached  cost   model    │
 *   │ 1        342   45      0    $0.0024  ...   │
 *   │ 2       ...                                 │
 *   ├─────────────────────────────────────────────│
 *   │ TOTAL          ...                          │
 *   └─ esc close · ↑↓ scroll ─────────────────────┘
 */

import React, { useCallback, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
import { formatCostCell } from '@/llm/pricing/cost-calculator';

export interface CostTurnRow {
  /** 1-based index for display. */
  readonly turn: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly durationMs: number;
  readonly cost: number;
  readonly model: string;
}

export interface CostDashboardProps {
  readonly turns: readonly CostTurnRow[];
  readonly onClose: () => void;
  /** Optional title shown in the header (e.g. session title or id). */
  readonly sessionLabel?: string;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms - min * 60_000) / 1000);
  return `${min}m${sec}s`;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const safe = s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
  const padCount = Math.max(0, width - safe.length);
  return align === 'right' ? ' '.repeat(padCount) + safe : safe + ' '.repeat(padCount);
}

const VIEWPORT_ROWS = 20;

function CostDashboard({
  turns,
  onClose,
  sessionLabel,
}: CostDashboardProps): React.JSX.Element {
  const [offset, setOffset] = useState(0);

  useInput(
    useCallback(
      (
        _input: string,
        key: { escape?: boolean; upArrow?: boolean; downArrow?: boolean },
      ) => {
        if (key.escape === true) {
          onClose();
          return;
        }
        if (key.upArrow === true) {
          setOffset((o) => Math.max(0, o - 1));
          return;
        }
        if (key.downArrow === true) {
          setOffset((o) =>
            Math.min(Math.max(0, turns.length - VIEWPORT_ROWS), o + 1),
          );
          return;
        }
      },
      [onClose, turns.length],
    ),
  );

  const totals = turns.reduce(
    (acc, t) => ({
      input: acc.input + (t.inputTokens || 0),
      output: acc.output + (t.outputTokens || 0),
      cached: acc.cached + (t.cachedTokens || 0),
      cost: acc.cost + (t.cost || 0),
      duration: acc.duration + (t.durationMs || 0),
    }),
    { input: 0, output: 0, cached: 0, cost: 0, duration: 0 },
  );

  const visible = turns.slice(offset, offset + VIEWPORT_ROWS);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={noxPalette.light}
      paddingX={1}
      paddingY={1}
    >
      <Box flexDirection="row">
        <Text color={noxPalette.white} bold>
          Cost
        </Text>
        {sessionLabel !== undefined && sessionLabel.length > 0 && (
          <Text color={textMuted}>{'   '}{sessionLabel}</Text>
        )}
      </Box>

      <Box flexDirection="row" marginTop={1}>
        <Text color={textMuted}>{pad('#', 4, 'right')}</Text>
        <Text color={textMuted}>{pad('in', 8, 'right')}</Text>
        <Text color={textMuted}>{pad('out', 8, 'right')}</Text>
        <Text color={textMuted}>{pad('cached', 8, 'right')}</Text>
        <Text color={textMuted}>{pad('dur', 8, 'right')}</Text>
        <Text color={textMuted}>{pad('cost', 10, 'right')}</Text>
        <Text color={textMuted}>{'  model'}</Text>
      </Box>

      {turns.length === 0 ? (
        <Box marginTop={1}>
          <Text color={textMuted} dimColor>
            (no assistant turns recorded yet)
          </Text>
        </Box>
      ) : (
        visible.map((t) => (
          <Box flexDirection="row" key={`turn-${t.turn}`}>
            <Text color={noxPalette.light}>{pad(String(t.turn), 4, 'right')}</Text>
            <Text color={noxPalette.white}>{pad(formatTokens(t.inputTokens), 8, 'right')}</Text>
            <Text color={noxPalette.white}>{pad(formatTokens(t.outputTokens), 8, 'right')}</Text>
            <Text color={noxPalette.highlight}>{pad(formatTokens(t.cachedTokens), 8, 'right')}</Text>
            <Text color={textMuted}>{pad(formatDuration(t.durationMs), 8, 'right')}</Text>
            <Text color={noxPalette.white}>{pad(formatCostCell(t.cost), 10, 'right')}</Text>
            <Text color={textMuted}>{'  '}{t.model}</Text>
          </Box>
        ))
      )}

      {/* Sticky total */}
      <Box flexDirection="row" marginTop={1}>
        <Text color={noxPalette.highlight} bold>{pad('Σ', 4, 'right')}</Text>
        <Text color={noxPalette.white} bold>{pad(formatTokens(totals.input), 8, 'right')}</Text>
        <Text color={noxPalette.white} bold>{pad(formatTokens(totals.output), 8, 'right')}</Text>
        <Text color={noxPalette.highlight} bold>{pad(formatTokens(totals.cached), 8, 'right')}</Text>
        <Text color={textMuted} bold>{pad(formatDuration(totals.duration), 8, 'right')}</Text>
        <Text color={noxPalette.white} bold>{pad(formatCostCell(totals.cost), 10, 'right')}</Text>
        <Text color={textMuted}>{'  TOTAL'}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={textMuted}>esc close · ↑↓ scroll</Text>
      </Box>
    </Box>
  );
}

export default CostDashboard;

export const __test__ = {
  formatDuration,
  formatTokens,
  pad,
};
