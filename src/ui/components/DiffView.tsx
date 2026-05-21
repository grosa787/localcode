/**
 * Parse a unified diff (as produced by the `diff` package's
 * `createTwoFilesPatch` / `createPatch`) and render coloured lines for
 * terminal consumption, with an approval footer:
 *
 *   Apply changes?  [y] yes  [n] no  [e] edit
 *
 * Hotkeys:
 *   y  → onApprove()
 *   n  → onReject()
 *   e  → onEdit?()      (optional — if not provided, `e` is ignored)
 *   Esc→ onReject()
 */

import React, { useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useInputModeHandler, type InputEvent } from './InputDispatcher.js';

export interface DiffViewProps {
  readonly filePath: string;
  readonly diffString: string;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly onEdit?: () => void;
}

type DiffLineKind = 'header' | 'hunk' | 'add' | 'remove' | 'context' | 'meta';

interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

function parseDiff(diff: string): DiffLine[] {
  const rawLines = diff.split(/\r?\n/);
  const parsed: DiffLine[] = [];
  let oldCursor = 0;
  let newCursor = 0;

  for (const line of rawLines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('Index:')) {
      parsed.push({ kind: 'header', text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith('@@')) {
      // Parse "@@ -oldStart,oldCount +newStart,newCount @@"
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        const oldStart = Number.parseInt(match[1] ?? '0', 10);
        const newStart = Number.parseInt(match[2] ?? '0', 10);
        oldCursor = Number.isFinite(oldStart) ? oldStart : 0;
        newCursor = Number.isFinite(newStart) ? newStart : 0;
      }
      parsed.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      parsed.push({ kind: 'meta', text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith('+')) {
      parsed.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newCursor });
      newCursor += 1;
      continue;
    }
    if (line.startsWith('-')) {
      parsed.push({ kind: 'remove', text: line.slice(1), oldLine: oldCursor, newLine: null });
      oldCursor += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      parsed.push({
        kind: 'context',
        text: line.slice(1),
        oldLine: oldCursor,
        newLine: newCursor,
      });
      oldCursor += 1;
      newCursor += 1;
      continue;
    }
    // Unknown / blank trailing line — treat as meta.
    if (line.length > 0) {
      parsed.push({ kind: 'meta', text: line, oldLine: null, newLine: null });
    }
  }

  return parsed;
}

function padNum(n: number | null, width: number): string {
  if (n === null) return ' '.repeat(width);
  const s = String(n);
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}

function DiffLineRow({ line, width }: { line: DiffLine; width: number }): React.JSX.Element {
  const oldCol = padNum(line.oldLine, width);
  const newCol = padNum(line.newLine, width);

  switch (line.kind) {
    case 'header':
      return (
        <Box>
          <Text color="cyan" bold>
            {line.text}
          </Text>
        </Box>
      );
    case 'hunk':
      return (
        <Box>
          <Text color="magenta">{line.text}</Text>
        </Box>
      );
    case 'add':
      return (
        <Box>
          <Text color="gray">{oldCol} </Text>
          <Text color="gray">{newCol} </Text>
          <Text color="green">+ {line.text}</Text>
        </Box>
      );
    case 'remove':
      return (
        <Box>
          <Text color="gray">{oldCol} </Text>
          <Text color="gray">{newCol} </Text>
          <Text color="red">- {line.text}</Text>
        </Box>
      );
    case 'context':
      return (
        <Box>
          <Text color="gray">{oldCol} </Text>
          <Text color="gray">{newCol} </Text>
          <Text color="gray">  {line.text}</Text>
        </Box>
      );
    case 'meta':
    default:
      return (
        <Box>
          <Text color="gray">{line.text}</Text>
        </Box>
      );
  }
}

function DiffViewImpl({
  filePath,
  diffString,
  onApprove,
  onReject,
  onEdit,
}: DiffViewProps): React.JSX.Element {
  const lines = useMemo(() => parseDiff(diffString), [diffString]);

  // Compute max width for line-number columns.
  const maxLineNum = useMemo(() => {
    let maxN = 1;
    for (const l of lines) {
      if (l.oldLine !== null && l.oldLine > maxN) maxN = l.oldLine;
      if (l.newLine !== null && l.newLine > maxN) maxN = l.newLine;
    }
    return String(maxN).length;
  }, [lines]);

  const handleInput = useCallback(
    (event: InputEvent): boolean => {
      const lower = event.input.toLowerCase();
      if (lower === 'y') {
        onApprove();
        return true;
      }
      if (lower === 'n' || event.key.escape) {
        onReject();
        return true;
      }
      if (lower === 'e' && onEdit !== undefined) {
        onEdit();
        return true;
      }
      // Swallow other keystrokes — DiffView OWNS the screen while
      // mounted (ChatScreen only mounts us when
      // `pendingApproval.kind === 'diff'`). Routing through the
      // centralised dispatcher means stray keys cannot leak to the
      // InputBar; the dispatcher is in `'approval'` mode whenever we
      // are mounted.
      return true;
    },
    [onApprove, onReject, onEdit],
  );

  useInputModeHandler('approval', handleInput);

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="gray">
      <Box>
        <Text bold color="white">
          ✎ {filePath}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {lines.length === 0 ? (
          <Text color="gray">(empty diff)</Text>
        ) : (
          lines.map((line, i) => (
            <DiffLineRow key={`diff-${i}`} line={line} width={maxLineNum} />
          ))
        )}
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Text color="gray">Apply changes?  </Text>
        <Text color="green">[y] yes</Text>
        <Text color="gray">  </Text>
        <Text color="red">[n] no</Text>
        {onEdit !== undefined && (
          <>
            <Text color="gray">  </Text>
            <Text color="yellow">[e] edit</Text>
          </>
        )}
      </Box>
    </Box>
  );
}

// L6 — wrap in React.memo so a parent re-render (e.g. streaming output
// updates while a diff is awaiting approval) doesn't re-parse the diff
// or rerender every row. Props are all primitives + stable callbacks.
const DiffView = React.memo(DiffViewImpl);

export default DiffView;
