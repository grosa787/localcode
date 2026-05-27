/**
 * /metrics — local-only metrics dashboard overlay.
 *
 * Full-screen ink overlay rendering the read-only {@link MetricsSnapshot}
 * across four tab pages:
 *
 *   ┌─ Metrics ─────────────────────────────────────────┐
 *   │ Window: 2024-01-01 → 2024-01-31 · 142 sessions    │
 *   │ [Tools] Cache Cost Sessions                        │
 *   ├───────────────────────────────────────────────────┤
 *   │ (tab body — bars/tables)                          │
 *   ├───────────────────────────────────────────────────┤
 *   │ ← → switch tabs · Esc close · R refresh           │
 *   └───────────────────────────────────────────────────┘
 *
 * The overlay is a dumb renderer — the parent precomputes the snapshot
 * via `snapshot()` and hands it in via `data`. Refresh re-invokes
 * `onRefresh` which lets the parent re-aggregate; while the parent is
 * refreshing it can pass `isRefreshing` to dim the title bar.
 *
 * When `data.disabled === true` the body renders the opt-in hint and
 * suppresses tab switching — the only useful actions are "open config"
 * and "close".
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { noxPalette, textMuted } from '../theme.js';
import { useT } from '@/i18n';
import type {
  CostByModelRow,
  ExpensiveSessionRow,
  MetricsSnapshot,
  ToolStatRow,
} from '@/telemetry/types';

export interface MetricsOverlayProps {
  readonly data: MetricsSnapshot;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly isRefreshing?: boolean;
}

type Tab = 'tools' | 'cache' | 'cost' | 'sessions';
const TAB_ORDER: readonly Tab[] = ['tools', 'cache', 'cost', 'sessions'];

const BAR_WIDTH = 24;

/** Format an ms-epoch as `yyyy-mm-dd`. */
function formatDate(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '—';
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms - min * 60_000) / 1000);
  return `${min}m${sec}s`;
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const safe = s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
  const padCount = Math.max(0, width - safe.length);
  return align === 'right' ? ' '.repeat(padCount) + safe : safe + ' '.repeat(padCount);
}

/**
 * Render a horizontal bar of width {@link BAR_WIDTH}, filled
 * proportional to `ratio` ∈ [0,1]. Uses the `█▌` block characters from
 * the design spec so the bar has half-cell resolution.
 */
function Bar({ ratio }: { readonly ratio: number }): React.JSX.Element {
  const clamped = Math.max(0, Math.min(1, ratio));
  const doubleCells = clamped * BAR_WIDTH * 2; // half-cell resolution
  const fullCells = Math.floor(doubleCells / 2);
  const halfCell = doubleCells - fullCells * 2 >= 1 ? 1 : 0;
  const emptyCells = Math.max(0, BAR_WIDTH - fullCells - halfCell);
  return (
    <Text>
      <Text color={noxPalette.highlight}>{'█'.repeat(fullCells)}</Text>
      {halfCell === 1 && <Text color={noxPalette.highlight}>{'▌'}</Text>}
      <Text color={textMuted} dimColor>
        {'░'.repeat(emptyCells)}
      </Text>
    </Text>
  );
}

function MetricsOverlay({
  data,
  onClose,
  onRefresh,
  isRefreshing,
}: MetricsOverlayProps): React.JSX.Element {
  const { t } = useT();
  const [tabIdx, setTabIdx] = useState(0);

  const handleInput = useCallback(
    (
      input: string,
      key: {
        escape?: boolean;
        leftArrow?: boolean;
        rightArrow?: boolean;
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
      if (data.disabled) return;
      if (key.leftArrow === true) {
        setTabIdx((i) => (i - 1 + TAB_ORDER.length) % TAB_ORDER.length);
        return;
      }
      if (key.rightArrow === true) {
        setTabIdx((i) => (i + 1) % TAB_ORDER.length);
      }
    },
    [data.disabled, onClose, onRefresh],
  );

  useInput(handleInput);

  const activeTab: Tab = TAB_ORDER[tabIdx] ?? 'tools';

  const headerText = useMemo(
    () =>
      t('metrics.window', {
        start: formatDate(data.windowStart),
        end: formatDate(data.windowEnd),
      }),
    [data.windowEnd, data.windowStart, t],
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
          {t('metrics.title')}
        </Text>
        {isRefreshing === true && (
          <Text color={textMuted}>{'   '}refreshing…</Text>
        )}
      </Box>

      <Box flexDirection="row" marginTop={1}>
        <Text color={textMuted}>{headerText}</Text>
        <Text color={textMuted}>
          {'  ·  '}
          {data.sessionsCounted} sessions
        </Text>
      </Box>

      {/* Tab strip — only meaningful when telemetry is enabled. */}
      {!data.disabled && (
        <Box flexDirection="row" marginTop={1}>
          {TAB_ORDER.map((id, i) => {
            const selected = i === tabIdx;
            const label =
              id === 'tools'
                ? t('metrics.tab.tools')
                : id === 'cache'
                  ? t('metrics.tab.cache')
                  : id === 'cost'
                    ? t('metrics.tab.cost')
                    : t('metrics.tab.sessions');
            return (
              <Box key={id} marginRight={2}>
                <Text
                  color={selected ? noxPalette.highlight : textMuted}
                  bold={selected}
                  underline={selected}
                >
                  {label}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Body */}
      <Box marginTop={1} flexDirection="column">
        {data.disabled ? (
          <DisabledBody hint={t('metrics.disabled')} />
        ) : activeTab === 'tools' ? (
          <ToolsTab rows={data.toolSuccessRate} />
        ) : activeTab === 'cache' ? (
          <CacheTab percent={data.cacheHitPercent} avgDurationMs={data.avgTurnDurationMs} />
        ) : activeTab === 'cost' ? (
          <CostTab rows={data.costByModel} />
        ) : (
          <SessionsTab rows={data.topExpensiveSessions} />
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text color={textMuted}>← → switch tabs · Esc close · R refresh</Text>
      </Box>
    </Box>
  );
}

function DisabledBody({ hint }: { readonly hint: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={noxPalette.yellow}>{hint}</Text>
    </Box>
  );
}

function ToolsTab({ rows }: { readonly rows: readonly ToolStatRow[] }): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <Text color={textMuted} dimColor>
        (no tool-call telemetry in the window)
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={textMuted}>{pad('tool', 22)}</Text>
        <Text color={textMuted}>{pad('ok', 6, 'right')}</Text>
        <Text color={textMuted}>{pad('fail', 6, 'right')}</Text>
        <Text color={textMuted}>{pad('rate', 6, 'right')}</Text>
        <Text color={textMuted}>{'  '}</Text>
      </Box>
      {rows.map((r) => (
        <Box flexDirection="row" key={`tool-${r.toolName}`}>
          <Text color={noxPalette.white}>{pad(r.toolName, 22)}</Text>
          <Text color={noxPalette.light}>{pad(String(r.success), 6, 'right')}</Text>
          <Text color={noxPalette.light}>{pad(String(r.failure), 6, 'right')}</Text>
          <Text color={noxPalette.highlight}>
            {pad(formatPercent(r.rate * 100), 6, 'right')}
          </Text>
          <Text color={textMuted}>{'  '}</Text>
          <Bar ratio={r.rate} />
        </Box>
      ))}
    </Box>
  );
}

function CacheTab({
  percent,
  avgDurationMs,
}: {
  readonly percent: number;
  readonly avgDurationMs: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={textMuted}>{pad('cache-hit', 22)}</Text>
        <Text color={noxPalette.highlight}>
          {pad(formatPercent(percent), 6, 'right')}
        </Text>
        <Text color={textMuted}>{'  '}</Text>
        <Bar ratio={percent / 100} />
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text color={textMuted}>{pad('avg turn duration', 22)}</Text>
        <Text color={noxPalette.white}>{formatDuration(avgDurationMs)}</Text>
      </Box>
    </Box>
  );
}

function CostTab({
  rows,
}: {
  readonly rows: readonly CostByModelRow[];
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <Text color={textMuted} dimColor>
        (no priced turns in the window — local models leave cost null)
      </Text>
    );
  }
  const maxUsd = rows.reduce((m, r) => (r.totalUsd > m ? r.totalUsd : m), 0);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={textMuted}>{pad('provider', 14)}</Text>
        <Text color={textMuted}>{pad('model', 28)}</Text>
        <Text color={textMuted}>{pad('turns', 6, 'right')}</Text>
        <Text color={textMuted}>{pad('cost', 10, 'right')}</Text>
        <Text color={textMuted}>{'  '}</Text>
      </Box>
      {rows.map((r) => (
        <Box flexDirection="row" key={`cost-${r.provider}-${r.model}`}>
          <Text color={textMuted}>{pad(r.provider, 14)}</Text>
          <Text color={noxPalette.white}>{pad(r.model, 28)}</Text>
          <Text color={noxPalette.light}>{pad(String(r.turns), 6, 'right')}</Text>
          <Text color={noxPalette.white}>{pad(formatCost(r.totalUsd), 10, 'right')}</Text>
          <Text color={textMuted}>{'  '}</Text>
          <Bar ratio={maxUsd > 0 ? r.totalUsd / maxUsd : 0} />
        </Box>
      ))}
    </Box>
  );
}

function SessionsTab({
  rows,
}: {
  readonly rows: readonly ExpensiveSessionRow[];
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <Text color={textMuted} dimColor>
        (no expensive sessions in the window)
      </Text>
    );
  }
  const maxUsd = rows.reduce((m, r) => (r.costUsd > m ? r.costUsd : m), 0);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={textMuted}>{pad('title', 40)}</Text>
        <Text color={textMuted}>{pad('cost', 10, 'right')}</Text>
        <Text color={textMuted}>{'  '}</Text>
      </Box>
      {rows.map((r) => (
        <Box flexDirection="row" key={`sess-${r.sessionId}`}>
          <Text color={noxPalette.white}>{pad(r.title, 40)}</Text>
          <Text color={noxPalette.white}>{pad(formatCost(r.costUsd), 10, 'right')}</Text>
          <Text color={textMuted}>{'  '}</Text>
          <Bar ratio={maxUsd > 0 ? r.costUsd / maxUsd : 0} />
        </Box>
      ))}
    </Box>
  );
}

export default MetricsOverlay;

export const __test__ = {
  formatDate,
  formatPercent,
  formatDuration,
  formatCost,
  pad,
  TAB_ORDER,
};
