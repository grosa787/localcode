/**
 * Single tool-invocation block inside the chat log.
 *
 * Render:
 *   ● <name>(<args>)                    ← header
 *   └─ OK: <first 80 chars of output>   ← on `done` (fallback only)
 *   └─ ERROR: <message>                 ← on `error`
 *   └─ <rich renderer output>           ← when a tool-renderer matches
 *
 * When status === 'running' the bullet is replaced by a yellow spinner
 * glyph that ticks at 80 ms. Argument values are truncated to 40 chars
 * and joined with `, `.
 *
 * TOOL-RENDERERS-SECTION (rich output):
 *   We consult `pickRenderer(name)` for a per-tool rich renderer. When
 *   one matches AND returns a non-null element, it replaces the plain
 *   `└─ OK: <preview>` line. The status header stays unchanged so the
 *   visual rhythm of the chat log is preserved.
 *
 *   The block is wrapped in a `<RefRegistryProvider>` so `<FileRef>`
 *   children — which the renderers emit for grep-style results, edit
 *   diff headers, and so on — get a scoped numbered registry. A
 *   `<RefPickOverlay>` inside the same provider handles Ctrl+O ref
 *   jumps and routes them through the optional `onFileRefJump`
 *   callback supplied by the caller.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { spinnerFrames, theme, noxPalette } from '../theme.js';
import { pickRenderer } from '../tool-renderers/index.js';
import {
  RefRegistryProvider,
  type RefEntry,
} from '../hooks/useRefRegistry.js';
import RefPickOverlay from './RefPickOverlay.js';

export type ToolCallStatus = 'pending' | 'running' | 'done' | 'error';

export interface ToolCallBlockProps {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: ToolCallStatus;
  readonly output?: string;
  readonly error?: string;
  /**
   * Optional jump handler invoked when the user picks a file reference
   * via the Ctrl+O overlay. When unset, the overlay still opens and
   * navigates but the picked entry is dropped on the floor (acceptable
   * fallback — the user sees the path/line and can copy it manually).
   */
  readonly onFileRefJump?: (entry: RefEntry) => void;
}

const MAX_ARG_VALUE = 40;
const MAX_OUTPUT_PREVIEW = 80;

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}…`;
}

function formatArgValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return truncate(JSON.stringify(value), MAX_ARG_VALUE);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return truncate(JSON.stringify(value), MAX_ARG_VALUE);
  } catch {
    return '[unserializable]';
  }
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${formatArgValue(v)}`).join(', ');
}

function statusGlyph(status: ToolCallStatus, spinner: string): string {
  switch (status) {
    case 'running':
      return spinner;
    case 'done':
      return '●';
    case 'error':
      return '●';
    case 'pending':
    default:
      return '●';
  }
}

function statusColor(status: ToolCallStatus): 'white' | 'yellow' | 'green' | 'red' | 'gray' {
  switch (status) {
    case 'running':
      return 'yellow';
    case 'done':
      return 'green';
    case 'error':
      return 'red';
    case 'pending':
    default:
      return 'white';
  }
}

function useSpinnerFrame(active: boolean): string {
  const [frame, setFrame] = useState<number>(0);
  useEffect(() => {
    if (!active) return undefined;
    const handle = setInterval(() => {
      setFrame((f) => (f + 1) % spinnerFrames.length);
    }, 80);
    return () => clearInterval(handle);
  }, [active]);
  return spinnerFrames[frame] ?? spinnerFrames[0] ?? '⠋';
}

function ToolCallBlockImpl({
  name,
  args,
  status,
  output,
  error,
  onFileRefJump,
}: ToolCallBlockProps): React.JSX.Element {
  const spinner = useSpinnerFrame(status === 'running');
  const glyph = statusGlyph(status, spinner);
  const color = statusColor(status);
  const argsStr = formatArgs(args);

  // TOOL-RENDERERS-SECTION — try the rich renderer first. When it
  // returns a non-null element we render that BELOW the header and skip
  // the plain `OK: <preview>` line. The renderer is consulted on every
  // render but it's pure; React.memo above ensures we only re-enter on
  // a relevant prop change.
  const rendererFn = pickRenderer(name);
  const richResult =
    rendererFn !== undefined
      ? rendererFn(args, { status, output, error }, { projectRoot: '' })
      : null;

  const handleJump = useCallback(
    (entry: RefEntry): void => {
      if (onFileRefJump !== undefined) onFileRefJump(entry);
    },
    [onFileRefJump],
  );

  const headerRow = (
    <Box flexDirection="row">
      <Text color={color}>{glyph}</Text>
      <Text> </Text>
      <Text bold>{name}</Text>
      <Text color="gray">(</Text>
      <Text color="gray">{argsStr}</Text>
      <Text color="gray">)</Text>
    </Box>
  );

  // Error rows always render plain so the error stays readable and
  // doesn't get hidden behind rich output formatting.
  if (status === 'error') {
    return (
      <Box flexDirection="column" paddingX={1}>
        {headerRow}
        <Box flexDirection="row">
          <Text color="gray">{theme.toolResult}</Text>
          <Text color="red"> ERROR</Text>
          {error !== undefined && error.length > 0 && (
            <Text color="red">: {truncate(error, MAX_OUTPUT_PREVIEW)}</Text>
          )}
        </Box>
      </Box>
    );
  }

  if (status === 'done' && richResult !== null) {
    return (
      <RefRegistryProvider>
        <Box flexDirection="column" paddingX={1}>
          {headerRow}
          <Box flexDirection="row">
            <Text color="gray">{theme.toolResult}</Text>
            <Text color={noxPalette.highlight}> rich</Text>
          </Box>
          {richResult}
          <RefPickOverlay onJump={handleJump} />
        </Box>
      </RefRegistryProvider>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {headerRow}
      {status === 'done' && (
        <Box flexDirection="row">
          <Text color="gray">{theme.toolResult}</Text>
          <Text color="green"> OK</Text>
          {output !== undefined && output.length > 0 && (
            <Text color="gray">: {truncate(output.replace(/\s+/g, ' '), MAX_OUTPUT_PREVIEW)}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

/**
 * R7 (Agent 4) — flicker reduction. ToolCallBlock takes an `args`
 * object which is rarely referentially stable across parent re-renders
 * (the parent often spreads tool-call payloads into a fresh object on
 * each render), so the default `Object.is` comparator would never
 * skip a render. Instead we serialise the args to a string and
 * compare that — combined with the four primitive props this gives
 * us a stable "no change" decision that lets the spinner-driving
 * `useSpinnerFrame` interval run privately inside the component
 * without paying the cost of a parent-driven repaint on every
 * keystroke / streamed chunk above.
 */
function toolCallPropsAreEqual(
  prev: ToolCallBlockProps,
  next: ToolCallBlockProps,
): boolean {
  if (prev.name !== next.name) return false;
  if (prev.status !== next.status) return false;
  if (prev.output !== next.output) return false;
  if (prev.error !== next.error) return false;
  if (prev.args === next.args) return true;
  // Cheap structural equality — the rendered string is what we care
  // about, and `formatArgs` truncates per-value, so equal
  // serialisations imply equal output. We compute a JSON form here
  // (NOT the formatted string) because it's strictly cheaper and
  // doesn't depend on `formatArgs`' truncation logic.
  try {
    return JSON.stringify(prev.args) === JSON.stringify(next.args);
  } catch {
    // If args contain unserialisable values (cycles, etc.), fall back
    // to NOT equal — safer to repaint than to drop a real change.
    return false;
  }
}

const ToolCallBlock = React.memo(ToolCallBlockImpl, toolCallPropsAreEqual);

export default ToolCallBlock;
