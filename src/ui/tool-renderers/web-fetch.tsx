/**
 * TOOL-RENDERERS-SECTION — `web_fetch` rich renderer.
 *
 * Displays a result card: URL header + a short preview of the body.
 * Long bodies are clipped to the first ~10 lines — the model already
 * has the full content in its message stream, the UI just needs a
 * digestible "what came back".
 */

import React from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
import type {
  RenderToolResult,
  ToolRendererResult,
} from './types.js';

const PREVIEW_LINES = 10;

interface WebFetchArgs {
  readonly url?: unknown;
}

function getUrl(args: Record<string, unknown>): string | undefined {
  const u = (args as WebFetchArgs).url;
  return typeof u === 'string' && u.length > 0 ? u : undefined;
}

function WebFetchRenderer({
  args,
  result,
}: {
  readonly args: Record<string, unknown>;
  readonly result: ToolRendererResult;
}): React.JSX.Element | null {
  const url = getUrl(args);
  const raw = result.output ?? '';
  if (raw.length === 0 && url === undefined) return null;
  const lines = raw.split('\n');
  const preview = lines.slice(0, PREVIEW_LINES);
  const hiddenCount = Math.max(0, lines.length - preview.length);
  return (
    <Box flexDirection="column" paddingLeft={3} marginTop={0}>
      {url !== undefined && (
        <Box flexDirection="row">
          <Text color={noxPalette.highlight} bold>
            {'🌐 '}
          </Text>
          <Text color={noxPalette.light} underline>
            {url}
          </Text>
        </Box>
      )}
      {preview.length > 0 && (
        <Box flexDirection="column" paddingLeft={1}>
          {preview.map((line, i) => (
            <Text key={`wf-${i}`} color={textMuted}>
              {line.length === 0 ? ' ' : line}
            </Text>
          ))}
          {hiddenCount > 0 && (
            <Text color={textMuted} italic>
              {`… ${hiddenCount} more line${hiddenCount === 1 ? '' : 's'}`}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

export const render: RenderToolResult = (args, result) => {
  if (result.status !== 'done') return null;
  return <WebFetchRenderer args={args} result={result} />;
};
