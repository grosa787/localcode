/**
 * TOOL-RENDERERS-SECTION — search-result renderers.
 *
 * Shared between three tools:
 *   - `find_symbol`  → output is `Found N occurrences ... <indent>file:line:col — preview`
 *   - `glob_search`  → output is one matching path per line
 *   - `grep_search`  → hypothetical / external tool with the same shape
 *                      as `find_symbol`. The renderer is permissive
 *                      enough to handle any "file:line text" stream.
 *
 * Every match line that looks like `path:line[:col]` becomes a clickable
 * `<FileRef>` followed by the trailing snippet text. Lines that don't
 * match are rendered verbatim (header lines, footers, empty separators).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { textMuted, noxPalette } from '../theme.js';
import FileRef from '../components/FileRef.js';
import type {
  RenderToolResult,
  ToolRendererResult,
} from './types.js';

/**
 * Single match line shape after parsing. `header`/`footer` lines have
 * an undefined `file`.
 */
interface MatchLine {
  readonly raw: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly preview?: string;
}

/**
 * Parse a single output line. We look for `<file>:<line>[:<col>]` near
 * the start of the line (after optional whitespace), then take whatever
 * remains as the preview snippet.
 */
function parseLine(rawLine: string): MatchLine {
  const trimmed = rawLine.replace(/^\s+/, '');
  // Match `path:line[:col]`. Path body permits all characters except
  // whitespace and `:` so multi-segment paths still work.
  const match = /^([^\s:]+(?:[./\\][^\s:]+)*):(\d+)(?::(\d+))?(?:\s+[-—]\s+(.*))?$/.exec(
    trimmed,
  );
  if (match === null) {
    return { raw: rawLine };
  }
  const file = match[1];
  const lineStr = match[2];
  const colStr = match[3];
  const preview = match[4];
  if (file === undefined || lineStr === undefined) {
    return { raw: rawLine };
  }
  const line = Number.parseInt(lineStr, 10);
  if (!Number.isFinite(line) || line < 1) return { raw: rawLine };
  const column =
    colStr !== undefined && colStr.length > 0
      ? Number.parseInt(colStr, 10)
      : undefined;
  return { raw: rawLine, file, line, column, preview };
}

/** Detect a bare-path line emitted by `glob_search`. */
function looksLikeBarePath(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('[')) return false; // truncation footer
  if (trimmed.startsWith('No files')) return false;
  // A bare path has no whitespace and at least one slash or recognised
  // extension. We're being conservative here — false negatives just
  // mean a rendered plain line, which is fine.
  if (/\s/.test(trimmed)) return false;
  if (trimmed.includes(':')) return false; // already a file:line form
  if (trimmed.includes('/') || trimmed.includes('.')) return true;
  return false;
}

function isHeader(rawLine: string): boolean {
  return /^Found\s+\d+\+?\s+occurrences/.test(rawLine);
}

function isFooter(rawLine: string): boolean {
  return /^\s*\[/.test(rawLine);
}

function isNoMatch(rawLine: string): boolean {
  return (
    rawLine.startsWith('No occurrences of') ||
    rawLine.startsWith('No files matched')
  );
}

function GrepSearchRenderer({
  result,
}: {
  readonly result: ToolRendererResult;
}): React.JSX.Element | null {
  const raw = result.output ?? '';
  if (raw.length === 0) return null;
  const lines = raw.split('\n');
  return (
    <Box flexDirection="column" paddingLeft={3} marginTop={0}>
      {lines.map((line, i) => {
        // Header / footer / no-match informational lines.
        if (isHeader(line)) {
          return (
            <Text key={`gs-${i}`} color={noxPalette.highlight} bold>
              {line}
            </Text>
          );
        }
        if (isNoMatch(line)) {
          return (
            <Text key={`gs-${i}`} color={textMuted} italic>
              {line}
            </Text>
          );
        }
        if (isFooter(line)) {
          return (
            <Text key={`gs-${i}`} color={textMuted} italic>
              {line}
            </Text>
          );
        }
        // Try `file:line:col — preview` (find_symbol / grep_search shape).
        const parsed = parseLine(line);
        if (parsed.file !== undefined && parsed.line !== undefined) {
          return (
            <Box key={`gs-${i}`} flexDirection="row">
              <FileRef
                path={parsed.file}
                line={parsed.line}
                column={parsed.column}
              />
              {parsed.preview !== undefined && parsed.preview.length > 0 && (
                <Text color={textMuted}>{`  ${parsed.preview}`}</Text>
              )}
            </Box>
          );
        }
        // Bare-path line from glob_search.
        if (looksLikeBarePath(line)) {
          return (
            <Box key={`gs-${i}`}>
              <FileRef path={line.trim()} />
            </Box>
          );
        }
        // Trailing blank line in a multi-paragraph output.
        if (line.length === 0) {
          return <Text key={`gs-${i}`}> </Text>;
        }
        return (
          <Text key={`gs-${i}`} color={textMuted}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

export const render: RenderToolResult = (_args, result) => {
  if (result.status !== 'done') return null;
  const out = result.output;
  if (typeof out !== 'string' || out.length === 0) return null;
  return <GrepSearchRenderer result={result} />;
};
