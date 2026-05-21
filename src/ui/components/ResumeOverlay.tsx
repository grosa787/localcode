/**
 * `/resume` overlay — FIX #32.
 *
 * Lists the most recent sessions (up to 20, supplied by the caller)
 * with arrow navigation, Enter selects, Esc closes. The currently
 * highlighted row shows a preview below (session summary or fallback
 * "no summary available").
 *
 * Each row: `<date>  ·  <title>  ·  <model>`.
 * Dates are rendered as short locale strings to save horizontal space.
 */

import React, { useCallback, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { dimSeparator, noxPalette, textMuted } from '../theme.js';
import type { Session } from '../../types/global.js';

export interface ResumeOverlayProps {
  readonly sessions: readonly Session[];
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  // Keep it ASCII-friendly: "2026-04-24 13:05"
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}

function ResumeOverlay({
  sessions,
  onSelect,
  onClose,
}: ResumeOverlayProps): React.JSX.Element {
  const [cursor, setCursor] = useState<number>(0);

  const maxCursor = sessions.length - 1;

  useInput(
    useCallback(
      (
        _input: string,
        key: { escape?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean },
      ) => {
        if (key.escape) {
          onClose();
          return;
        }
        if (sessions.length === 0) {
          if (key.return) onClose();
          return;
        }
        if (key.upArrow) {
          setCursor((i) => (i - 1 + sessions.length) % sessions.length);
          return;
        }
        if (key.downArrow) {
          setCursor((i) => (i + 1) % sessions.length);
          return;
        }
        if (key.return) {
          const chosen = sessions[cursor];
          if (chosen !== undefined) onSelect(chosen.id);
          return;
        }
      },
      [cursor, onClose, onSelect, sessions],
    ),
  );

  const selected = sessions[cursor];

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
          Resume a previous session
        </Text>
      </Box>

      {sessions.length === 0 ? (
        <Box marginTop={1}>
          <Text color={textMuted}>No saved sessions yet.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {sessions.slice(0, 20).map((s, i) => {
            const active = i === cursor;
            const arrow = active ? '❯ ' : '  ';
            const title = s.title !== null && s.title.trim().length > 0 ? s.title : '(untitled)';
            return (
              <Box key={`sess-${s.id}`} flexDirection="row">
                <Text color={active ? noxPalette.light : textMuted}>{arrow}</Text>
                <Text color={active ? noxPalette.white : textMuted}>
                  {formatDate(s.updatedAt)}
                </Text>
                <Text color={dimSeparator}>{'  ·  '}</Text>
                <Text color={active ? noxPalette.white : textMuted}>
                  {truncate(title, 40)}
                </Text>
                <Text color={dimSeparator}>{'  ·  '}</Text>
                <Text color={active ? noxPalette.light : textMuted}>{s.model}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {selected !== undefined && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Text color={textMuted}>Summary:</Text>
          <Text color={noxPalette.white}>
            {selected.summary !== null && selected.summary.trim().length > 0
              ? truncate(selected.summary, 240)
              : '(no summary available)'}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={textMuted}>
          ↑/↓ select · Enter resume · Esc close · showing up to 20 entries
          {sessions.length > 20 ? ` (${sessions.length - 20} older hidden)` : ''}
        </Text>
      </Box>
    </Box>
  );
}

export default ResumeOverlay;

/** Total rows shown before older entries are hidden. */
export const RESUME_MAX_ROWS = 20;
