/**
 * MarketplaceOverlay — generic list-with-detail overlay used by the
 * `/skills browse` and `/mcp browse` slash commands.
 *
 * Both modes share the same key bindings:
 *   ↑/↓     navigate
 *   Enter   install into the global location (~/.localcode/...)
 *   P       install into the project location (skills only)
 *   /       enter filter mode (typing narrows the list)
 *   R       force-refresh (re-fetch upstream ignoring cache)
 *   Esc     close the overlay (or exit filter mode if active)
 *
 * The component is intentionally state-light: it receives a fetched
 * entry list from the parent + a small set of callbacks for install /
 * refresh. Async loading + install error toasts are surfaced via the
 * `loading`, `error`, and `info` props.
 *
 * Mode prop ('skills' | 'mcp') drives the heading + install affordances
 * — MCP servers ignore the "install to project" hotkey because the
 * config is global by design.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type {
  MarketplaceMcpServer,
  MarketplaceSkill,
} from '@/marketplace/types';

export type MarketplaceMode = 'skills' | 'mcp';

export type MarketplaceEntry = MarketplaceSkill | MarketplaceMcpServer;

export interface MarketplaceOverlayProps {
  readonly mode: MarketplaceMode;
  readonly entries: ReadonlyArray<MarketplaceEntry>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly info: string | null;
  /** Cache age in ms (0 means fresh). */
  readonly cacheAgeMs: number;
  /** True when the entries came from cache after upstream failed. */
  readonly stale: boolean;
  /** True when upstream returned 403 (rate-limited). */
  readonly rateLimited: boolean;
  readonly onInstallGlobal: (entry: MarketplaceEntry) => void;
  readonly onInstallProject?: (entry: MarketplaceEntry) => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
  /** Optional translation function — defaults to a passthrough. */
  readonly t?: (key: string, vars?: Record<string, string | number>) => string;
}

function entryName(entry: MarketplaceEntry): string {
  return entry.name.length > 0 ? entry.name : entry.id;
}

function entryDescription(entry: MarketplaceEntry): string {
  return entry.description.length > 0 ? entry.description : '(no description)';
}

function formatAge(ms: number): string {
  if (ms <= 0) return 'fresh';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function defaultT(key: string, vars?: Record<string, string | number>): string {
  if (vars === undefined) return key;
  let out = key;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

function MarketplaceOverlay({
  mode,
  entries,
  loading,
  error,
  info,
  cacheAgeMs,
  stale,
  rateLimited,
  onInstallGlobal,
  onInstallProject,
  onRefresh,
  onClose,
  t,
}: MarketplaceOverlayProps): React.JSX.Element {
  const translate = t ?? defaultT;
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState('');
  const [filterMode, setFilterMode] = useState(false);

  const filtered = useMemo(() => {
    if (filter.length === 0) return entries;
    const lower = filter.toLowerCase();
    return entries.filter((e) => {
      return (
        e.id.toLowerCase().includes(lower) ||
        e.name.toLowerCase().includes(lower) ||
        e.description.toLowerCase().includes(lower)
      );
    });
  }, [entries, filter]);

  const clampSelected = useCallback(
    (next: number): number => {
      if (filtered.length === 0) return 0;
      if (next < 0) return 0;
      if (next >= filtered.length) return filtered.length - 1;
      return next;
    },
    [filtered.length],
  );

  useInput(
    useCallback(
      (input: string, key: { upArrow?: boolean; downArrow?: boolean; escape?: boolean; return?: boolean; backspace?: boolean; delete?: boolean }) => {
        // Filter-mode capture takes precedence so the typed query
        // doesn't trigger global hotkeys (R -> refresh would otherwise
        // fire while the user types "redis").
        if (filterMode) {
          if (key.escape) {
            setFilterMode(false);
            setFilter('');
            return;
          }
          if (key.return) {
            setFilterMode(false);
            setSelected(0);
            return;
          }
          if (key.backspace || key.delete) {
            setFilter((prev) => prev.slice(0, -1));
            setSelected(0);
            return;
          }
          // Plain printable character.
          if (typeof input === 'string' && input.length === 1 && input >= ' ') {
            setFilter((prev) => prev + input);
            setSelected(0);
            return;
          }
          return;
        }

        if (key.escape) {
          onClose();
          return;
        }
        if (key.upArrow) {
          setSelected((prev) => clampSelected(prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelected((prev) => clampSelected(prev + 1));
          return;
        }
        if (key.return) {
          const chosen = filtered[selected];
          if (chosen !== undefined) onInstallGlobal(chosen);
          return;
        }
        const ch = (input ?? '').toLowerCase();
        if (ch === 'p' && mode === 'skills' && onInstallProject !== undefined) {
          const chosen = filtered[selected];
          if (chosen !== undefined) onInstallProject(chosen);
          return;
        }
        if (ch === 'r') {
          onRefresh();
          return;
        }
        if (ch === '/') {
          setFilterMode(true);
          return;
        }
      },
      [
        clampSelected,
        filterMode,
        filtered,
        mode,
        onClose,
        onInstallGlobal,
        onInstallProject,
        onRefresh,
        selected,
      ],
    ),
  );

  const title =
    mode === 'skills'
      ? translate('marketplace.title.skills')
      : translate('marketplace.title.mcp');

  const headerSuffix = stale
    ? ` (${translate('marketplace.cached', { age: formatAge(cacheAgeMs) })})`
    : cacheAgeMs > 0
      ? ` · ${translate('marketplace.cached', { age: formatAge(cacheAgeMs) })}`
      : '';

  const installHints = mode === 'skills'
    ? `Enter ${translate('marketplace.hint.global')} · P ${translate('marketplace.hint.project')}`
    : `Enter ${translate('marketplace.hint.global')}`;

  const filterHint = filterMode
    ? `/${filter}_`
    : filter.length > 0
      ? `/${filter}`
      : '';

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} paddingY={1}>
      <Box>
        <Text bold>{title}</Text>
        {headerSuffix.length > 0 ? <Text dimColor>{headerSuffix}</Text> : null}
      </Box>
      {rateLimited ? (
        <Box marginTop={0}>
          <Text color="yellow">{translate('marketplace.rateLimited')}</Text>
        </Box>
      ) : null}
      {filterHint.length > 0 ? (
        <Box marginTop={0}>
          <Text dimColor>{filterHint}</Text>
        </Box>
      ) : null}
      {loading ? (
        <Box marginTop={1}>
          <Text dimColor>{translate('marketplace.loading')}</Text>
        </Box>
      ) : filtered.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>{translate('marketplace.empty')}</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {filtered.map((entry, idx) => (
            <Box key={entry.id} flexDirection="row">
              <Text color={idx === selected ? 'cyan' : undefined}>
                {idx === selected ? '› ' : '  '}
                {entryName(entry)}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      {filtered[selected] !== undefined ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{entryDescription(filtered[selected] as MarketplaceEntry)}</Text>
          <Text dimColor>{(filtered[selected] as MarketplaceEntry).url}</Text>
        </Box>
      ) : null}
      {info !== null ? (
        <Box marginTop={1}>
          <Text color="green">{info}</Text>
        </Box>
      ) : null}
      {error !== null ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>
          {`↑/↓ · ${installHints} · / filter · R ${translate('marketplace.hint.refresh')} · Esc close`}
        </Text>
      </Box>
    </Box>
  );
}

export default MarketplaceOverlay;

/** Exported for tests. */
export const __test__ = {
  formatAge,
};
