/**
 * `/context` overlay — FIX #32.
 *
 * Read-only informational panel: tokens used vs max (with a bar),
 * message count, active skills list, LOCALCODE.md status. No
 * mutations; Esc closes.
 *
 * This component is deliberately dumb — the caller precomputes all
 * numbers and passes them in. That keeps the overlay testable and
 * lets the parent (app.tsx) decide how to aggregate the data
 * (SessionManager query? in-memory counters?).
 */

import React, { useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { noxPalette, textMuted, ctxColor } from '../theme.js';

export interface ContextOverlayProps {
  readonly contextPercent: number;
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly messageCount: number;
  readonly activeSkills: readonly string[];
  readonly localcodeMd: boolean;
  readonly onClose: () => void;
}

const BAR_WIDTH = 20;
const FULL = '█';
const EMPTY = '░';

function makeBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empties = BAR_WIDTH - filled;
  return FULL.repeat(filled) + EMPTY.repeat(empties);
}

function formatTokens(n: number): string {
  // Keep the UI compact — show "12.3k" for thousands, "1.2M" for
  // millions, otherwise raw integer.
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function ContextOverlay({
  contextPercent,
  totalTokens,
  maxTokens,
  messageCount,
  activeSkills,
  localcodeMd,
  onClose,
}: ContextOverlayProps): React.JSX.Element {
  useInput(
    useCallback(
      (_input: string, key: { escape?: boolean; return?: boolean }) => {
        if (key.escape || key.return) onClose();
      },
      [onClose],
    ),
  );

  const pct = Math.round(contextPercent);
  const colour = ctxColor(pct);
  const bar = makeBar(pct);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={noxPalette.light}
      paddingX={1}
      paddingY={1}
    >
      <Box>
        <Text color={noxPalette.white} bold>
          Context
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={textMuted}>Tokens:  </Text>
          <Text color={noxPalette.white}>{formatTokens(totalTokens)}</Text>
          <Text color={textMuted}> / </Text>
          <Text color={noxPalette.white}>{formatTokens(maxTokens)}</Text>
          <Text>{'  '}</Text>
          <Text>{colour(`${pct}%`)}</Text>
          <Text>{'  '}</Text>
          <Text>{colour(bar)}</Text>
        </Box>

        <Box flexDirection="row" marginTop={1}>
          <Text color={textMuted}>Messages: </Text>
          <Text color={noxPalette.white}>{String(messageCount)}</Text>
        </Box>

        <Box flexDirection="row" marginTop={1}>
          <Text color={textMuted}>Skills ({activeSkills.length}): </Text>
          {activeSkills.length === 0 ? (
            <Text color={textMuted}>(none active)</Text>
          ) : (
            <Text color={noxPalette.light}>{activeSkills.join(', ')}</Text>
          )}
        </Box>

        <Box flexDirection="row" marginTop={1}>
          <Text color={textMuted}>LOCALCODE.md: </Text>
          <Text color={localcodeMd ? noxPalette.light : textMuted}>
            {localcodeMd ? 'present (injected)' : 'absent'}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={textMuted}>(esc / enter) close</Text>
      </Box>
    </Box>
  );
}

export default ContextOverlay;
