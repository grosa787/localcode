/**
 * BranchPicker — Ctrl+B overlay for branching sessions.
 *
 * Renders the branch family as an indented tree:
 *   ▸ main                       42 msgs
 *   │  ▸ experiment-A *          21 msgs
 *   │     ▸ fix-edge-case         8 msgs (archived)
 *   ▸ alt-approach               17 msgs
 *
 * The `*` marker decorates the currently-active branch. Archived rows
 * still appear but are colour-dimmed; the user can resurface them by
 * switching.
 *
 * Navigation
 * ----------
 *   ↑ / ↓        — move selection
 *   Enter        — switch to the selected branch
 *   n            — prompt user to type a new branch name (the overlay
 *                  enters "create" mode; Esc cancels, Enter creates)
 *   d            — archive (soft-delete) the selected branch
 *   Esc          — close the overlay without action
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { dimSeparator, noxPalette, textMuted } from '../theme.js';
import type { BranchTreeNode } from '../../sessions/session-manager.js';

/** One row in the flattened tree view consumed by the picker. */
export interface BranchPickerRow {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly messageCount: number;
  readonly active: boolean;
  readonly archived: boolean;
  readonly isRoot: boolean;
}

export interface BranchPickerProps {
  /** Flat list of branch rows in tree order (root → DFS children). */
  readonly rows: readonly BranchPickerRow[];
  /**
   * Active session id — used to seed the cursor onto the active row
   * when the overlay opens. Optional; falls back to row 0.
   */
  readonly activeSessionId: string | null;
  readonly onSwitch: (id: string) => void;
  readonly onCreate: (name: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onClose: () => void;
}

/**
 * Convert a BranchTreeNode into the flat ordered list the picker
 * consumes. DFS so the visual tree matches the storage parent/child
 * relation. Exported for tests + the app.tsx wiring.
 */
export function flattenBranchTree(
  root: BranchTreeNode | null,
  activeSessionId: string | null,
): BranchPickerRow[] {
  if (root === null) return [];
  const out: BranchPickerRow[] = [];
  const walk = (node: BranchTreeNode, depth: number, isRoot: boolean): void => {
    const label =
      node.branchName !== null && node.branchName.length > 0
        ? node.branchName
        : node.title !== null && node.title.length > 0
          ? node.title
          : `(${isRoot ? 'root' : 'branch'} ${node.id.slice(0, 8)})`;
    out.push({
      id: node.id,
      label,
      depth,
      messageCount: node.messageCount,
      active: node.id === activeSessionId,
      archived: node.branchArchived,
      isRoot,
    });
    for (const child of node.children) walk(child, depth + 1, false);
  };
  walk(root, 0, true);
  return out;
}

function indentFor(depth: number): string {
  if (depth <= 0) return '';
  return '│  '.repeat(depth);
}

/**
 * Strip control codepoints from a single typed key input so escape
 * sequences from arrow/Ctrl chords don't leak into the new-branch
 * name buffer. The regex covers U+0000..U+001F and U+007F.
 */
function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    out += input[i];
  }
  return out;
}

function BranchPicker({
  rows,
  activeSessionId,
  onSwitch,
  onCreate,
  onDelete,
  onClose,
}: BranchPickerProps): React.JSX.Element {
  const initialCursor = useMemo(() => {
    const idx = rows.findIndex((r) => r.id === activeSessionId);
    return idx >= 0 ? idx : 0;
  }, [activeSessionId, rows]);

  const [cursor, setCursor] = useState<number>(initialCursor);
  // 'browse' | 'create' — when 'create', the overlay shows an input
  // prompt instead of the row list (still rendering the list above so
  // the user has context).
  const [mode, setMode] = useState<'browse' | 'create'>('browse');
  const [draft, setDraft] = useState<string>('');

  const safeCursor = rows.length > 0 ? Math.min(cursor, rows.length - 1) : 0;
  const selected = rows[safeCursor];

  useInput(
    useCallback(
      (
        input: string,
        key: {
          escape?: boolean;
          upArrow?: boolean;
          downArrow?: boolean;
          return?: boolean;
          backspace?: boolean;
          delete?: boolean;
        },
      ) => {
        if (mode === 'create') {
          if (key.escape) {
            setMode('browse');
            setDraft('');
            return;
          }
          if (key.return) {
            const name = draft.trim();
            setMode('browse');
            setDraft('');
            if (name.length > 0) onCreate(name);
            return;
          }
          if (key.backspace || key.delete) {
            setDraft((d) => d.slice(0, -1));
            return;
          }
          // Accept printable characters; strip control codepoints.
          if (typeof input === 'string' && input.length > 0) {
            const cleaned = stripControlChars(input);
            if (cleaned.length > 0) {
              setDraft((d) => `${d}${cleaned}`);
            }
          }
          return;
        }

        // Browse mode.
        if (key.escape) {
          onClose();
          return;
        }
        if (rows.length === 0) {
          if (key.return) onClose();
          if (input === 'n') {
            setMode('create');
            setDraft('');
          }
          return;
        }
        if (key.upArrow) {
          setCursor((i) => (i - 1 + rows.length) % rows.length);
          return;
        }
        if (key.downArrow) {
          setCursor((i) => (i + 1) % rows.length);
          return;
        }
        if (key.return) {
          if (selected !== undefined) onSwitch(selected.id);
          return;
        }
        if (input === 'n') {
          setMode('create');
          setDraft('');
          return;
        }
        if (input === 'd') {
          if (selected !== undefined && !selected.isRoot) onDelete(selected.id);
          return;
        }
      },
      [
        draft,
        mode,
        onClose,
        onCreate,
        onDelete,
        onSwitch,
        rows.length,
        selected,
      ],
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
        <Text color={noxPalette.white} bold>
          Branch picker
        </Text>
        <Text color={textMuted}>{`  (${rows.length} branches)`}</Text>
      </Box>

      {rows.length === 0 ? (
        <Box marginTop={1}>
          <Text color={textMuted}>
            No branches yet. Press `n` to create the first one.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {rows.map((r, i) => {
            const isCursor = i === safeCursor;
            const arrow = isCursor ? '▶ ' : '▸ ';
            const indent = indentFor(r.depth);
            const baseColor = r.archived
              ? dimSeparator
              : r.active
                ? noxPalette.white
                : isCursor
                  ? noxPalette.light
                  : textMuted;
            const marker = r.active ? ' *' : '';
            const archived = r.archived ? ' (archived)' : '';
            return (
              <Box key={`row-${r.id}`} flexDirection="row">
                <Text color={textMuted}>{indent}</Text>
                <Text color={isCursor ? noxPalette.highlight : dimSeparator}>
                  {arrow}
                </Text>
                <Text color={baseColor} bold={r.active}>
                  {r.label}
                </Text>
                <Text color={textMuted}>{marker}</Text>
                <Text color={dimSeparator}>{'  · '}</Text>
                <Text color={textMuted}>
                  {`${r.messageCount} msgs${archived}`}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {mode === 'create' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={noxPalette.highlight}>
            New branch name (Enter to create, Esc to cancel):
          </Text>
          <Box>
            <Text color={noxPalette.highlight}>{'❯ '}</Text>
            <Text color={noxPalette.white}>{draft || ' '}</Text>
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={textMuted}>
          {'↵ switch · n new · d delete · esc close'}
        </Text>
      </Box>
    </Box>
  );
}

export default BranchPicker;

/** Exported for tests. */
export const __test__ = {
  flattenBranchTree,
  indentFor,
  stripControlChars,
};
