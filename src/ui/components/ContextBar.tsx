/**
 * Standalone context-usage progress bar.
 *
 * Header already carries an inline 8-char version; this one is the
 * verbose variant used inside `/context` output and anywhere you want
 * numeric detail:
 *
 *   [████░░░░░░] 42% · 3,410 / 8,192 tokens
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ctxColor } from '../theme.js';

export interface ContextBarProps {
  readonly percent: number;
  readonly tokens: number;
  readonly maxTokens: number;
}

const BAR_WIDTH = 20;
const FULL = '█';
const EMPTY = '░';

function formatNumber(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString('en-US');
}

function buildBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empties = BAR_WIDTH - filled;
  return FULL.repeat(filled) + EMPTY.repeat(empties);
}

function ContextBar({ percent, tokens, maxTokens }: ContextBarProps): React.JSX.Element {
  const pct = Math.round(percent);
  const color = ctxColor(pct);
  const bar = color(buildBar(pct));
  const pctLabel = color(`${pct}%`);

  return (
    <Box flexDirection="row" paddingX={1}>
      <Text>[{bar}]</Text>
      <Text> </Text>
      <Text>{pctLabel}</Text>
      <Text color="gray">
        {' · '}
        {formatNumber(tokens)} / {formatNumber(maxTokens)} tokens
      </Text>
    </Box>
  );
}

export default ContextBar;
