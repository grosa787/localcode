/**
 * ThinkingBlock — renders an assistant "extended thinking" segment in
 * the chat transcript.
 *
 * Round 15b (Agent 4): pulled out of MessageBlock so we can render
 * thinking as its own visual unit — a dim, italic block with a "💭
 * Thinking…" header that animates while the stream is live and
 * collapses to a one-liner once the stream settles. Integration into
 * MessageBlock / ChatScreen is intentionally deferred to Agent 8 R12
 * so this round stays small and reviewable.
 *
 * The component is purely presentational: it owns no chat state,
 * doesn't read context, and doesn't subscribe to the stream — the
 * parent passes `text` (accumulated thinking deltas) and `isActive`
 * (true while the model is still emitting thinking tokens). The only
 * local state is the dot-counter for the "Thinking…" animation and
 * the collapsed flag.
 *
 * Visuals reuse `noxPalette.darker` (the dark-purple shadow tone)
 * with `italic` so the block reads as "secondary" without competing
 * with the assistant's actual reply.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { noxPalette } from '../theme';

export interface ThinkingBlockProps {
  text: string;
  isActive: boolean;
  collapsedByDefault?: boolean;
}

const ThinkingBlockInner: React.FC<ThinkingBlockProps> = ({ text, isActive, collapsedByDefault = false }) => {
  // M11 — memoise line-splitting so a parent re-render (every streaming
  // chunk while we're mounted) doesn't reallocate the array.
  const lines = useMemo(
    () => text.split('\n').filter((line) => line.trim().length > 0),
    [text],
  );
  const [collapsed, setCollapsed] = useState<boolean>(collapsedByDefault);
  const [dotCount, setDotCount] = useState<number>(1);

  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      setDotCount((d) => (d % 3) + 1);
    }, 500);
    return () => clearInterval(interval);
  }, [isActive]);

  useEffect(() => {
    // When stream stops being active, auto-collapse if collapsedByDefault was set
    if (!isActive && collapsedByDefault) setCollapsed(true);
  }, [isActive, collapsedByDefault]);

  if (text.trim().length === 0 && !isActive) return null;

  const header = isActive
    ? `💭 Thinking${'.'.repeat(dotCount)}`
    : `💭 Thinking (${lines.length} ${lines.length === 1 ? 'line' : 'lines'})`;

  if (collapsed && !isActive && text.trim().length > 0) {
    return (
      <Box flexDirection="row">
        <Text color={noxPalette.darker} italic>{header} (collapsed)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={0} paddingLeft={2}>
      <Text color={noxPalette.darker} italic bold>{header}</Text>
      {lines.map((line, idx) => (
        <Box key={idx}>
          <Text color={noxPalette.darker} italic dimColor>{`  ${line}`}</Text>
        </Box>
      ))}
    </Box>
  );
};

export const ThinkingBlock = React.memo(ThinkingBlockInner);
