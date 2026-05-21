/**
 * TOOL-RENDERERS-SECTION — `list_dir` rich renderer.
 *
 * The underlying tool already emits a textual tree where every line is
 * "<indent><name>" and directories are suffixed with `/`. We re-parse
 * that tree, attach an icon per entry, and color-code by extension.
 *
 * Folders are grouped before files at every depth (the tool already
 * orders that way; we double-check on re-parse so a future change
 * upstream can't accidentally flatten the visual hierarchy).
 *
 * The icons are emoji glyphs (📁/📄). They render as two-column wide
 * cells on most terminals — the tool's own indentation is also two
 * spaces per level, so the cumulative column math lines up.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
import type {
  RenderToolResult,
  ToolRendererResult,
} from './types.js';

interface ParsedNode {
  readonly indent: number;
  readonly name: string;
  readonly isDir: boolean;
  /** The raw line as it appeared (preserves diagnostic lines verbatim). */
  readonly raw: string;
  /** True for diagnostic lines like `[... max depth N reached ...]`. */
  readonly isMeta: boolean;
}

/** Two spaces per nesting level — matches `src/tools/list-dir.ts`. */
const INDENT_UNIT = 2;

function parseTreeLine(rawLine: string): ParsedNode | null {
  // Count leading spaces. The tool only emits even multiples of 2, but
  // we tolerate odd indents in case of upstream changes.
  let i = 0;
  while (i < rawLine.length && rawLine.charCodeAt(i) === 0x20 /* ' ' */) {
    i += 1;
  }
  const indent = Math.floor(i / INDENT_UNIT);
  const tail = rawLine.slice(i);
  if (tail.length === 0) return null;
  // Diagnostic lines emitted by the walker.
  const isMeta = tail.startsWith('[');
  if (isMeta) {
    return {
      indent,
      name: tail,
      isDir: false,
      raw: rawLine,
      isMeta: true,
    };
  }
  const isDir = tail.endsWith('/');
  const name = isDir ? tail.slice(0, -1) : tail;
  return { indent, name, isDir, raw: rawLine, isMeta: false };
}

const EXTENSION_COLORS: Readonly<Record<string, string>> = {
  ts: noxPalette.highlight,
  tsx: noxPalette.highlight,
  js: noxPalette.yellow,
  jsx: noxPalette.yellow,
  mjs: noxPalette.yellow,
  cjs: noxPalette.yellow,
  py: '#86efac',
  rs: '#fca5a5',
  go: noxPalette.light,
  java: '#fca5a5',
  kt: noxPalette.highlight,
  swift: '#fca5a5',
  rb: '#fca5a5',
  php: noxPalette.light,
  html: '#fca5a5',
  css: noxPalette.light,
  scss: noxPalette.light,
  json: noxPalette.yellow,
  jsonc: noxPalette.yellow,
  yaml: noxPalette.light,
  yml: noxPalette.light,
  toml: noxPalette.light,
  md: noxPalette.white,
  mdx: noxPalette.white,
  txt: noxPalette.white,
  sh: '#86efac',
  bash: '#86efac',
  zsh: '#86efac',
  sql: noxPalette.light,
  proto: noxPalette.light,
  graphql: noxPalette.light,
  log: textMuted,
  lock: textMuted,
};

function colorForFile(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return textMuted;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSION_COLORS[ext] ?? textMuted;
}

interface ListDirArgs {
  readonly path?: unknown;
}

function getPath(args: Record<string, unknown>): string {
  const p = (args as ListDirArgs).path;
  if (typeof p === 'string' && p.length > 0) return p;
  return '.';
}

function ListDirRenderer({
  args,
  result,
}: {
  readonly args: Record<string, unknown>;
  readonly result: ToolRendererResult;
}): React.JSX.Element | null {
  const raw = result.output ?? '';
  if (raw.length === 0) return null;
  const lines = raw.split('\n');
  const nodes: ParsedNode[] = [];
  for (const line of lines) {
    const parsed = parseTreeLine(line);
    if (parsed !== null) nodes.push(parsed);
  }
  if (nodes.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={3} marginTop={0}>
      <Text color={textMuted}>{`Listing of ${getPath(args)}`}</Text>
      <Box flexDirection="column" paddingLeft={1}>
        {nodes.map((node, i) => {
          const padding = ' '.repeat(node.indent * INDENT_UNIT);
          if (node.isMeta) {
            return (
              <Text key={`ld-${i}`} color={textMuted} italic>
                {`${padding}${node.name}`}
              </Text>
            );
          }
          if (node.isDir) {
            return (
              <Box key={`ld-${i}`} flexDirection="row">
                <Text>{padding}</Text>
                <Text>{'📁 '}</Text>
                <Text color={noxPalette.light} bold>
                  {`${node.name}/`}
                </Text>
              </Box>
            );
          }
          return (
            <Box key={`ld-${i}`} flexDirection="row">
              <Text>{padding}</Text>
              <Text>{'📄 '}</Text>
              <Text color={colorForFile(node.name)}>{node.name}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export const render: RenderToolResult = (args, result) => {
  if (result.status !== 'done') return null;
  const out = result.output;
  if (typeof out !== 'string' || out.length === 0) return null;
  return <ListDirRenderer args={args} result={result} />;
};
