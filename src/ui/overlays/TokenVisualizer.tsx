/**
 * /perf · /tokens — live token visualiser overlay.
 *
 * Shows ASCII sparklines for the last N turns:
 *   - tokens-in / tokens-out
 *   - duration (ms)
 *   - cache-hit %
 * Plus a live tokens-per-second gauge when streaming.
 *
 * Sparkline characters: `▁▂▃▄▅▆▇█` (eight gradations). Each metric is
 * normalised independently so a slow turn doesn't flatten the
 * tokens-out chart.
 */

import React, { useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { noxPalette, textMuted } from '../theme.js';

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export interface TokenTurnSample {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly durationMs: number;
  /** 0..100 — fraction of input tokens served from cache. */
  readonly cacheHitPct: number;
}

export interface TokenVisualizerProps {
  readonly samples: readonly TokenTurnSample[];
  readonly liveTokensPerSec?: number;
  readonly liveCacheHitPct?: number;
  readonly liveLatencyMs?: number;
  readonly onClose: () => void;
}

/**
 * Convert an array of numbers into an ASCII sparkline string. Empty
 * input returns the dim sentinel '—'. Each sample is mapped to a
 * SPARK_CHARS index proportional to its value within [min, max]; a
 * flat series collapses to all-minimum.
 */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return '—';
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '—';
  const range = max - min;
  let out = '';
  for (const v of values) {
    const safe = Number.isFinite(v) ? v : min;
    const idx =
      range <= 0
        ? 0
        : Math.min(
            SPARK_CHARS.length - 1,
            Math.max(
              0,
              Math.round(((safe - min) / range) * (SPARK_CHARS.length - 1)),
            ),
          );
    out += SPARK_CHARS[idx] ?? SPARK_CHARS[0];
  }
  return out;
}

function format(n: number, suffix: string = ''): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M${suffix}`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k${suffix}`;
  return `${Math.round(n)}${suffix}`;
}

function TokenVisualizer({
  samples,
  liveTokensPerSec,
  liveCacheHitPct,
  liveLatencyMs,
  onClose,
}: TokenVisualizerProps): React.JSX.Element {
  useInput(
    useCallback(
      (_input: string, key: { escape?: boolean; return?: boolean }) => {
        if (key.escape === true || key.return === true) onClose();
      },
      [onClose],
    ),
  );

  const inSpark = sparkline(samples.map((s) => s.tokensIn));
  const outSpark = sparkline(samples.map((s) => s.tokensOut));
  const durSpark = sparkline(samples.map((s) => s.durationMs));
  const cacheSpark = sparkline(samples.map((s) => s.cacheHitPct));

  const lastIn = samples.length > 0 ? samples[samples.length - 1]?.tokensIn ?? 0 : 0;
  const lastOut = samples.length > 0 ? samples[samples.length - 1]?.tokensOut ?? 0 : 0;
  const lastDur = samples.length > 0 ? samples[samples.length - 1]?.durationMs ?? 0 : 0;
  const lastCache = samples.length > 0 ? samples[samples.length - 1]?.cacheHitPct ?? 0 : 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={noxPalette.light}
      paddingX={1}
      paddingY={1}
    >
      <Box>
        <Text color={noxPalette.white} bold>
          Tokens / latency
        </Text>
        <Text color={textMuted}>{'   '}last {samples.length} turns</Text>
      </Box>

      {/* Live row */}
      {(liveTokensPerSec !== undefined ||
        liveCacheHitPct !== undefined ||
        liveLatencyMs !== undefined) && (
        <Box flexDirection="row" marginTop={1}>
          {liveTokensPerSec !== undefined && (
            <Text>
              <Text color={textMuted}>live tok/s: </Text>
              <Text color={noxPalette.white}>{liveTokensPerSec.toFixed(1)}</Text>
              <Text color={textMuted}>{'  '}</Text>
            </Text>
          )}
          {liveCacheHitPct !== undefined && (
            <Text>
              <Text color={textMuted}>cache: </Text>
              <Text color={noxPalette.highlight}>{Math.round(liveCacheHitPct)}%</Text>
              <Text color={textMuted}>{'  '}</Text>
            </Text>
          )}
          {liveLatencyMs !== undefined && (
            <Text>
              <Text color={textMuted}>latency: </Text>
              <Text color={noxPalette.white}>{Math.round(liveLatencyMs)}ms</Text>
            </Text>
          )}
        </Box>
      )}

      {/* Sparklines */}
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Box width={14}>
            <Text color={textMuted}>tokens-in</Text>
          </Box>
          <Text color={noxPalette.light}>{inSpark}</Text>
          <Text color={textMuted}>{'   last: '}</Text>
          <Text color={noxPalette.white}>{format(lastIn)}</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={14}>
            <Text color={textMuted}>tokens-out</Text>
          </Box>
          <Text color={noxPalette.light}>{outSpark}</Text>
          <Text color={textMuted}>{'   last: '}</Text>
          <Text color={noxPalette.white}>{format(lastOut)}</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={14}>
            <Text color={textMuted}>duration</Text>
          </Box>
          <Text color={noxPalette.light}>{durSpark}</Text>
          <Text color={textMuted}>{'   last: '}</Text>
          <Text color={noxPalette.white}>{format(lastDur, 'ms')}</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={14}>
            <Text color={textMuted}>cache-hit%</Text>
          </Box>
          <Text color={noxPalette.highlight}>{cacheSpark}</Text>
          <Text color={textMuted}>{'   last: '}</Text>
          <Text color={noxPalette.white}>{Math.round(lastCache)}%</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={textMuted}>(esc / enter) close</Text>
      </Box>
    </Box>
  );
}

export default TokenVisualizer;

export const __test__ = {
  sparkline,
  format,
};
