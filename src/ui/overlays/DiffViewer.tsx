/**
 * `<DiffViewer>` — full-screen, interactive diff viewer (new in `/diff`).
 *
 * Layout:
 *
 *   ┌─ ✎ src/foo.ts                                   [2/5]  [U]nified ──┐
 *   │  @@ -10,4 +10,4 @@                                                  │
 *   │   10  - const old = 1                                               │
 *   │   10  + const fresh = 1                                             │
 *   │   11    context                                                     │
 *   │   12    context                                                     │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │ ↑/↓ scroll · ←/→ hunk · u toggle · n next file · p prev · q close   │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Inputs (dispatched via `useInputModeHandler('diff-viewer', …)`):
 *   - ↑/↓        — scroll one display line.
 *   - PgUp/PgDn  — scroll one page.
 *   - ←/→        — jump to previous/next hunk in the current file.
 *   - n / p      — next / previous file.
 *   - u          — toggle unified ↔ side-by-side.
 *   - q / Esc    — close.
 *
 * Implementation notes:
 *   - We use `diff`'s `structuredPatch` to slice each entry's
 *     before/after into hunks. The unified rendering is a flat list of
 *     header/hunk/context/add/remove rows; side-by-side is a 2-column
 *     layout where every paired add/remove lines up side by side.
 *   - The component is a pure presentational surface — it never
 *     touches the filesystem; all `DiffEntry.before`/`after` text is
 *     supplied by `/diff` (see `cmd-diff.ts`).
 *   - We do NOT mount full syntax-highlighting per line. Each line gets
 *     a single foreground colour driven by its diff kind plus a faint
 *     background fill for add/remove rows. That keeps the render fast
 *     even on a 10K-line diff and avoids the CodeBlock recompute cost.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Box, Text } from 'ink';
import { structuredPatch, type Hunk } from 'diff';

import {
  useInputModeHandler,
  type InputEvent,
} from '../components/InputDispatcher.js';
import { dimSeparator, noxPalette, textMuted } from '../theme.js';
import type { DiffEntry } from '@/commands/cmd-diff';

// ---------- Background tints (theme tokens) ----------

/**
 * Soft tints for added / removed lines. Picked from the surrounding
 * palette: a desaturated purple-tinted dark for additions and a deep
 * burgundy for removals, both bright enough to read against on a black
 * terminal but dim enough not to scream. These mirror the spirit of
 * `--success-soft` / `--danger-soft` in the web frontend tokens.
 */
const SUCCESS_SOFT_BG = '#1f3a2b';
const DANGER_SOFT_BG = '#3a1d24';
const ADD_FG = '#86efac';
const REMOVE_FG = '#fca5a5';

// ---------- Public props ----------

export interface DiffViewerProps {
  readonly open: boolean;
  readonly entries: readonly DiffEntry[];
  readonly onClose: () => void;
  /**
   * Optional override for the viewport height. Useful in tests where
   * ink's `process.stdout.rows` is whatever the test harness happens to
   * be running under. Defaults to `process.stdout.rows ?? 24`.
   */
  readonly viewportRows?: number;
}

// ---------- Internal model ----------

type ViewMode = 'unified' | 'side-by-side';

type LineKind = 'add' | 'remove' | 'context' | 'hunk' | 'meta';

interface UnifiedLine {
  readonly kind: LineKind;
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  /** Index of the hunk this row belongs to (for ←/→ navigation). */
  readonly hunkIndex: number;
}

interface SideBySideRow {
  readonly left: UnifiedLine | null;
  readonly right: UnifiedLine | null;
  readonly hunkIndex: number;
}

/**
 * Convert one {@link DiffEntry} into a flat list of unified-display rows.
 * Returns the start line index of each hunk so ←/→ can jump quickly.
 */
function buildUnified(
  entry: DiffEntry,
): { readonly lines: readonly UnifiedLine[]; readonly hunkStarts: readonly number[] } {
  const patch = structuredPatch(
    entry.filePath,
    entry.filePath,
    entry.before,
    entry.after,
    '',
    '',
    { context: 3 },
  );
  const lines: UnifiedLine[] = [];
  const hunkStarts: number[] = [];

  if (patch.hunks.length === 0) {
    // No diff text — render a single meta row so the user still sees
    // which file they're on. (Shouldn't happen for entries we returned
    // from /diff, but guard for tests passing identical before/after.)
    lines.push({
      kind: 'meta',
      text: '(no changes)',
      oldLine: null,
      newLine: null,
      hunkIndex: 0,
    });
    return { lines, hunkStarts: [] };
  }

  patch.hunks.forEach((hunk: Hunk, hIdx: number) => {
    hunkStarts.push(lines.length);
    lines.push({
      kind: 'hunk',
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldLine: null,
      newLine: null,
      hunkIndex: hIdx,
    });
    let oldCursor = hunk.oldStart;
    let newCursor = hunk.newStart;
    for (const raw of hunk.lines) {
      const prefix = raw.charAt(0);
      const body = raw.slice(1);
      if (prefix === '+') {
        lines.push({
          kind: 'add',
          text: body,
          oldLine: null,
          newLine: newCursor,
          hunkIndex: hIdx,
        });
        newCursor += 1;
      } else if (prefix === '-') {
        lines.push({
          kind: 'remove',
          text: body,
          oldLine: oldCursor,
          newLine: null,
          hunkIndex: hIdx,
        });
        oldCursor += 1;
      } else if (prefix === '\\') {
        lines.push({
          kind: 'meta',
          text: raw,
          oldLine: null,
          newLine: null,
          hunkIndex: hIdx,
        });
      } else {
        // context (space prefix) — body MAY be empty for blank ctx lines.
        lines.push({
          kind: 'context',
          text: body,
          oldLine: oldCursor,
          newLine: newCursor,
          hunkIndex: hIdx,
        });
        oldCursor += 1;
        newCursor += 1;
      }
    }
  });

  return { lines, hunkStarts };
}

/**
 * Turn a flat unified-line list into paired side-by-side rows. Adds /
 * removes that come back-to-back are aligned in the same row; lone
 * adds/removes leave the opposite column empty. Context + meta + hunk
 * lines mirror to both columns.
 */
function pairSideBySide(lines: readonly UnifiedLine[]): readonly SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i];
    if (cur === undefined) {
      i += 1;
      continue;
    }
    if (cur.kind === 'remove') {
      // Try to find a same-hunk run of removes followed by adds.
      const removes: UnifiedLine[] = [cur];
      let j = i + 1;
      while (j < lines.length) {
        const peek = lines[j];
        if (peek === undefined || peek.kind !== 'remove' || peek.hunkIndex !== cur.hunkIndex) break;
        removes.push(peek);
        j += 1;
      }
      const adds: UnifiedLine[] = [];
      while (j < lines.length) {
        const peek = lines[j];
        if (peek === undefined || peek.kind !== 'add' || peek.hunkIndex !== cur.hunkIndex) break;
        adds.push(peek);
        j += 1;
      }
      const pairs = Math.max(removes.length, adds.length);
      for (let k = 0; k < pairs; k += 1) {
        rows.push({
          left: removes[k] ?? null,
          right: adds[k] ?? null,
          hunkIndex: cur.hunkIndex,
        });
      }
      i = j;
      continue;
    }
    if (cur.kind === 'add') {
      // Unpaired add (no preceding remove in this run).
      rows.push({ left: null, right: cur, hunkIndex: cur.hunkIndex });
      i += 1;
      continue;
    }
    // hunk / context / meta — mirror on both sides.
    rows.push({ left: cur, right: cur, hunkIndex: cur.hunkIndex });
    i += 1;
  }
  return rows;
}

// ---------- Render helpers ----------

function padNum(n: number | null, width: number): string {
  if (n === null) return ' '.repeat(width);
  const s = String(n);
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}

function lineColor(kind: LineKind): { fg: string; bg?: string } {
  switch (kind) {
    case 'add':
      return { fg: ADD_FG, bg: SUCCESS_SOFT_BG };
    case 'remove':
      return { fg: REMOVE_FG, bg: DANGER_SOFT_BG };
    case 'hunk':
      return { fg: noxPalette.highlight };
    case 'meta':
      return { fg: textMuted };
    case 'context':
    default:
      return { fg: textMuted };
  }
}

function linePrefix(kind: LineKind): string {
  switch (kind) {
    case 'add':
      return '+ ';
    case 'remove':
      return '- ';
    case 'context':
      return '  ';
    case 'hunk':
    case 'meta':
    default:
      return '';
  }
}

function UnifiedRow({
  line,
  width,
}: {
  readonly line: UnifiedLine;
  readonly width: number;
}): React.JSX.Element {
  const { fg, bg } = lineColor(line.kind);
  if (line.kind === 'hunk' || line.kind === 'meta') {
    return (
      <Box>
        <Text color={fg}>{line.text}</Text>
      </Box>
    );
  }
  const oldCol = padNum(line.oldLine, width);
  const newCol = padNum(line.newLine, width);
  return (
    <Box>
      <Text color={textMuted}>{oldCol} </Text>
      <Text color={textMuted}>{newCol} </Text>
      <Text color={fg} backgroundColor={bg}>
        {linePrefix(line.kind)}
        {line.text}
      </Text>
    </Box>
  );
}

function SideBySideCell({
  line,
  width,
}: {
  readonly line: UnifiedLine | null;
  readonly width: number;
}): React.JSX.Element {
  if (line === null) {
    return (
      <Box>
        <Text color={textMuted}>{' '.repeat(width)}     </Text>
      </Box>
    );
  }
  if (line.kind === 'hunk' || line.kind === 'meta') {
    return (
      <Box>
        <Text color={noxPalette.highlight}>{line.text}</Text>
      </Box>
    );
  }
  const { fg, bg } = lineColor(line.kind);
  const num =
    line.kind === 'add'
      ? padNum(line.newLine, width)
      : padNum(line.oldLine, width);
  return (
    <Box>
      <Text color={textMuted}>{num} </Text>
      <Text color={fg} backgroundColor={bg}>
        {linePrefix(line.kind)}
        {line.text}
      </Text>
    </Box>
  );
}

// ---------- Component ----------

function DiffViewer({
  open,
  entries,
  onClose,
  viewportRows,
}: DiffViewerProps): React.JSX.Element | null {
  const [fileIdx, setFileIdx] = useState<number>(0);
  const [scroll, setScroll] = useState<number>(0);
  const [mode, setMode] = useState<ViewMode>('unified');

  // Reset scroll + cursor when the entries reference changes (new /diff
  // invocation). Without this a second `/diff` would land the user at
  // the scroll offset of the previous viewer.
  useEffect(() => {
    setFileIdx(0);
    setScroll(0);
  }, [entries]);

  const safeFileIdx =
    entries.length === 0 ? 0 : Math.min(fileIdx, entries.length - 1);
  const currentEntry = entries[safeFileIdx];

  const unified = useMemo(() => {
    if (currentEntry === undefined) {
      return {
        lines: [] as readonly UnifiedLine[],
        hunkStarts: [] as readonly number[],
      };
    }
    return buildUnified(currentEntry);
  }, [currentEntry]);

  const sideBySide = useMemo(() => pairSideBySide(unified.lines), [unified.lines]);

  // Available rows for the body — leave headroom for header + footer +
  // borders. Default to 24 rows when running headless / in tests.
  const fallbackRows =
    typeof process !== 'undefined' &&
    process.stdout !== undefined &&
    typeof process.stdout.rows === 'number'
      ? process.stdout.rows
      : 24;
  const totalRows = viewportRows ?? fallbackRows;
  const bodyRows = Math.max(4, totalRows - 5);

  const maxLineNum = useMemo(() => {
    let maxN = 1;
    for (const l of unified.lines) {
      if (l.oldLine !== null && l.oldLine > maxN) maxN = l.oldLine;
      if (l.newLine !== null && l.newLine > maxN) maxN = l.newLine;
    }
    return String(maxN).length;
  }, [unified.lines]);

  const totalDisplayRows =
    mode === 'unified' ? unified.lines.length : sideBySide.length;
  const maxScroll = Math.max(0, totalDisplayRows - bodyRows);
  const clampedScroll = Math.min(Math.max(0, scroll), maxScroll);

  const goNextFile = useCallback((): void => {
    if (entries.length === 0) return;
    setFileIdx((i) => (i + 1) % entries.length);
    setScroll(0);
  }, [entries.length]);

  const goPrevFile = useCallback((): void => {
    if (entries.length === 0) return;
    setFileIdx((i) => (i - 1 + entries.length) % entries.length);
    setScroll(0);
  }, [entries.length]);

  const goNextHunk = useCallback((): void => {
    if (unified.hunkStarts.length === 0) return;
    for (const start of unified.hunkStarts) {
      if (start > clampedScroll) {
        setScroll(Math.min(start, maxScroll));
        return;
      }
    }
    // Already past the last hunk — wrap to the first hunk of the next file.
    if (entries.length > 1) goNextFile();
  }, [clampedScroll, entries.length, goNextFile, maxScroll, unified.hunkStarts]);

  const goPrevHunk = useCallback((): void => {
    if (unified.hunkStarts.length === 0) return;
    // Find the largest start strictly less than clampedScroll.
    let target: number | null = null;
    for (const start of unified.hunkStarts) {
      if (start < clampedScroll) target = start;
      else break;
    }
    if (target !== null) {
      setScroll(target);
      return;
    }
    if (entries.length > 1) goPrevFile();
  }, [clampedScroll, entries.length, goPrevFile, unified.hunkStarts]);

  const handleInput = useCallback(
    (event: InputEvent): boolean => {
      if (!open) return false;
      const { input, key } = event;
      if (key.escape || input === 'q' || input === 'Q') {
        onClose();
        return true;
      }
      if (input === 'u' || input === 'U') {
        setMode((m) => (m === 'unified' ? 'side-by-side' : 'unified'));
        setScroll(0);
        return true;
      }
      if (input === 'n' || input === 'N') {
        goNextFile();
        return true;
      }
      if (input === 'p' || input === 'P') {
        goPrevFile();
        return true;
      }
      if (key.leftArrow) {
        goPrevHunk();
        return true;
      }
      if (key.rightArrow) {
        goNextHunk();
        return true;
      }
      if (key.upArrow) {
        setScroll((s) => Math.max(0, s - 1));
        return true;
      }
      if (key.downArrow) {
        setScroll((s) => Math.min(maxScroll, s + 1));
        return true;
      }
      if (key.pageUp) {
        setScroll((s) => Math.max(0, s - bodyRows));
        return true;
      }
      if (key.pageDown) {
        setScroll((s) => Math.min(maxScroll, s + bodyRows));
        return true;
      }
      // Swallow everything else while open.
      return true;
    },
    [bodyRows, goNextFile, goNextHunk, goPrevFile, goPrevHunk, maxScroll, onClose, open],
  );

  useInputModeHandler('diff-viewer', handleInput);

  if (!open) return null;
  if (entries.length === 0 || currentEntry === undefined) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={noxPalette.light}
        paddingX={1}
      >
        <Text color={textMuted}>No diff entries to display.</Text>
        <Text color={textMuted}>Press q or Esc to close.</Text>
      </Box>
    );
  }

  const visibleUnified =
    mode === 'unified'
      ? unified.lines.slice(clampedScroll, clampedScroll + bodyRows)
      : [];
  const visibleSideBySide =
    mode === 'side-by-side'
      ? sideBySide.slice(clampedScroll, clampedScroll + bodyRows)
      : [];

  const modeLabel = mode === 'unified' ? '[U]nified' : '[S]ide-by-side';
  const modeAlt = mode === 'unified' ? '[s]ide-by-side' : '[u]nified';

  return (
    <Box flexDirection="column" width="100%">
      {/* Header */}
      <Box
        flexDirection="row"
        borderStyle="round"
        borderColor={noxPalette.light}
        paddingX={1}
      >
        <Text color={noxPalette.white} bold>
          ✎ {currentEntry.filePath}
        </Text>
        <Text color={textMuted}>
          {'   '}[{safeFileIdx + 1}/{entries.length}]
        </Text>
        <Text color={textMuted}>
          {'   '}mode: {modeLabel}
        </Text>
        <Text color={textMuted}>
          {'   '}({modeAlt})
        </Text>
        <Text color={textMuted}>
          {'   '}{currentEntry.mode}
        </Text>
      </Box>

      {/* Body */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={dimSeparator}
        paddingX={1}
        minHeight={bodyRows + 2}
      >
        {mode === 'unified' ? (
          visibleUnified.length === 0 ? (
            <Text color={textMuted}>(empty diff)</Text>
          ) : (
            visibleUnified.map((line, i) => (
              <UnifiedRow
                key={`u-${clampedScroll + i}`}
                line={line}
                width={maxLineNum}
              />
            ))
          )
        ) : visibleSideBySide.length === 0 ? (
          <Text color={textMuted}>(empty diff)</Text>
        ) : (
          visibleSideBySide.map((row, i) => (
            <Box key={`s-${clampedScroll + i}`} flexDirection="row">
              <Box flexBasis="50%" flexGrow={1} flexShrink={1}>
                <SideBySideCell line={row.left} width={maxLineNum} />
              </Box>
              <Box flexBasis="50%" flexGrow={1} flexShrink={1}>
                <SideBySideCell line={row.right} width={maxLineNum} />
              </Box>
            </Box>
          ))
        )}
      </Box>

      {/* Footer */}
      <Box paddingX={1}>
        <Text color={textMuted}>
          ↑/↓ scroll · ←/→ hunk · u toggle · n next file · p prev · q close
        </Text>
      </Box>
    </Box>
  );
}

export default DiffViewer;
