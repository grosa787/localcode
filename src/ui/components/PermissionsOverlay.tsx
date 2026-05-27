/**
 * `/permissions` overlay — FIX #32.
 *
 * Presents the list of auto-approvable tools, highlights which are
 * already granted in `config.permissions.autoApprove`, and lets the
 * user flip entries with Space, accept-all with `a` / Enter, or close
 * with Esc. Purely presentational — the caller owns state:
 *
 *   <PermissionsOverlay
 *     config={cfg}
 *     onToggle={(tool) => …}
 *     onAcceptAll={() => …}
 *     onClose={() => …}
 *   />
 *
 * Tools not in `AutoApprovableTool` are shown as "always auto-approved"
 * for clarity but are non-interactive.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { noxPalette, textMuted, theme } from '../theme.js';
import type { AppConfig, AutoApprovableTool } from '../../types/global.js';
// I18N-STRINGS-START
import { useT } from '../../i18n/index.js';
// I18N-STRINGS-END

export interface PermissionsOverlayProps {
  readonly config: AppConfig;
  readonly onToggle: (tool: AutoApprovableTool) => void;
  readonly onAcceptAll: () => void;
  readonly onClose: () => void;
}

/**
 * Rows the user sees. The `alwaysOn` tag marks tools that are read-
 * only or preview-only (no disk side-effects) and therefore always
 * auto-approved regardless of config.
 */
// I18N-STRINGS-START
// `noteKey` lookups go through the i18n `t()` so this overlay reflects
// the active locale. Tool names themselves stay English on purpose —
// they're the literal handler ids LocalCode dispatches against.
type NoteKey =
  | 'permissions.note.alwaysOn'
  | 'permissions.note.alwaysOnDiff'
  | 'permissions.note.grantPrompt';

interface Row {
  readonly name: string;
  readonly tool?: AutoApprovableTool;
  readonly alwaysOn: boolean;
  readonly noteKey?: NoteKey;
}

const ROWS: readonly Row[] = [
  { name: 'read_file', alwaysOn: true, noteKey: 'permissions.note.alwaysOn' },
  { name: 'list_dir', alwaysOn: true, noteKey: 'permissions.note.alwaysOn' },
  { name: 'glob_search', alwaysOn: true, noteKey: 'permissions.note.alwaysOn' },
  {
    name: 'edit_file',
    alwaysOn: true,
    noteKey: 'permissions.note.alwaysOnDiff',
  },
  {
    name: 'write_file',
    tool: 'write_file',
    alwaysOn: false,
    noteKey: 'permissions.note.grantPrompt',
  },
  {
    name: 'run_command',
    tool: 'run_command',
    alwaysOn: false,
    noteKey: 'permissions.note.grantPrompt',
  },
  { name: 'fetch_image', alwaysOn: true, noteKey: 'permissions.note.alwaysOn' },
  { name: 'lint_file', alwaysOn: true, noteKey: 'permissions.note.alwaysOn' },
];
// I18N-STRINGS-END

function PermissionsOverlay({
  config,
  onToggle,
  onAcceptAll,
  onClose,
}: PermissionsOverlayProps): React.JSX.Element {
  // I18N-STRINGS-START
  const { t } = useT();
  // I18N-STRINGS-END
  // Only rows that can be toggled participate in arrow-navigation.
  const selectableIndices = useMemo(() => {
    const out: number[] = [];
    ROWS.forEach((r, i) => {
      if (r.tool !== undefined && !r.alwaysOn) out.push(i);
    });
    return out;
  }, []);

  const [cursor, setCursor] = useState<number>(() => selectableIndices[0] ?? 0);

  const granted = useMemo(() => {
    return new Set<AutoApprovableTool>(config.permissions.autoApprove);
  }, [config.permissions.autoApprove]);

  const moveCursor = useCallback(
    (direction: 'up' | 'down') => {
      if (selectableIndices.length === 0) return;
      const pos = selectableIndices.indexOf(cursor);
      if (pos === -1) {
        setCursor(selectableIndices[0] ?? 0);
        return;
      }
      const nextPos =
        direction === 'up'
          ? (pos - 1 + selectableIndices.length) % selectableIndices.length
          : (pos + 1) % selectableIndices.length;
      setCursor(selectableIndices[nextPos] ?? 0);
    },
    [cursor, selectableIndices],
  );

  useInput(
    useCallback(
      (
        input: string,
        key: {
          escape?: boolean;
          upArrow?: boolean;
          downArrow?: boolean;
          return?: boolean;
        },
      ) => {
        if (key.escape) {
          onClose();
          return;
        }
        if (key.upArrow) {
          moveCursor('up');
          return;
        }
        if (key.downArrow) {
          moveCursor('down');
          return;
        }
        // Accept-all via `a` or Enter — same semantics per spec.
        if (input.toLowerCase() === 'a' || key.return) {
          onAcceptAll();
          return;
        }
        if (input === ' ') {
          const row = ROWS[cursor];
          if (row !== undefined && row.tool !== undefined && !row.alwaysOn) {
            onToggle(row.tool);
          }
          return;
        }
      },
      [cursor, moveCursor, onAcceptAll, onClose, onToggle],
    ),
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={noxPalette.light}
      paddingX={1}
      paddingY={1}
    >
      <Box>
        {/* I18N-STRINGS-START */}
        <Text color={noxPalette.white} bold>
          {t('permissions.title')}
        </Text>
        {/* I18N-STRINGS-END */}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {ROWS.map((row, i) => {
          const active = i === cursor;
          const checked = row.alwaysOn || (row.tool !== undefined && granted.has(row.tool));
          const box = `[${checked ? '✓' : ' '}]`;
          const arrow = active ? '❯ ' : '  ';
          const nameColour = row.alwaysOn ? textMuted : noxPalette.white;
          const checkColour = checked ? noxPalette.light : textMuted;
          // I18N-STRINGS-START
          const noteText = row.noteKey !== undefined ? `— ${t(row.noteKey)}` : '';
          // I18N-STRINGS-END
          return (
            <Box key={`perm-${i}`} flexDirection="row">
              <Text color={active ? noxPalette.light : textMuted}>{arrow}</Text>
              <Text color={checkColour}>{box}</Text>
              <Text>{' '}</Text>
              <Text color={nameColour}>{row.name.padEnd(14, ' ')}</Text>
              <Text>{' '}</Text>
              <Text color={textMuted}>{noteText}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="row">
        {/* I18N-STRINGS-START */}
        <Text color={textMuted}>{t('permissions.footer.enter')}   </Text>
        <Text color={textMuted}>{t('permissions.footer.a')}   </Text>
        <Text color={textMuted}>{t('permissions.footer.space')}   </Text>
        <Text color={textMuted}>{t('permissions.footer.esc')}</Text>
        {/* I18N-STRINGS-END */}
      </Box>
      <Box marginTop={1}>
        <Text>
          {/* I18N-STRINGS-START */}
          {theme.muted(
            t('permissions.granted', {
              list:
                granted.size === 0
                  ? t('permissions.granted.none')
                  : [...granted].join(', '),
            }),
          )}
          {/* I18N-STRINGS-END */}
        </Text>
      </Box>
    </Box>
  );
}

export default PermissionsOverlay;
