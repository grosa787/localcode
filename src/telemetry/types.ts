/**
 * Telemetry surface types — shared between the aggregator, overlay, and
 * `/metrics` slash command.
 *
 * Everything here is purely structural: no behaviour, no runtime
 * imports beyond what is required for the shape declarations. Lives in
 * its own file so the overlay (UI) and the aggregator (data) can both
 * depend on a single contract without pulling in heavy DB / journal
 * dependencies.
 */

// ---------- Snapshot atoms ----------

/**
 * Per-tool success / failure counters and the derived success rate.
 * Sourced from journal `tool_call_done` events; aggregated across the
 * retention window.
 */
export interface ToolStatRow {
  /** Tool name, e.g. `read_file`. */
  readonly toolName: string;
  /** Successful invocations counted in the window. */
  readonly success: number;
  /** Failed invocations counted in the window. */
  readonly failure: number;
  /** `success / (success + failure)`. `0` when both counters are 0. */
  readonly rate: number;
}

/**
 * Per-(provider, model) cost rollup. Sourced from `messages.cost_usd`
 * via SQL aggregation joined against the owning session's `backend`.
 */
export interface CostByModelRow {
  /** Provider label sourced from `sessions.backend`. */
  readonly provider: string;
  /** Model id sourced from `messages.model`. */
  readonly model: string;
  /** Sum of `messages.cost_usd` across the window. */
  readonly totalUsd: number;
  /** Number of assistant rows credited to this (provider, model). */
  readonly turns: number;
}

/**
 * Most expensive sessions in the retention window. Cost is summed over
 * the session's messages; title falls back to "(untitled)" when the
 * session row has no title set.
 */
export interface ExpensiveSessionRow {
  /** Session UUID. */
  readonly sessionId: string;
  /** Human-readable title or `'(untitled)'`. */
  readonly title: string;
  /** Sum of `messages.cost_usd` for this session within the window. */
  readonly costUsd: number;
}

/**
 * Single read-only metrics snapshot. All numbers are sums over a
 * retention window bounded by `windowStart` ▸ `windowEnd` (inclusive
 * floor, exclusive ceiling). The "telemetry disabled" surface uses
 * empty arrays and zero counters; `sessionsCounted === 0` is the
 * canonical signal that no data was scanned.
 */
export interface MetricsSnapshot {
  /** Per-tool success rate breakdown, sorted by call volume desc. */
  readonly toolSuccessRate: readonly ToolStatRow[];
  /**
   * Overall cache-hit percent (0..100) across the window. Computed as
   * `cached / (cached + fresh)`. `0` when no cached/fresh data exists.
   *
   * Note: the spec calls this "last 7 days"; the implementation uses
   * `min(7, retentionDays)` so a user with a shorter retention bound
   * still gets a sensible value.
   */
  readonly cacheHitPercent: number;
  /**
   * Mean per-turn duration in milliseconds across assistant rows in
   * the window. `0` when no rows carry duration telemetry.
   */
  readonly avgTurnDurationMs: number;
  /** Per-(provider, model) cost rollup, sorted by totalUsd desc. */
  readonly costByModel: readonly CostByModelRow[];
  /**
   * Top expensive sessions in the window. Capped at 10 by default;
   * controllable via {@link SnapshotOptions.topSessionsLimit}.
   */
  readonly topExpensiveSessions: readonly ExpensiveSessionRow[];
  /**
   * Number of distinct sessions that contributed at least one row to
   * the aggregation. Zero when telemetry is disabled OR no data exists.
   */
  readonly sessionsCounted: number;
  /** Inclusive floor of the window (ms epoch). */
  readonly windowStart: number;
  /** Exclusive ceiling of the window (ms epoch). */
  readonly windowEnd: number;
  /**
   * `true` when `telemetry.enabled === false`. Aggregator short-
   * circuits in that case and returns an otherwise-empty snapshot so
   * the overlay can render a "disabled — opt in via config" hint
   * without needing to know the config layer.
   */
  readonly disabled: boolean;
}

// ---------- Aggregator options ----------

/**
 * Optional overrides for {@link snapshot}. Production callers pass
 * nothing and let the aggregator read `config.telemetry`. Tests inject
 * the windows + journal directory explicitly.
 */
export interface SnapshotOptions {
  /**
   * Window size in days. Bounded to `[1, 365]`. When omitted the
   * aggregator reads `config.telemetry.retentionDays`; falling back to
   * `30` if neither is available.
   */
  readonly windowDays?: number;
  /**
   * Reference "now" for window arithmetic. Defaults to `Date.now()`.
   * Tests inject a fixed value so journal age comparisons are stable.
   */
  readonly nowMs?: number;
  /**
   * Override the journal directory. Defaults to `~/.localcode/journal`
   * (matches `DEFAULT_JOURNAL_DIR` in `@/sessions/journal`). Tests
   * point this at a tmp dir.
   */
  readonly journalDir?: string;
  /**
   * Override the archive directory scanned for old journals. Defaults
   * to `<journalDir>/archive` (matches `DEFAULT_ARCHIVE_DIR`).
   */
  readonly archiveDir?: string;
  /**
   * Whether telemetry is enabled. Override for tests / headless paths.
   * When omitted, the aggregator inspects `config.telemetry.enabled`.
   * When `false` the aggregator never reads any data source.
   */
  readonly enabled?: boolean;
  /**
   * Cap on the `topExpensiveSessions` array. Default 10. Range 1..100.
   */
  readonly topSessionsLimit?: number;
}
