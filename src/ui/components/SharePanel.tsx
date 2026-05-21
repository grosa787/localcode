/**
 * SharePanel — single-row indicator rendered below the StatusPill when
 * a LAN session-share is currently active.
 *
 * Visual contract (active state):
 *
 *   sharing with: alice@laptop.local • 12 messages synced • /share stop
 *
 * Hidden when no share is active or LAN mode is off. The parent
 * (ChatScreen / app.tsx) owns the underlying state — this component is
 * pure presentation, the same pattern as `<WatchPanel>`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';

export interface SharePanelProps {
  /** When false the panel renders nothing (no share active / LAN off). */
  readonly active: boolean;
  /** Display name of the peer we're sharing with. */
  readonly peerLabel: string;
  /** Cumulative count of synced messages, both directions. */
  readonly messagesSynced: number;
  /**
   * Optional 6-digit code we minted (sharer side). When provided we
   * surface it so the user can repeat it to the peer without
   * scrolling. Falsy on the receiver side.
   */
  readonly pairingCode?: string;
}

const PALETTE = {
  header: noxPalette.highlight,
  accent: 'green',
  sep: textMuted,
} as const;

function SharePanel(props: SharePanelProps): React.JSX.Element | null {
  if (!props.active) return null;

  const codeFragment = props.pairingCode
    ? ` • code ${props.pairingCode}`
    : '';

  return (
    <Box flexDirection="row" paddingX={1} marginTop={0}>
      <Text color={PALETTE.header}>sharing</Text>
      <Text color={PALETTE.sep}> with </Text>
      <Text color={PALETTE.accent}>{props.peerLabel}</Text>
      <Text color={PALETTE.sep}> • </Text>
      <Text>{props.messagesSynced} synced</Text>
      <Text color={PALETTE.sep}>{codeFragment}</Text>
      <Text color={PALETTE.sep}> • </Text>
      <Text dimColor>/share stop</Text>
    </Box>
  );
}

export default SharePanel;
