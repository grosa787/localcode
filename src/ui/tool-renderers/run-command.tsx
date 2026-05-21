/**
 * TOOL-RENDERERS-SECTION — `run_command` rich renderer.
 *
 * Renders the shell output as a terminal-style block:
 *   - Header: `$ <command>` in the accent colour.
 *   - Body:   last 10 non-empty lines, each prefixed with `▎ `.
 *   - Footer: exit-code badge (✓ exit 0 / ✗ exit N), `[stderr]` marker
 *             when present.
 *
 * The body is intentionally tail-only: a 30s command can dump 50 KB
 * of log and the model rarely cares about anything past the last
 * dozen lines. The sticky tail makes the most-recent output the most
 * prominent thing on screen.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
import type {
  RenderToolResult,
  ToolRendererResult,
} from './types.js';

const TAIL_LINES = 10;

interface RunCommandArgs {
  readonly command?: unknown;
  readonly cwd?: unknown;
}

function getCommand(args: Record<string, unknown>): string | undefined {
  const c = (args as RunCommandArgs).command;
  return typeof c === 'string' && c.length > 0 ? c : undefined;
}

function getCwd(args: Record<string, unknown>): string | undefined {
  const c = (args as RunCommandArgs).cwd;
  return typeof c === 'string' && c.length > 0 ? c : undefined;
}

/**
 * Pull the exit code out of an error message of the form
 * `Exit N: ...`. Returns `undefined` when the message doesn't match.
 */
function parseExitCode(errorMessage: string): number | undefined {
  const match = /^Exit\s+(-?\d+)\s*:/.exec(errorMessage);
  if (match === null) return undefined;
  const n = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Pull the tail and a stderr marker out of the body. */
interface BodyTail {
  readonly tail: readonly string[];
  readonly hasStderr: boolean;
  readonly truncated: boolean;
}

function buildTail(body: string): BodyTail {
  const hasStderr = body.includes('\n[stderr]\n') || body.startsWith('[stderr]\n');
  const truncated =
    body.includes('[stdout truncated,') ||
    body.includes('[stderr truncated,') ||
    body.includes('[combined output truncated,');
  const lines = body.split('\n');
  // Drop trailing blanks so the tail isn't padding.
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').length === 0) {
    lines.pop();
  }
  const sliceStart = Math.max(0, lines.length - TAIL_LINES);
  return {
    tail: lines.slice(sliceStart),
    hasStderr,
    truncated,
  };
}

function RunCommandRenderer({
  args,
  result,
}: {
  readonly args: Record<string, unknown>;
  readonly result: ToolRendererResult;
}): React.JSX.Element | null {
  const command = getCommand(args);
  if (command === undefined) return null;
  const cwd = getCwd(args);

  const success = result.status === 'done';
  const errorMessage = result.error;
  const exitCode =
    !success && typeof errorMessage === 'string'
      ? parseExitCode(errorMessage)
      : success
        ? 0
        : undefined;

  const output = result.output ?? '';
  const { tail, hasStderr, truncated } = buildTail(output);

  const badgeText =
    exitCode === undefined
      ? success
        ? '✓ ok'
        : '✗ error'
      : exitCode === 0
        ? '✓ exit 0'
        : `✗ exit ${exitCode}`;
  const badgeColor = success && exitCode === 0 ? '#86efac' : '#fca5a5';

  return (
    <Box
      flexDirection="column"
      paddingLeft={3}
      marginTop={0}
    >
      <Box flexDirection="row">
        <Text color={noxPalette.highlight} bold>
          {'$ '}
        </Text>
        <Text color={noxPalette.white}>{command}</Text>
        {cwd !== undefined && (
          <Text color={textMuted}>{`  (in ${cwd})`}</Text>
        )}
      </Box>
      {tail.length > 0 && (
        <Box flexDirection="column" paddingLeft={1}>
          {tail.map((line, i) => (
            <Box key={`rc-${i}`} flexDirection="row">
              <Text color={textMuted}>{'▎ '}</Text>
              <Text color={hasStderr ? '#fca5a5' : noxPalette.white}>
                {line.length === 0 ? ' ' : line}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box flexDirection="row" marginTop={0}>
        <Text color={badgeColor} bold>
          {badgeText}
        </Text>
        {hasStderr && (
          <Text color={textMuted}>{'  [stderr]'}</Text>
        )}
        {truncated && (
          <Text color={textMuted}>{'  (output truncated)'}</Text>
        )}
        {!success &&
          typeof errorMessage === 'string' &&
          exitCode === undefined && (
            <Text color={textMuted}>{`  ${errorMessage}`}</Text>
          )}
      </Box>
    </Box>
  );
}

export const render: RenderToolResult = (args, result) => {
  if (result.status !== 'done' && result.status !== 'error') return null;
  if (typeof (args as RunCommandArgs).command !== 'string') return null;
  return <RunCommandRenderer args={args} result={result} />;
};
