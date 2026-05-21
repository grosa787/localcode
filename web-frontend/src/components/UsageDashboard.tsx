/**
 * UsageDashboard — modal showing token usage, $ cost, top sessions, and
 * a per-model / per-day breakdown.
 *
 * Layout:
 *   - Modal header: title + date-range selector (Today / 7d / 30d / All).
 *   - Top row: four UsageStatCard tiles (tokens, cost, sessions, turns).
 *   - Middle: UsageChart stacked bars (last N days, by range).
 *   - "Per model" table — sortable by cost desc, all-cost rendered with
 *     a "—" fallback when the model isn't in the pricing table.
 *   - "Top sessions" table — click a row to setActiveSession + close.
 *
 * Loading + empty states render in-modal so the user doesn't see a
 * blank shell when the period has no activity.
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';

import { useApiClients } from '../App';
import { useT } from '../i18n';
import { BarChart3, DollarSign, Clock, MessageSquare } from '../icons';
import { useStore } from '../state/store';
import type {
  GetUsageResponse,
  UsagePerModelWire,
  UsageTopSessionWire,
} from '../../../src/web/protocol/rest-types';

import { Modal, ModalBody } from './Modal';
import { UsageChart, type ChartDay } from './UsageChart';
import { UsageStatCard } from './UsageStatCard';
import styles from './UsageDashboard.module.css';

type RangeKey = 'today' | 'week' | 'month' | 'all';

const DAY_MS = 24 * 60 * 60 * 1000;

function sinceMsForRange(range: RangeKey): number | undefined {
  const now = Date.now();
  switch (range) {
    case 'today': {
      // Start-of-day UTC.
      return now - (now % DAY_MS);
    }
    case 'week':
      return now - 7 * DAY_MS;
    case 'month':
      return now - 30 * DAY_MS;
    case 'all':
      return 0;
    default:
      return undefined;
  }
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

/** Fill in any gaps so the chart renders ~30 contiguous bars. */
function densify(days: ChartDay[], rangeDays: number): ChartDay[] {
  if (rangeDays <= 0 || rangeDays > 90) {
    // "All time" — just sort & return as is.
    return [...days].sort((a, b) => a.date.localeCompare(b.date));
  }
  const today = new Date();
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const out: ChartDay[] = [];
  const map = new Map<string, ChartDay>();
  for (const d of days) map.set(d.date, d);
  for (let i = rangeDays - 1; i >= 0; i -= 1) {
    const iso = new Date(todayUtc - i * DAY_MS).toISOString().slice(0, 10);
    const hit = map.get(iso);
    if (hit !== undefined) {
      out.push(hit);
    } else {
      out.push({ date: iso, tokensIn: 0, tokensOut: 0 });
    }
  }
  return out;
}

export function UsageDashboard(): JSX.Element {
  const t = useT();
  const clients = useApiClients();
  const closeUsageDashboard = useStore((s) => s.closeUsageDashboard);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const activeProjectId = useStore((s) => s.activeProjectId);

  const [range, setRange] = useState<RangeKey>('month');
  const [data, setData] = useState<GetUsageResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch on open + on range change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const req: { projectId?: string; sinceMs?: number } = {};
    if (activeProjectId !== null) req.projectId = activeProjectId;
    const since = sinceMsForRange(range);
    if (since !== undefined) req.sinceMs = since;
    void clients.rest
      .getUsage(req)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(t('usageDashboard.failed', { message }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clients, range, activeProjectId, t]);

  const handlePickSession = useCallback(
    (sid: string) => {
      setActiveSession(sid);
      closeUsageDashboard();
    },
    [setActiveSession, closeUsageDashboard],
  );

  const chartDays = useMemo<ChartDay[]>(() => {
    if (data === null) return [];
    const rangeDays =
      range === 'today' ? 1 : range === 'week' ? 7 : range === 'month' ? 30 : 90;
    return densify(
      data.perDay.map((d) => ({
        date: d.date,
        tokensIn: d.tokensIn,
        tokensOut: d.tokensOut,
      })),
      rangeDays,
    );
  }, [data, range]);

  const rangeOptions: { key: RangeKey; label: string }[] = [
    { key: 'today', label: t('usageDashboard.range.today') },
    { key: 'week', label: t('usageDashboard.range.week') },
    { key: 'month', label: t('usageDashboard.range.month') },
    { key: 'all', label: t('usageDashboard.range.all') },
  ];

  const isEmpty =
    data !== null &&
    !loading &&
    data.turnCount === 0 &&
    data.sessionCount === 0;

  return (
    <Modal
      open={true}
      onClose={closeUsageDashboard}
      title={t('usageDashboard.title')}
      subtitle={t('usageDashboard.subtitle')}
      icon={<BarChart3 size={18} strokeWidth={1.6} />}
      size="xl"
    >
      <ModalBody>
        <div className={styles.toolbar}>
          <div
            className={styles.rangeGroup}
            role="tablist"
            aria-label={t('usageDashboard.title')}
          >
            {rangeOptions.map((opt) => (
              <button
                key={opt.key}
                type="button"
                role="tab"
                aria-selected={range === opt.key}
                className={`${styles.rangeBtn} ${
                  range === opt.key ? styles.rangeBtnActive ?? '' : ''
                }`}
                onClick={() => setRange(opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {error !== null ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}

        {isEmpty ? (
          <div className={styles.emptyState}>
            <BarChart3 size={32} strokeWidth={1.4} aria-hidden="true" />
            <h3>{t('usageDashboard.empty')}</h3>
            <p>{t('usageDashboard.empty.desc')}</p>
          </div>
        ) : (
          <>
            <div className={styles.statRow}>
              <UsageStatCard
                icon={<BarChart3 size={14} strokeWidth={1.5} />}
                label={t('usageDashboard.stat.tokens')}
                value={
                  data === null
                    ? '—'
                    : formatNumber(data.totalTokensIn + data.totalTokensOut)
                }
                sublabel={
                  data === null
                    ? undefined
                    : `${formatNumber(data.totalTokensIn)} ${t(
                        'usageDashboard.chart.in',
                      )} · ${formatNumber(data.totalTokensOut)} ${t(
                        'usageDashboard.chart.out',
                      )}`
                }
              />
              <UsageStatCard
                icon={<DollarSign size={14} strokeWidth={1.5} />}
                label={t('usageDashboard.stat.cost')}
                value={data === null ? '—' : formatCost(data.totalCostUsd)}
                sublabel={t('usageDashboard.costEstimate')}
                tone="accent"
              />
              <UsageStatCard
                icon={<MessageSquare size={14} strokeWidth={1.5} />}
                label={t('usageDashboard.stat.sessions')}
                value={
                  data === null ? '—' : data.sessionCount.toLocaleString()
                }
              />
              <UsageStatCard
                icon={<Clock size={14} strokeWidth={1.5} />}
                label={t('usageDashboard.stat.turns')}
                value={data === null ? '—' : data.turnCount.toLocaleString()}
              />
            </div>

            <section className={styles.section}>
              <header className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>
                  {t('usageDashboard.chart.title')}
                </h3>
              </header>
              <UsageChart days={chartDays} />
            </section>

            <section className={styles.section}>
              <header className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>
                  {t('usageDashboard.perModel.title')}
                </h3>
              </header>
              {data === null || data.perModel.length === 0 ? (
                <div className={styles.empty}>
                  {t('usageDashboard.perModel.empty')}
                </div>
              ) : (
                <PerModelTable rows={data.perModel} />
              )}
            </section>

            <section className={styles.section}>
              <header className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>
                  {t('usageDashboard.topSessions.title')}
                </h3>
              </header>
              {data === null || data.topSessions.length === 0 ? (
                <div className={styles.empty}>
                  {t('usageDashboard.perModel.empty')}
                </div>
              ) : (
                <TopSessionsTable
                  rows={data.topSessions}
                  onPick={handlePickSession}
                />
              )}
            </section>
          </>
        )}
      </ModalBody>
    </Modal>
  );
}

interface PerModelTableProps {
  rows: UsagePerModelWire[];
}

function PerModelTable({ rows }: PerModelTableProps): JSX.Element {
  const t = useT();
  // Already sorted by cost desc server-side. Re-sort defensively.
  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.cost - a.cost),
    [rows],
  );
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t('usageDashboard.perModel.model')}</th>
            <th className={styles.colNum}>
              {t('usageDashboard.perModel.turns')}
            </th>
            <th className={styles.colNum}>
              {t('usageDashboard.perModel.in')}
            </th>
            <th className={styles.colNum}>
              {t('usageDashboard.perModel.out')}
            </th>
            <th className={styles.colNum}>
              {t('usageDashboard.perModel.cost')}
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.model}>
              <td className={styles.model}>{row.model}</td>
              <td className={styles.colNum}>{row.turns.toLocaleString()}</td>
              <td className={styles.colNum}>{formatNumber(row.tokensIn)}</td>
              <td className={styles.colNum}>{formatNumber(row.tokensOut)}</td>
              <td className={styles.colNum}>
                {row.cost > 0
                  ? formatCost(row.cost)
                  : t('usageDashboard.costUnknown')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface TopSessionsTableProps {
  rows: UsageTopSessionWire[];
  onPick: (sessionId: string) => void;
}

function TopSessionsTable({
  rows,
  onPick,
}: TopSessionsTableProps): JSX.Element {
  const t = useT();
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t('usageDashboard.topSessions.session')}</th>
            <th className={styles.colNum}>
              {t('usageDashboard.topSessions.tokens')}
            </th>
            <th className={styles.colNum}>
              {t('usageDashboard.topSessions.cost')}
            </th>
            <th className={styles.colNum}>
              {t('usageDashboard.topSessions.lastUsed')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sessionId}>
              <td>
                <button
                  type="button"
                  className={styles.sessionBtn}
                  onClick={() => onPick(row.sessionId)}
                  title={row.sessionId}
                >
                  {row.title !== null && row.title.length > 0
                    ? row.title
                    : t('usageDashboard.topSessions.untitled')}
                </button>
              </td>
              <td className={styles.colNum}>{formatNumber(row.tokens)}</td>
              <td className={styles.colNum}>
                {row.cost > 0
                  ? formatCost(row.cost)
                  : t('usageDashboard.costUnknown')}
              </td>
              <td className={styles.colNum}>
                {formatTimestamp(row.lastUsedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
