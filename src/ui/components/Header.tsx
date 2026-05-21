/**
 * Single-line header shown at the top of the ChatScreen.
 *
 * Layout (one line):
 *   [logo]  ·  <model>  ·  Ctx <N>%  <bar>  ·  <backend>
 *
 * The bar is 8 characters wide; filled cells use U+2588 (FULL BLOCK),
 * empty cells use U+2591 (LIGHT SHADE). The Ctx number and the bar are
 * recoloured per `ctxColor()`.
 *
 * Round 3 (FIX #26): separator dots, model text and backend text are
 * routed through the purple palette; only the "context percentage"
 * coloration still depends on fill level via ctxColor().
 */

import React from 'react';
import { Box, Text } from 'ink';
import { dimSeparator, noxPalette, theme, ctxColor } from '../theme.js';

export interface HeaderProps {
  readonly model: string;
  readonly contextPercent: number;
  readonly backend: string;
}

const BAR_WIDTH = 8;
const FULL = '█';
const EMPTY = '░';

function makeBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empties = BAR_WIDTH - filled;
  return FULL.repeat(filled) + EMPTY.repeat(empties);
}

function Header({ model, contextPercent, backend }: HeaderProps): React.JSX.Element {
  const pct = Math.round(contextPercent);
  const bar = makeBar(pct);
  const color = ctxColor(pct);

  // Pre-colour the pieces that need per-percent colouring; everything
  // else is emitted through ink props using the purple palette.
  const ctxText = color(`Ctx ${pct}%`);
  const barText = color(bar);

  return (
    <Box flexDirection="row" paddingX={1}>
      <Text>{theme.logo}</Text>
      <Text color={dimSeparator}>{'  ·  '}</Text>
      <Text color={noxPalette.white} bold>
        {model}
      </Text>
      <Text color={dimSeparator}>{'  ·  '}</Text>
      <Text>{ctxText}</Text>
      <Text>{'  '}</Text>
      <Text>{barText}</Text>
      <Text color={dimSeparator}>{'  ·  '}</Text>
      <Text color={noxPalette.light}>{backend}</Text>
    </Box>
  );
}

export default Header;
