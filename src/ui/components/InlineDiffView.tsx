/**
 * Read-only, compact unified-diff renderer meant to sit inline inside
 * chat-log tool-call results.
 *
 * The heavier `DiffView` component renders the same style plus the
 * y/n/e approval footer; this one has no interactivity and can appear
 * inside streamed message history alongside other tool output.
 *
 * Layout:
 *   ▸ <filePath>
 *      4   - old line
 *      4   + new line
 *           context line
 *   @@  (gap between hunks)
 *
 * In `compact` mode (default) we show at most 3 context lines on each
 * side of a change; the full file (if ever supplied) would be very
 * verbose in the TTY.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

export interface InlineDiffViewProps {
  readonly filePath: string;
  readonly diffString: string;
  /** Show only 3-lines-of-context around each change when true. */
  readonly compact?: boolean;
}

type DiffLineKind = 'header' | 'hunk' | 'add' | 'remove' | 'context' | 'meta';

interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

/**
 * Parse a unified-diff string into a linear sequence of lines annotated
 * with reconstructed line numbers. Identical parsing strategy to
 * `DiffView.tsx` — kept independent to avoid a cross-import and because
 * the file-header / approval UI is different.
 */
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
    if (line.length > 0) {
      parsed.push({ kind: 'meta', text: line, oldLine: null, newLine: null });
    }
  }

  return parsed;
}

const CONTEXT_LINES = 3;

/**
 * In compact mode we drop context that is far from any change; we keep
 * up to `CONTEXT_LINES` before and after each add/remove run.
 */
function applyCompactFilter(lines: readonly DiffLine[]): DiffLine[] {
  // First, figure out which indices are "near" an add/remove.
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l === undefined) continue;
    if (l.kind === 'header' || l.kind === 'hunk' || l.kind === 'meta') {
      keep.add(i);
      continue;
    }
    if (l.kind === 'add' || l.kind === 'remove') {
      keep.add(i);
      const start = Math.max(0, i - CONTEXT_LINES);
      const end = Math.min(lines.length - 1, i + CONTEXT_LINES);
      for (let j = start; j <= end; j += 1) keep.add(j);
    }
  }

  // Walk the original list, preserving order. Inject an ellipsis
  // `⋯` meta line between non-adjacent kept indices to indicate
  // context was skipped.
  const out: DiffLine[] = [];
  let prevIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!keep.has(i)) continue;
    if (prevIdx >= 0 && i - prevIdx > 1) {
      out.push({ kind: 'meta', text: '⋯', oldLine: null, newLine: null });
    }
    const line = lines[i];
    if (line !== undefined) out.push(line);
    prevIdx = i;
  }
  return out;
}

function padNum(n: number | null, width: number): string {
  if (n === null) return ' '.repeat(width);
  const s = String(n);
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}

interface RowProps {
  readonly line: DiffLine;
  readonly width: number;
}

function Row({ line, width }: RowProps): React.JSX.Element {
  switch (line.kind) {
    case 'header':
      // The main filePath header sits above; individual header lines
      // inside the diff are redundant noise in compact mode.
      return (
        <Box>
          <Text color="gray" dimColor>
            {line.text}
          </Text>
        </Box>
      );
    case 'hunk':
      return (
        <Box>
          <Text color="magenta" dimColor>
            {line.text}
          </Text>
        </Box>
      );
    case 'add': {
      const num = padNum(line.newLine, width);
      return (
        <Box>
          <Text color="gray">{num} </Text>
          <Text color="green">+ </Text>
          <Text color="green">{line.text}</Text>
        </Box>
      );
    }
    case 'remove': {
      const num = padNum(line.oldLine, width);
      return (
        <Box>
          <Text color="gray">{num} </Text>
          <Text color="red">- </Text>
          <Text color="red">{line.text}</Text>
        </Box>
      );
    }
    case 'context': {
      const num = padNum(line.oldLine, width);
      return (
        <Box>
          <Text color="gray">{num} </Text>
          <Text color="gray">  </Text>
          <Text color="gray">{line.text}</Text>
        </Box>
      );
    }
    case 'meta':
    default:
      return (
        <Box>
          <Text color="gray" dimColor>
            {line.text}
          </Text>
        </Box>
      );
  }
}

function InlineDiffViewImpl({
  filePath,
  diffString,
  compact = true,
}: InlineDiffViewProps): React.JSX.Element {
  const parsed = useMemo(() => parseDiff(diffString), [diffString]);
  const lines = useMemo(
    () => (compact ? applyCompactFilter(parsed) : parsed),
    [parsed, compact],
  );

  const maxLineNum = useMemo(() => {
    let maxN = 1;
    for (const l of lines) {
      if (l.oldLine !== null && l.oldLine > maxN) maxN = l.oldLine;
      if (l.newLine !== null && l.newLine > maxN) maxN = l.newLine;
    }
    return String(maxN).length;
  }, [lines]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">▸ </Text>
        <Text color="cyan">{filePath}</Text>
      </Box>
      <Box flexDirection="column">
        {lines.length === 0 ? (
          <Text color="gray" dimColor>
            (empty diff)
          </Text>
        ) : (
          lines
            .filter((l) => l.kind !== 'header')
            .map((line, i) => <Row key={`inline-diff-${i}`} line={line} width={maxLineNum} />)
        )}
      </Box>
    </Box>
  );
}

// L9 — wrap in React.memo keyed on [diffString, filePath, compact] so
// streaming-driven parent re-renders don't re-parse the diff on every
// chunk while a tool-call result is being scrolled past.
function arePropsEqual(
  prev: InlineDiffViewProps,
  next: InlineDiffViewProps,
): boolean {
  if (prev.diffString !== next.diffString) return false;
  if (prev.filePath !== next.filePath) return false;
  if ((prev.compact ?? true) !== (next.compact ?? true)) return false;
  return true;
}

const InlineDiffView = React.memo(InlineDiffViewImpl, arePropsEqual);

export default InlineDiffView;
