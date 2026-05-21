/**
 * GitHub-Flavored Markdown table detection + parsing.
 *
 * Pure functions — no DOM, no ink, no React. Shared between the web
 * markdown renderer (`web-frontend/src/util/markdown.tsx`) and the TUI
 * `MessageBlock` so both code paths agree on what is and isn't a table.
 *
 * Grammar (a subset of GFM tables):
 *
 *     | h1 | h2 | h3 |
 *     | -- | :-: | -: |
 *     | a  | b   | c  |
 *
 * Rules:
 *   - The header row has at least two pipe-delimited cells.
 *   - The separator (line 2) matches `/^\s*\|?[\s|:-]+\|?\s*$/` and
 *     each cell of the separator must contain at least one dash.
 *   - Leading and trailing pipes are optional on every row.
 *   - `\|` inside a cell is an escaped pipe (rendered as a literal `|`).
 *   - Header-only tables (header + separator with no body) still parse.
 *   - Cell text is left raw; downstream renderers run their existing
 *     inline pipeline on it.
 *
 * The detector is intentionally conservative: a table block ends at
 * the first blank line OR the first line whose cell-count differs by
 * a wide margin, OR EOF. Cell-count mismatches inside the body are
 * tolerated by padding/truncating to header width — this matches what
 * GitHub's renderer does in practice.
 */

export type Alignment = 'left' | 'center' | 'right';

export interface ParsedTable {
  readonly headers: string[];
  readonly alignments: Alignment[];
  readonly rows: string[][];
}

export type TableBlock =
  | { readonly kind: 'text'; readonly content: string }
  | { readonly kind: 'table'; readonly table: ParsedTable };

export interface ParseTablesResult {
  readonly blocks: TableBlock[];
}

const SEPARATOR_LINE_RE = /^\s*\|?[\s|:-]+\|?\s*$/;
const SEPARATOR_CELL_RE = /^\s*(:?)-+(:?)\s*$/;

/**
 * Split a table row into cells. Honours the `\|` escape — a backslash
 * before a pipe means "literal pipe in this cell, not a delimiter".
 * Leading and trailing pipes are stripped.
 */
export function splitRow(line: string): string[] {
  // Trim one leading and one trailing pipe (each, optionally), respecting
  // whitespace around them. We keep the trimmed inner content as the
  // string we walk.
  let s = line;
  // Strip leading whitespace and one optional pipe.
  const lead = /^\s*\|?/.exec(s);
  if (lead !== null) s = s.slice(lead[0].length);
  // Strip trailing whitespace and one optional unescaped pipe.
  // We scan from the right so an escaped \| at end-of-line is preserved.
  const trailMatch = /\|?\s*$/.exec(s);
  if (trailMatch !== null && trailMatch[0].length > 0) {
    // Only strip the pipe if it isn't escaped.
    const idx = s.length - trailMatch[0].length;
    if (trailMatch[0].startsWith('|')) {
      // Check the char before — if it's '\\', this pipe is escaped.
      if (idx === 0 || s.charAt(idx - 1) !== '\\') {
        s = s.slice(0, idx) + trailMatch[0].slice(1);
        s = s.replace(/\s+$/, '');
      } else {
        s = s.replace(/\s+$/, '');
      }
    } else {
      s = s.replace(/\s+$/, '');
    }
  }

  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === '\\' && i + 1 < s.length && s.charAt(i + 1) === '|') {
      // Escaped pipe — emit as a literal `|`.
      buf += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

/**
 * Parse a separator line into per-column alignment. Returns `null` if
 * the line isn't a valid separator (each cell must contain at least one
 * dash; cells may carry an optional leading/trailing colon for
 * alignment).
 */
export function parseSeparator(line: string): Alignment[] | null {
  if (!SEPARATOR_LINE_RE.test(line)) return null;
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const out: Alignment[] = [];
  for (const raw of cells) {
    const m = SEPARATOR_CELL_RE.exec(raw);
    if (m === null) return null;
    const left = m[1] === ':';
    const right = m[2] === ':';
    if (left && right) out.push('center');
    else if (right) out.push('right');
    else out.push('left');
  }
  return out;
}

/**
 * Detection helper — returns true for a header line that *could* start
 * a table. We require at least one pipe, since the separator rule will
 * reject single-cell rows downstream.
 */
function looksLikeHeaderRow(line: string): boolean {
  // Count unescaped pipes.
  let pipes = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch === '\\' && i + 1 < line.length && line.charAt(i + 1) === '|') {
      i++;
      continue;
    }
    if (ch === '|') pipes++;
  }
  return pipes >= 1;
}

/** Pad/truncate a row's cell count to match the header width. */
function normaliseRow(cells: string[], width: number): string[] {
  if (cells.length === width) return cells;
  if (cells.length > width) return cells.slice(0, width);
  const out = cells.slice();
  while (out.length < width) out.push('');
  return out;
}

/**
 * Walk markdown source line-by-line. Whenever a header+separator pair
 * is detected, gather subsequent body rows until a non-row line. The
 * result preserves order: surrounding text becomes `text` blocks.
 */
export function parseTables(source: string): ParseTablesResult {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: TableBlock[] = [];
  let textBuf: string[] = [];
  let i = 0;

  const flushText = (): void => {
    if (textBuf.length === 0) return;
    blocks.push({ kind: 'text', content: textBuf.join('\n') });
    textBuf = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const next = i + 1 < lines.length ? (lines[i + 1] ?? '') : null;

    // Try header+separator detection.
    if (
      next !== null &&
      looksLikeHeaderRow(line) &&
      SEPARATOR_LINE_RE.test(next)
    ) {
      const headerCells = splitRow(line);
      const alignments = parseSeparator(next);
      if (
        alignments !== null &&
        headerCells.length >= 2 &&
        alignments.length === headerCells.length
      ) {
        // Commit any pending text.
        flushText();
        // Gather body rows.
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length) {
          const row = lines[j] ?? '';
          if (row.trim().length === 0) break;
          if (!looksLikeHeaderRow(row)) break;
          const cells = splitRow(row);
          rows.push(normaliseRow(cells, headerCells.length));
          j++;
        }
        blocks.push({
          kind: 'table',
          table: {
            headers: headerCells,
            alignments,
            rows,
          },
        });
        i = j;
        continue;
      }
    }

    textBuf.push(line);
    i++;
  }

  flushText();
  return { blocks };
}
