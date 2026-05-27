/**
 * Metrics aggregator — opt-in, local-only.
 *
 * Reads from two on-disk data sources that already exist for other
 * reasons (NEVER initiates network egress, NEVER writes anywhere
 * outside the user's `~/.localcode/` tree):
 *
 *   1. `messages` table via the read-only SQLite replica
 *      (`getReadDb()`). Provides cost, duration, cache-hit, and
 *      per-(model, provider) rollups via a single covering scan.
 *   2. Per-session crash journals under `~/.localcode/journal/` +
 *      `~/.localcode/journal/archive/` (see `@/sessions/journal`).
 *      Provides tool-call success/failure counters via
 *      `tool_call_done` events.
 *
 * The aggregator runs lazily — `snapshot()` performs both scans on
 * every call, returning a single immutable snapshot. There is no
 * background timer, no daemon, no IPC. The dominant cost is the
 * journal scan, which is bounded by the retention window: events
 * older than `windowStart` are skipped without parsing.
 *
 * **Privacy guarantee (re-read before changing anything in this file):**
 * if `telemetry.enabled === false` (the default), `snapshot` returns
 * an empty `{ disabled: true }` snapshot without touching SQLite or
 * the journal directory. The overlay surfaces a hint pointing at the
 * config flag in that case. No data ever leaves this process.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  DEFAULT_ARCHIVE_DIR,
  DEFAULT_JOURNAL_DIR,
  readJournalEvents,
  type JournalEvent,
} from '@/sessions/journal';
import { getReadDb } from '@/sessions/db';

import type {
  CostByModelRow,
  ExpensiveSessionRow,
  MetricsSnapshot,
  SnapshotOptions,
  ToolStatRow,
} from './types';

export type {
  CostByModelRow,
  ExpensiveSessionRow,
  MetricsSnapshot,
  SnapshotOptions,
  ToolStatRow,
};

// ---------- Defaults ----------

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_TOP_SESSIONS = 10;
/** Cache-hit % uses a tighter window for "recency" — bounded by retention. */
const CACHE_HIT_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------- Public API ----------

/**
 * Produce a single metrics snapshot. Resolves synchronously inside the
 * Promise so callers can treat the API as async (matches the rest of
 * the slash-command surface) while keeping the implementation cheap.
 *
 * Honours the opt-in gate: when `telemetry.enabled === false`,
 * returns a `{ disabled: true }` snapshot without scanning anything.
 *
 * @param opts override aggregator inputs (tests inject `journalDir`,
 *   `enabled`, `nowMs`, etc.). Production calls pass `{}` and let the
 *   aggregator pull defaults from the config layer.
 */
export async function snapshot(
  opts: SnapshotOptions = {},
): Promise<MetricsSnapshot> {
  const nowMs = opts.nowMs ?? Date.now();
  const windowDays = clampDays(opts.windowDays ?? DEFAULT_WINDOW_DAYS);
  const windowStart = nowMs - windowDays * MS_PER_DAY;
  const windowEnd = nowMs;
  const enabled = opts.enabled ?? false;

  if (!enabled) {
    return makeDisabledSnapshot(windowStart, windowEnd);
  }

  const journalDir = opts.journalDir ?? DEFAULT_JOURNAL_DIR;
  const archiveDir = opts.archiveDir ?? deriveArchiveDir(journalDir);
  const topLimit = clampTopLimit(opts.topSessionsLimit ?? DEFAULT_TOP_SESSIONS);
  const cacheHitWindowDays = Math.min(windowDays, CACHE_HIT_WINDOW_DAYS);
  const cacheHitWindowStart = nowMs - cacheHitWindowDays * MS_PER_DAY;

  // ---- SQL aggregates (single pass over messages) ----
  const sqlAggregate = aggregateFromSqlite({
    windowStart,
    cacheHitWindowStart,
    topLimit,
  });

  // ---- Journal scan for tool success/failure ----
  const toolStats = scanJournalsForToolStats({
    activeDir: journalDir,
    archiveDir,
    windowStart,
  });

  return {
    toolSuccessRate: toolStats,
    cacheHitPercent: sqlAggregate.cacheHitPercent,
    avgTurnDurationMs: sqlAggregate.avgTurnDurationMs,
    costByModel: sqlAggregate.costByModel,
    topExpensiveSessions: sqlAggregate.topExpensiveSessions,
    sessionsCounted: sqlAggregate.sessionsCounted,
    windowStart,
    windowEnd,
    disabled: false,
  };
}

// ---------- Internals: SQL ----------

interface SqlAggregateResult {
  readonly cacheHitPercent: number;
  readonly avgTurnDurationMs: number;
  readonly costByModel: readonly CostByModelRow[];
  readonly topExpensiveSessions: readonly ExpensiveSessionRow[];
  readonly sessionsCounted: number;
}

interface AggregateRow {
  session_id: string;
  title: string | null;
  backend: string | null;
  model: string | null;
  cost_usd: number | null;
  cached_input_tokens: number | null;
  tokens_input: number | null;
  duration_ms: number | null;
  created_at: number;
}

/**
 * Single covering scan over the messages table joined onto sessions.
 *
 * Query plan:
 *   1. Filter `messages.created_at >= windowStart` — index seek via
 *      the existing `idx_messages_session_created_id` covering index
 *      (per-session, but SQLite still uses it for the range predicate
 *      when no session filter applies because the index includes
 *      `created_at`).
 *   2. JOIN onto `sessions` to surface `backend` + `title` per row.
 *   3. Aggregate in TS — three pass-through Maps (per-(provider,model)
 *      cost, per-session cost, cache-hit accumulator) keep memory
 *      bounded by the number of distinct (model × session) tuples.
 *
 * Returns synchronously — the DB call is sync via `bun:sqlite`.
 * Errors are propagated up so the caller can surface "telemetry
 * scan failed: …" instead of silently returning a stale snapshot.
 */
function aggregateFromSqlite(args: {
  readonly windowStart: number;
  readonly cacheHitWindowStart: number;
  readonly topLimit: number;
}): SqlAggregateResult {
  const db = getReadDb();
  const stmt = db.prepare(
    `SELECT m.session_id     AS session_id,
            s.title          AS title,
            s.backend        AS backend,
            m.model          AS model,
            m.cost_usd       AS cost_usd,
            m.cached_input_tokens AS cached_input_tokens,
            m.tokens_input   AS tokens_input,
            m.duration_ms    AS duration_ms,
            m.created_at     AS created_at
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
      WHERE m.created_at >= $windowStart
        AND m.role = 'assistant'`,
  );
  const rows = stmt.all({ $windowStart: args.windowStart }) as AggregateRow[];

  const perKey = new Map<
    string,
    { provider: string; model: string; totalUsd: number; turns: number }
  >();
  const perSession = new Map<
    string,
    { title: string; costUsd: number }
  >();
  const sessions = new Set<string>();

  let durationSum = 0;
  let durationCount = 0;
  let cachedSum = 0;
  let freshSum = 0;

  for (const row of rows) {
    // Sub-agent sessions never appear in user-facing analytics.
    if (row.session_id.includes('.agent.')) continue;

    sessions.add(row.session_id);

    // Duration accumulator — only counts rows with telemetry.
    if (row.duration_ms !== null && row.duration_ms > 0) {
      durationSum += row.duration_ms;
      durationCount += 1;
    }

    // Cache-hit accumulator — only the tighter 7d window.
    if (row.created_at >= args.cacheHitWindowStart) {
      const cached = row.cached_input_tokens ?? 0;
      const total = row.tokens_input ?? 0;
      if (total > 0) {
        const fresh = Math.max(0, total - cached);
        cachedSum += cached;
        freshSum += fresh;
      }
    }

    // Cost aggregation. Skip rows without a cost — local providers
    // never populate it.
    const cost = row.cost_usd;
    if (cost === null || cost <= 0) continue;

    const provider = (row.backend ?? 'unknown').trim() || 'unknown';
    const model = (row.model ?? 'unknown').trim() || 'unknown';
    const key = `${provider}__${model}`;
    const existing = perKey.get(key);
    if (existing === undefined) {
      perKey.set(key, { provider, model, totalUsd: cost, turns: 1 });
    } else {
      existing.totalUsd += cost;
      existing.turns += 1;
    }

    const sessionEntry = perSession.get(row.session_id);
    const title = row.title !== null && row.title.length > 0
      ? row.title
      : '(untitled)';
    if (sessionEntry === undefined) {
      perSession.set(row.session_id, { title, costUsd: cost });
    } else {
      sessionEntry.costUsd += cost;
      if (sessionEntry.title === '(untitled)' && title !== '(untitled)') {
        // Late-discovered title wins (rare — title is set on first
        // user message and usually arrives well before assistant rows).
        perSession.set(row.session_id, {
          title,
          costUsd: sessionEntry.costUsd,
        });
      }
    }
  }

  const costByModel: CostByModelRow[] = Array.from(perKey.values()).sort(
    (a, b) =>
      b.totalUsd - a.totalUsd ||
      b.turns - a.turns ||
      (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
      (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
  );

  const topExpensiveSessions: ExpensiveSessionRow[] = Array.from(
    perSession.entries(),
  )
    .map(([sessionId, v]) => ({
      sessionId,
      title: v.title,
      costUsd: v.costUsd,
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, args.topLimit);

  const cacheTotal = cachedSum + freshSum;
  const cacheHitPercent =
    cacheTotal > 0 ? (cachedSum / cacheTotal) * 100 : 0;

  const avgTurnDurationMs =
    durationCount > 0 ? durationSum / durationCount : 0;

  return {
    cacheHitPercent,
    avgTurnDurationMs,
    costByModel,
    topExpensiveSessions,
    sessionsCounted: sessions.size,
  };
}

// ---------- Internals: journal ----------

/**
 * Scan active + archived journals for `tool_call_done` events inside
 * the retention window. Per-tool counters bucket by `data.toolName`;
 * success is inferred from `data.success === true` (the default
 * journal contract).
 *
 * Best-effort: missing directories, unreadable files, and malformed
 * lines are silently skipped. The journal writer already tolerates
 * partial tail writes, so a JSONL line that fails to parse is a
 * fact-of-life on crash recovery and must not cause the snapshot to
 * throw.
 */
function scanJournalsForToolStats(args: {
  readonly activeDir: string;
  readonly archiveDir: string;
  readonly windowStart: number;
}): ToolStatRow[] {
  const counters = new Map<string, { success: number; failure: number }>();

  collectFromDir(args.activeDir, args.windowStart, counters);
  collectFromDir(args.archiveDir, args.windowStart, counters);

  const rows: ToolStatRow[] = Array.from(counters.entries()).map(
    ([toolName, c]) => {
      const total = c.success + c.failure;
      const rate = total > 0 ? c.success / total : 0;
      return {
        toolName,
        success: c.success,
        failure: c.failure,
        rate,
      };
    },
  );
  rows.sort((a, b) => {
    const totalA = a.success + a.failure;
    const totalB = b.success + b.failure;
    if (totalA !== totalB) return totalB - totalA;
    return a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0;
  });
  return rows;
}

function collectFromDir(
  dir: string,
  windowStart: number,
  counters: Map<string, { success: number; failure: number }>,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // Directory doesn't exist → no journals to scan; nothing to do.
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const filepath = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filepath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    // Skip files entirely outside the window. mtime is a good proxy
    // for the most recent event; older files have nothing to contribute.
    if (stat.mtimeMs < windowStart) continue;
    let events: JournalEvent[];
    try {
      events = readJournalEvents(filepath);
    } catch {
      continue;
    }
    for (const ev of events) {
      if (ev.ts < windowStart) continue;
      if (ev.type !== 'tool_call_done') continue;
      const parsed = parseToolDoneEvent(ev);
      if (parsed === null) continue;
      const existing = counters.get(parsed.toolName);
      if (existing === undefined) {
        counters.set(parsed.toolName, {
          success: parsed.success ? 1 : 0,
          failure: parsed.success ? 0 : 1,
        });
      } else if (parsed.success) {
        existing.success += 1;
      } else {
        existing.failure += 1;
      }
    }
  }
}

/**
 * Narrow `JournalEvent.data` into `{ toolName, success }`. Returns
 * `null` for events that don't carry a usable tool name. Permissive:
 * any non-string `success` is treated as failure (matches the journal
 * contract where omitted = unknown = treated conservatively).
 */
function parseToolDoneEvent(
  ev: JournalEvent,
): { readonly toolName: string; readonly success: boolean } | null {
  const data = ev.data;
  if (data === null || typeof data !== 'object') return null;
  const rec = data as Record<string, unknown>;
  const nameRaw = rec['toolName'] ?? rec['name'] ?? rec['tool'];
  if (typeof nameRaw !== 'string' || nameRaw.length === 0) return null;
  const successRaw = rec['success'];
  const success = typeof successRaw === 'boolean' ? successRaw : false;
  return { toolName: nameRaw, success };
}

// ---------- Helpers ----------

function makeDisabledSnapshot(
  windowStart: number,
  windowEnd: number,
): MetricsSnapshot {
  return {
    toolSuccessRate: [],
    cacheHitPercent: 0,
    avgTurnDurationMs: 0,
    costByModel: [],
    topExpensiveSessions: [],
    sessionsCounted: 0,
    windowStart,
    windowEnd,
    disabled: true,
  };
}

function clampDays(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_WINDOW_DAYS;
  return Math.min(365, Math.max(1, Math.floor(value)));
}

function clampTopLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TOP_SESSIONS;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function deriveArchiveDir(journalDir: string): string {
  if (journalDir === DEFAULT_JOURNAL_DIR) return DEFAULT_ARCHIVE_DIR;
  return path.join(journalDir, 'archive');
}
