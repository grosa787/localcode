/**
 * /usage — global usage dashboard.
 *
 * Full-screen ink overlay showing total spend across every session in
 * the database. Renders four sections:
 *
 *   ┌─ Usage ─────────────────────────────────────┐
 *   │ Total: $12.34 · 1.2M tokens · 42 sessions   │
 *   │ Favorite: anthropic/claude-3.5-sonnet       │
 *   ├─ By model ──────────────────────────────────┤
 *   │ model            input    out    cached  $  │
 *   │ claude-3.5-...   980k     45k    12k     ...│
 *   │ ...                                          │
 *   ├─ Top sessions ──────────────────────────────┤
 *   │ title            model       tokens  $  when│
 *   │ ...                                          │
 *   └─ r refresh · esc close · ↑↓ navigate ───────┘
 *
 * The component is "dumb" — the parent precomputes every number and
 * passes the structured `data` prop in. Refresh re-invokes `onRefresh`
 * which lets the parent re-aggregate via SessionManager and re-fetch
 * OpenRouter pricing. ESC closes; ↑/↓ scrolls the session table;
 * ENTER on a session row invokes `onSelectSession(id)`.
 */

import React, { useCallback, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { noxPalette, textMuted } from '../theme.js';
import { formatCostCell } from '@/llm/pricing/cost-calculator';

export interface UsageByModelRow {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly cost: number;
  readonly cacheHitPct: number;
}

export interface UsageTopSessionRow {
  readonly sessionId: string;
  readonly title: string;
  readonly model: string;
  readonly tokens: number;
  readonly cost: number;
  readonly when: number;
}

export interface UsageDashboardData {
  readonly totalCost: number;
  readonly totalTokens: number;
  readonly sessionCount: number;
  readonly favoriteModel: string | null;
  readonly perModel: readonly UsageByModelRow[];
  readonly topSessions: readonly UsageTopSessionRow[];
}

export interface UsageDashboardProps {
  readonly data: UsageDashboardData;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
  readonly onSelectSession?: (sessionId: string) => void;
  readonly isRefreshing?: boolean;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return String(n);
}

function formatRelative(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '—';
  const diff = Date.now() - epochMs;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Truncate a string to `width` columns with an ellipsis. Used by the
 * tabular columns so a 60-char session title doesn't blow the row
 * apart on an 80-column terminal.
 */
function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const safe = s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
  const padCount = Math.max(0, width - safe.length);
  return align === 'right' ? ' '.repeat(padCount) + safe : safe + ' '.repeat(padCount);
}

/**
 * Mini cache-hit bar. 8 chars wide, filled proportionally to the
 * percentage. Lavender on the filled portion, dim background on the
 * empty.
 */
function CacheBar({ pct }: { readonly pct: number }): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * 8);
  const empty = 8 - filled;
  return (
    <Text>
      <Text color={noxPalette.highlight}>{'█'.repeat(filled)}</Text>
      <Text color={textMuted} dimColor>
        {'░'.repeat(empty)}
      </Text>
      <Text color={textMuted}> {Math.round(clamped)}%</Text>
    </Text>
  );
}

function UsageDashboard({
  data,
  onRefresh,
  onClose,
  onSelectSession,
  isRefreshing,
}: UsageDashboardProps): React.JSX.Element {
  const [cursor, setCursor] = useState(0);

  useInput(
    useCallback(
      (
        input: string,
        key: {
          escape?: boolean;
          return?: boolean;
          upArrow?: boolean;
          downArrow?: boolean;
        },
      ) => {
        if (key.escape === true) {
          onClose();
          return;
        }
        if (input.toLowerCase() === 'r') {
          onRefresh();
          return;
        }
        if (key.upArrow === true) {
          setCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (key.downArrow === true) {
          setCursor((c) => Math.min(data.topSessions.length - 1, c + 1));
          return;
        }
        if (key.return === true && onSelectSession !== undefined) {
          const row = data.topSessions[cursor];
          if (row !== undefined) onSelectSession(row.sessionId);
        }
      },
      [cursor, data.topSessions, onClose, onRefresh, onSelectSession],
    ),
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={noxPalette.light}
      paddingX={1}
      paddingY={1}
    >
      {/* Header */}
      <Box flexDirection="row">
        <Text color={noxPalette.white} bold>
          Usage
        </Text>
        {isRefreshing === true && (
          <Text color={textMuted}>{'   '}refreshing…</Text>
        )}
      </Box>

      <Box flexDirection="row" marginTop={1}>
        <Text color={textMuted}>Total spend: </Text>
        <Text color={noxPalette.white} bold>
          {formatCostCell(data.totalCost)}
        </Text>
        <Text color={textMuted}>{'  ·  '}</Text>
        <Text color={noxPalette.white}>{formatTokens(data.totalTokens)} tokens</Text>
        <Text color={textMuted}>{'  ·  '}</Text>
        <Text color={noxPalette.white}>{data.sessionCount} sessions</Text>
      </Box>

      <Box flexDirection="row" marginTop={1}>
        <Text color={textMuted}>Favorite model: </Text>
        <Text color={noxPalette.highlight}>
          {data.favoriteModel ?? '(none yet)'}
        </Text>
      </Box>

      {/* By-model table */}
      <Box marginTop={1}>
        <Text color={noxPalette.white} bold>
          By model
        </Text>
      </Box>
      <Box flexDirection="row">
        <Text color={textMuted}>{pad('model', 32)}</Text>
        <Text color={textMuted}>{pad('input', 10, 'right')}</Text>
        <Text color={textMuted}>{pad('output', 10, 'right')}</Text>
        <Text color={textMuted}>{pad('cached', 10, 'right')}</Text>
        <Text color={textMuted}>{pad('cost', 10, 'right')}</Text>
        <Text color={textMuted}>{'  '}cache-hit</Text>
      </Box>
      {data.perModel.length === 0 ? (
        <Box>
          <Text color={textMuted} dimColor>
            (no model usage recorded yet)
          </Text>
        </Box>
      ) : (
        data.perModel.map((row) => (
          <Box flexDirection="row" key={`model-${row.model}`}>
            <Text color={noxPalette.white}>{pad(row.model, 32)}</Text>
            <Text color={noxPalette.light}>{pad(formatTokens(row.inputTokens), 10, 'right')}</Text>
            <Text color={noxPalette.light}>{pad(formatTokens(row.outputTokens), 10, 'right')}</Text>
            <Text color={noxPalette.highlight}>{pad(formatTokens(row.cachedTokens), 10, 'right')}</Text>
            <Text color={noxPalette.white}>{pad(formatCostCell(row.cost), 10, 'right')}</Text>
            <Text color={textMuted}>{'  '}</Text>
            <CacheBar pct={row.cacheHitPct} />
          </Box>
        ))
      )}

      {/* Top sessions */}
      <Box marginTop={1}>
        <Text color={noxPalette.white} bold>
          Top sessions (cost desc)
        </Text>
      </Box>
      <Box flexDirection="row">
        <Text color={textMuted}>{'   '}</Text>
        <Text color={textMuted}>{pad('title', 32)}</Text>
        <Text color={textMuted}>{pad('model', 24)}</Text>
        <Text color={textMuted}>{pad('tokens', 10, 'right')}</Text>
        <Text color={textMuted}>{pad('cost', 10, 'right')}</Text>
        <Text color={textMuted}>{'  when'}</Text>
      </Box>
      {data.topSessions.length === 0 ? (
        <Box>
          <Text color={textMuted} dimColor>
            (no sessions with token data yet)
          </Text>
        </Box>
      ) : (
        data.topSessions.map((row, i) => {
          const selected = i === cursor;
          return (
            <Box flexDirection="row" key={`sess-${row.sessionId}`}>
              <Text color={selected ? noxPalette.highlight : textMuted}>
                {selected ? ' ❯ ' : '   '}
              </Text>
              <Text color={selected ? noxPalette.white : noxPalette.light}>
                {pad(row.title, 32)}
              </Text>
              <Text color={textMuted}>{pad(row.model, 24)}</Text>
              <Text color={selected ? noxPalette.white : noxPalette.light}>
                {pad(formatTokens(row.tokens), 10, 'right')}
              </Text>
              <Text color={selected ? noxPalette.white : noxPalette.light}>
                {pad(formatCostCell(row.cost), 10, 'right')}
              </Text>
              <Text color={textMuted}>{'  '}{formatRelative(row.when)}</Text>
            </Box>
          );
        })
      )}

      {/* Footer hint */}
      <Box marginTop={1}>
        <Text color={textMuted}>
          r refresh · esc close · ↑↓ navigate{onSelectSession !== undefined ? ' · enter resume' : ''}
        </Text>
      </Box>
    </Box>
  );
}

export default UsageDashboard;

export const __test__ = {
  formatTokens,
  formatRelative,
  pad,
};
