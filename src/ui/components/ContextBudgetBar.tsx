/**
 * Stacked horizontal context-budget bar.
 *
 * Replaces the legacy single-percentage StatusPill display with a
 * five-zone bar showing where the current context fill goes:
 *
 *   ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░ 27%  sys 8% · skills 4% · mem 1% · msg 12% · tools 2%
 *   ╰────╯
 *   cyan  purple yellow green orange empty
 *
 * The total filled portion equals the current context %. Each zone is
 * coloured per its semantic family. Empty trailing cells stay dim.
 *
 * Pure: parent passes the breakdown; component owns no state.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';

/** Zone colours. Aliased so the test can assert without retyping hex. */
export const ZONE_COLORS = {
  system: '#22d3ee', // cyan
  skills: noxPalette.highlight, // purple
  memory: noxPalette.yellow, // yellow
  messages: '#86efac', // green
  toolResults: '#fb923c', // orange
} as const;

export interface ContextBudgetBreakdown {
  readonly systemPromptTokens: number;
  readonly skillsTokens: number;
  readonly memoryTokens: number;
  readonly messagesTokens: number;
  readonly toolResultsTokens: number;
  readonly total: number;
  readonly max: number;
}

export interface ContextBudgetBarProps {
  readonly breakdown: ContextBudgetBreakdown;
  /** Default 30 character width. */
  readonly width?: number;
  /** When true, omit the per-zone legend (compact mode for narrow terminals). */
  readonly compact?: boolean;
}

/**
 * Apportion `total` cells across the five zones proportional to each
 * zone's token count, capped at `max`. Always returns five integers
 * summing to ≤ `total`. The remainder represents empty cells.
 *
 * Exported for unit tests.
 */
export function partitionCells(
  breakdown: ContextBudgetBreakdown,
  totalCells: number,
): {
  system: number;
  skills: number;
  memory: number;
  messages: number;
  toolResults: number;
  empty: number;
} {
  const safeWidth = Math.max(0, Math.floor(totalCells));
  if (safeWidth === 0) {
    return {
      system: 0,
      skills: 0,
      memory: 0,
      messages: 0,
      toolResults: 0,
      empty: 0,
    };
  }

  const denom = breakdown.max > 0 ? breakdown.max : 1;
  const cellsFor = (tokens: number): number => {
    if (!Number.isFinite(tokens) || tokens <= 0) return 0;
    return (tokens / denom) * safeWidth;
  };

  // Compute raw float allocations, then round each to an integer and
  // clamp the sum to ≤ safeWidth. Bias by truncation; reclaim any
  // shortfall to the largest fractional remainder so the bar visually
  // matches the proportions.
  const raw = {
    system: cellsFor(breakdown.systemPromptTokens),
    skills: cellsFor(breakdown.skillsTokens),
    memory: cellsFor(breakdown.memoryTokens),
    messages: cellsFor(breakdown.messagesTokens),
    toolResults: cellsFor(breakdown.toolResultsTokens),
  };
  const floored = {
    system: Math.floor(raw.system),
    skills: Math.floor(raw.skills),
    memory: Math.floor(raw.memory),
    messages: Math.floor(raw.messages),
    toolResults: Math.floor(raw.toolResults),
  };
  let used = floored.system + floored.skills + floored.memory + floored.messages + floored.toolResults;
  // Clamp to widget width.
  if (used > safeWidth) {
    // Trim proportionally — scale every zone down. Rare path.
    const ratio = safeWidth / used;
    const adj = {
      system: Math.floor(floored.system * ratio),
      skills: Math.floor(floored.skills * ratio),
      memory: Math.floor(floored.memory * ratio),
      messages: Math.floor(floored.messages * ratio),
      toolResults: Math.floor(floored.toolResults * ratio),
    };
    return {
      ...adj,
      empty:
        safeWidth -
        (adj.system + adj.skills + adj.memory + adj.messages + adj.toolResults),
    };
  }

  // Distribute remaining cells to zones with the largest fractional
  // remainder so we don't undercount a small zone with a long tail.
  const remainder = safeWidth - used;
  if (remainder > 0 && breakdown.total > 0) {
    const fracs = (
      [
        ['system', raw.system - floored.system],
        ['skills', raw.skills - floored.skills],
        ['memory', raw.memory - floored.memory],
        ['messages', raw.messages - floored.messages],
        ['toolResults', raw.toolResults - floored.toolResults],
      ] as const
    )
      .filter(([, f]) => f > 0)
      .sort((a, b) => b[1] - a[1]);

    let toGive = remainder;
    // Only distribute up to the proportion of the bar that's actually
    // filled — never bump empty cells. Approximate "filled" by
    // total/max ratio applied to width.
    const filledBudget = Math.min(
      safeWidth,
      Math.ceil((breakdown.total / denom) * safeWidth),
    );
    const headroom = Math.max(0, filledBudget - used);
    toGive = Math.min(toGive, headroom);
    for (const [zone] of fracs) {
      if (toGive <= 0) break;
      floored[zone] += 1;
      toGive -= 1;
      used += 1;
    }
  }

  return {
    ...floored,
    empty: safeWidth - used,
  };
}

function ContextBudgetBar({
  breakdown,
  width,
  compact,
}: ContextBudgetBarProps): React.JSX.Element {
  const cells = partitionCells(breakdown, width ?? 30);
  const pct =
    breakdown.max > 0
      ? Math.round((breakdown.total / breakdown.max) * 100)
      : 0;

  const block = '█';
  const empty = '░';

  const segments: React.JSX.Element[] = [];
  if (cells.system > 0) {
    segments.push(
      <Text key="sys" color={ZONE_COLORS.system}>{block.repeat(cells.system)}</Text>,
    );
  }
  if (cells.skills > 0) {
    segments.push(
      <Text key="skills" color={ZONE_COLORS.skills}>{block.repeat(cells.skills)}</Text>,
    );
  }
  if (cells.memory > 0) {
    segments.push(
      <Text key="mem" color={ZONE_COLORS.memory}>{block.repeat(cells.memory)}</Text>,
    );
  }
  if (cells.messages > 0) {
    segments.push(
      <Text key="msg" color={ZONE_COLORS.messages}>{block.repeat(cells.messages)}</Text>,
    );
  }
  if (cells.toolResults > 0) {
    segments.push(
      <Text key="tools" color={ZONE_COLORS.toolResults}>{block.repeat(cells.toolResults)}</Text>,
    );
  }
  if (cells.empty > 0) {
    segments.push(
      <Text key="empty" color={textMuted} dimColor>{empty.repeat(cells.empty)}</Text>,
    );
  }

  return (
    <Box flexDirection="row">
      {segments}
      <Text color={textMuted}> {pct}%</Text>
      {compact !== true && breakdown.total > 0 && (
        <Text color={textMuted}>
          {'  '}
          <Text color={ZONE_COLORS.system}>sys</Text>
          {' '}
          <Text color={ZONE_COLORS.skills}>skills</Text>
          {' '}
          <Text color={ZONE_COLORS.memory}>mem</Text>
          {' '}
          <Text color={ZONE_COLORS.messages}>msg</Text>
          {' '}
          <Text color={ZONE_COLORS.toolResults}>tools</Text>
        </Text>
      )}
    </Box>
  );
}

export default ContextBudgetBar;
