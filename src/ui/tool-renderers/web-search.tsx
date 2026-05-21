/**
 * TOOL-RENDERERS-SECTION — `web_search` rich renderer.
 *
 * The tool emits a JSON envelope:
 *   { query: string; results: Array<{ title; url; snippet }> }
 *
 * We render each hit as a card:
 *   1. <title>
 *      <url> (muted, underlined)
 *      <snippet>
 *
 * Cards are separated by a blank line. Truncated to the first 8 hits to
 * keep the in-chat preview compact — the model still sees all of them.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
import type {
  RenderToolResult,
  ToolRendererResult,
} from './types.js';

const MAX_CARDS = 8;

interface RawHit {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly snippet?: unknown;
}

interface RawEnvelope {
  readonly query?: unknown;
  readonly results?: unknown;
}

interface NormalisedHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseEnvelope(output: string): {
  readonly query: string;
  readonly hits: readonly NormalisedHit[];
} | null {
  let env: RawEnvelope;
  try {
    env = JSON.parse(output) as RawEnvelope;
  } catch {
    return null;
  }
  if (env === null || typeof env !== 'object') return null;
  const rawResults = env.results;
  if (!Array.isArray(rawResults)) return null;
  const hits: NormalisedHit[] = [];
  for (const item of rawResults) {
    if (item === null || typeof item !== 'object') continue;
    const hit = item as RawHit;
    hits.push({
      title: asString(hit.title),
      url: asString(hit.url),
      snippet: asString(hit.snippet),
    });
  }
  return { query: asString(env.query), hits };
}

function WebSearchRenderer({
  result,
}: {
  readonly result: ToolRendererResult;
}): React.JSX.Element | null {
  const raw = result.output ?? '';
  if (raw.length === 0) return null;
  const parsed = parseEnvelope(raw);
  if (parsed === null) return null;
  const { query, hits } = parsed;
  const visible = hits.slice(0, MAX_CARDS);
  return (
    <Box flexDirection="column" paddingLeft={3} marginTop={0}>
      <Box flexDirection="row">
        <Text color={noxPalette.highlight} bold>
          {'🔎 '}
        </Text>
        <Text color={noxPalette.white}>{query}</Text>
        <Text color={textMuted}>{`  · ${hits.length} hits`}</Text>
      </Box>
      {visible.map((hit, i) => (
        <Box
          key={`ws-${i}`}
          flexDirection="column"
          paddingLeft={1}
          marginTop={0}
        >
          <Text color={noxPalette.white} bold>
            {hit.title.length > 0 ? hit.title : '(untitled)'}
          </Text>
          {hit.url.length > 0 && (
            <Text color={noxPalette.light} underline>
              {hit.url}
            </Text>
          )}
          {hit.snippet.length > 0 && (
            <Text color={textMuted}>{hit.snippet}</Text>
          )}
        </Box>
      ))}
      {hits.length > visible.length && (
        <Text color={textMuted} italic>
          {`… ${hits.length - visible.length} more result${
            hits.length - visible.length === 1 ? '' : 's'
          }`}
        </Text>
      )}
    </Box>
  );
}

export const render: RenderToolResult = (_args, result) => {
  if (result.status !== 'done') return null;
  const out = result.output;
  if (typeof out !== 'string' || out.length === 0) return null;
  return <WebSearchRenderer result={result} />;
};
