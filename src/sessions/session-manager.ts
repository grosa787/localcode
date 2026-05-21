/**
 * SessionManager — CRUD over the SQLite-backed session store.
 *
 * Persists `Session` and `Message` rows. Accepts an optional SQLite
 * handle in the constructor so tests can inject `:memory:` databases.
 *
 * Statement preparation is done once in the constructor and reused for
 * every call — avoids repeated SQL parsing overhead.
 */

import type { Database as SqliteDatabase, Statement } from 'bun:sqlite';
import { z } from 'zod';
import type { Backend, Message, Session, ToolCall } from '@/types/global';
import { computeCost } from '@/llm/pricing';
// COST-PERSIST-SECTION — backend-aware pricing path. The legacy
// `computeCost` (static table only) is retained for back-compat with the
// SPA's `/api/usage` aggregate so its numbers stay byte-stable; the
// per-row persist path below uses `resolvePrice` + `computeCostBreakdown`
// so OpenRouter-routed models bill correctly.
import { resolvePrice } from '@/llm/pricing/resolver';
import { computeCostBreakdown } from '@/llm/pricing/cost-calculator';
// COST-PERSIST-SECTION-END
import { getDb, getReadDb, SessionDbError } from './db';

// ---------- Todos ----------

/**
 * A single task tracked by the todo_write tool. Mirrors the tool's
 * argument shape exactly so the handler can store and reload without
 * any transformation.
 */
export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

/** Zod schema for a single Todo — used to validate rows read from SQLite. */
const TodoSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string(),
});

/** Zod schema for the stored JSON array of Todos. */
const TodosArraySchema = z.array(TodoSchema);

// ---------- Errors ----------

// (`SessionDbError` is re-exported from `./db` — use that for consistency.)
export { SessionDbError } from './db';

// ---------- Row shapes (raw DB types) ----------

interface SessionRow {
  id: string;
  created_at: number;
  updated_at: number;
  project_root: string;
  title: string | null;
  model: string;
  backend: string;
  summary: string | null;
  session_todos: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_name: string | null;
  tool_args: string | null;
  created_at: number;
  tokens_input: number | null;
  tokens_output: number | null;
  duration_ms: number | null;
  model: string | null;
  // COST-PERSIST-SECTION
  cost_usd: number | null;
  cached_input_tokens: number | null;
  cache_creation_tokens: number | null;
  // COST-PERSIST-SECTION-END
}

// Shape returned by the SUM(...) aggregate query for per-session stats.
interface MessageStatsRow {
  total_tokens_input: number | null;
  total_tokens_output: number | null;
  total_duration_ms: number | null;
  message_count: number | null;
}

// ---------- Public types ----------

/**
 * Optional usage / timing telemetry attached to a stored message. All
 * three fields are optional so call sites that have no numbers to
 * report (e.g. the user's own messages, tool results, legacy code)
 * can keep calling `addMessage` with the original two-arg signature.
 */
export interface AddMessageOptions {
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
  /**
   * Name of the model that generated this message. Persisted alongside
   * the message so the UI can label each assistant row with the model
   * that actually produced it (rather than the currently-active model).
   */
  model?: string;
  // COST-PERSIST-SECTION
  /**
   * Backend the model was routed through. Used by `resolvePrice` to
   * pick the OpenRouter map vs the static table. Optional — when
   * absent the resolver falls back to the session row's backend (read
   * via a sub-query inside addMessage), then to static lookup only.
   */
  backend?: Backend | string;
  /** Prompt tokens served from the provider's prefix cache. */
  cachedInputTokens?: number;
  /** Anthropic-only: tokens written into the cache this turn. */
  cacheCreationTokens?: number;
  // COST-PERSIST-SECTION-END
}

// LAN-SYNC-SECTION (interface)
/**
 * Optional sink the SessionManager calls AFTER a successful
 * `addMessage` transaction commits. Used by the LAN session-sharing
 * coordinator to fan freshly-persisted rows out to paired peers.
 *
 * Errors thrown from `onLocalMessage` are swallowed by the
 * SessionManager so a broken bridge can never disrupt the local
 * persistence path.
 */
export interface LanSyncBridge {
  onLocalMessage(sessionId: string, message: Message): void;
}
// LAN-SYNC-SECTION (interface end)

/**
 * Aggregated per-session statistics. Unknown or absent counts resolve
 * to 0 so the caller never has to null-check.
 */
export interface SessionStats {
  totalTokensInput: number;
  totalTokensOutput: number;
  totalDurationMs: number;
  messageCount: number;
}

/**
 * Per-model breakdown — one row per distinct model id that contributed
 * at least one assistant message in the queried window.
 */
export interface UsagePerModel {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  turns: number;
}

/**
 * Per-day rollup — one entry per UTC day in the queried window. Days
 * with zero activity are omitted (the chart fills the gap visually).
 */
export interface UsagePerDay {
  /** ISO yyyy-mm-dd in UTC. */
  date: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

/**
 * Per-session top entry — used by the "Top sessions" table on the
 * usage dashboard. Sorted by `cost` desc client-side / server-side.
 */
export interface UsageTopSession {
  sessionId: string;
  title: string | null;
  tokens: number;
  cost: number;
  lastUsedAt: number;
}

/**
 * Aggregated usage statistics across many sessions. Powers the
 * dashboard's stat cards, charts, and tables. Pure SQL aggregation
 * with the per-row cost computed in TS via the pricing table.
 */
export interface UsageStats {
  totalTokensIn: number;
  totalTokensOut: number;
  /** Sum of any cached-token equivalents we can recover from telemetry. 0 for now. */
  totalCachedTokens: number;
  totalDurationMs: number;
  totalCostUsd: number;
  sessionCount: number;
  /** Number of assistant turns (messages with token data) in the window. */
  turnCount: number;
  perModel: UsagePerModel[];
  perDay: UsagePerDay[];
  topSessions: UsageTopSession[];
}

/**
 * Filter options for `getUsageStats`. All fields are optional — omitting
 * the filter yields the whole-database view.
 *
 * - `projectId` — the workspace UUID; resolved at the caller (the REST
 *   handler) into a `projectRoot` path. We accept the absolute path
 *   directly here so the manager stays decoupled from the registry.
 * - `sinceMs` — epoch millis floor; messages older than this are excluded.
 * - `modelFilter` — case-insensitive substring match on the per-message
 *   `model` column. Powers the dashboard's per-model drill-down.
 */
export interface GetUsageStatsOptions {
  /** Absolute filesystem path. The REST handler resolves projectId → root. */
  projectRoot?: string;
  /** Epoch ms floor — default: 30 days ago. */
  sinceMs?: number;
  /** Case-insensitive substring filter on `model`. */
  modelFilter?: string;
  /** Cap for `topSessions` — default 10. */
  topSessionsLimit?: number;
}

/**
 * ROADMAP #4 — options for the lazy-paginated `getMessages` API.
 *
 * - `limit`: max messages to return. Defaults to 100 when omitted —
 *   long sessions no longer pay for a full table scan on every
 *   `/resume`. Pass `Infinity` (or use `getAllMessages`) when callers
 *   genuinely need every row.
 * - `before`: id of a known message; results are restricted to
 *   messages strictly older than that anchor (by created_at, with id
 *   as a tiebreaker). Powers "scroll up to load older" UX. When the
 *   anchor id is unknown the call returns the most recent `limit`
 *   messages, identical to omitting the option.
 */
export interface GetMessagesOptions {
  limit?: number;
  before?: string;
}

/**
 * Options for the cross-session message search API (FTS5-backed).
 *
 * - `projectRoot`: restrict results to sessions whose `project_root`
 *   matches the given absolute path. Sub-agent sessions (id contains
 *   `.agent.`) are always excluded — they're surfaced via the agent
 *   panel, not the main chat search.
 * - `limit` / `offset`: paginate by FTS rank. Defaults to 20 / 0.
 */
export interface SearchMessagesOptions {
  projectRoot?: string;
  limit?: number;
  offset?: number;
}

/**
 * One search hit returned by `searchMessages`. Carries enough metadata
 * for the SPA's overlay to navigate to the source session without an
 * extra round-trip:
 *
 * - `snippet`: FTS5 `snippet()` output with `<mark>…</mark>` tags
 *   around matched tokens, ellipsised to ~32 tokens for compactness.
 * - `rank`: FTS5 BM25 rank (smaller = better — SQLite returns
 *   negative numbers; closer to 0 is a stronger match).
 * - `sessionTitle` / `projectRoot`: pulled by JOIN onto `sessions` so
 *   the overlay can label rows with their owning chat at no extra
 *   query cost.
 */
export interface SearchMessageResult {
  sessionId: string;
  messageId: string;
  role: string;
  snippet: string;
  rank: number;
  createdAt: number;
  sessionTitle: string | null;
  projectRoot: string;
}

// BRANCHES-TYPES-SECTION (start) — see BRANCHES-SECTION in the class.
/**
 * Per-branch metadata returned by `getBranches` / `getBranchChain`.
 *
 * - `id`            — session id of this branch (or root).
 * - `branchName`    — user-chosen label; null for the root session that
 *                     pre-dates branching (no parent, no name).
 * - `title`         — copied through from the session row so the
 *                     picker / breadcrumb can label a branch even when
 *                     the user has not given it an explicit name.
 * - `parentSessionId` — null for the root, otherwise the id of the
 *                     session this row was forked from.
 * - `divergedAt`    — id of the last message common with the parent.
 *                     null when the parent had no messages at fork
 *                     time (rare — UI just shows "fork point: none").
 * - `messageCount`  — current size of the branch's message list.
 *                     Useful for the picker's right-margin annotation.
 * - `branchArchived` — true when the branch has been soft-deleted via
 *                     `/branch delete`. Both UI surfaces still render
 *                     archived rows; the breadcrumb hides them.
 */
export interface BranchInfo {
  readonly id: string;
  readonly branchName: string | null;
  readonly title: string | null;
  readonly parentSessionId: string | null;
  readonly divergedAt: string | null;
  readonly messageCount: number;
  readonly branchArchived: boolean;
}

/**
 * Recursive tree node used by `getBranchTree`. The same shape as
 * `BranchInfo` plus the children array. Used by the picker overlay to
 * render an indented list.
 */
export interface BranchTreeNode {
  readonly id: string;
  readonly branchName: string | null;
  readonly title: string | null;
  readonly divergedAt: string | null;
  readonly branchArchived: boolean;
  readonly messageCount: number;
  readonly children: readonly BranchTreeNode[];
}
// BRANCHES-TYPES-SECTION (end)

/** Raw row shape returned by the FTS JOIN query. */
interface SearchMessageRow {
  session_id: string;
  message_id: string;
  role: string;
  snippet: string;
  rank: number;
  created_at: number;
  session_title: string | null;
  project_root: string;
}

/** Default + max search page sizes — mirrors REST clamp. */
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;

// Shape returned by the COUNT(*) query on messages-by-session.
interface MessageCountRow {
  cnt: number | null;
}

// Shape returned by the COUNT(*) query for search totals.
interface SearchCountRow {
  cnt: number | null;
}

/** Default page size for `getMessages` when `limit` is omitted. */
const DEFAULT_PAGE_SIZE = 100;

/**
 * Identify a synthetic sub-agent session id.
 *
 * The orchestrator mints child session ids of the form
 * `<parentSessionId>.agent.<agentId>` (see
 * `src/agents/orchestrator.ts`). The runner-factory persists a row
 * under that exact id so worker history is queryable post-mortem,
 * but those rows must NOT appear in the user-facing sidebar — they
 * are surfaced via `agent_*` WS frames in AgentTeamPanel instead.
 *
 * Predicate is `.includes('.agent.')` rather than a position-anchored
 * check so nested sub-agents (id contains multiple `.agent.` segments,
 * should that ever happen) are also caught.
 */
export function isSubAgentSessionId(sessionId: string): boolean {
  return sessionId.includes('.agent.');
}

/**
 * Coerce an arbitrary `limit` value to a positive integer. We accept
 * `Infinity` and `Number.MAX_SAFE_INTEGER` as "no cap" and translate
 * them into a value SQLite is happy to bind (-1 → unlimited per
 * SQLite's documented LIMIT semantics).
 */
function normaliseLimit(rawLimit: number | undefined): number {
  if (rawLimit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(rawLimit)) return -1;
  if (rawLimit <= 0) return DEFAULT_PAGE_SIZE;
  return Math.floor(rawLimit);
}

// ---------- Helpers ----------

/**
 * Build a display title from a raw message string. Strips newlines and
 * trims to 60 visible chars, appending an ellipsis when truncated.
 */
export function titleFromFirstMessage(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 60) {
    return normalized;
  }
  return `${normalized.slice(0, 60)}…`;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectRoot: row.project_root,
    title: row.title,
    model: row.model,
    backend: row.backend,
    summary: row.summary,
  };
}

function parseToolCalls(raw: string | null): ToolCall[] | undefined {
  if (raw === null || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;

    // Narrow each entry back into a `ToolCall` shape. We only trust what
    // we previously wrote, but guard defensively anyway.
    const calls: ToolCall[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      const id = obj['id'];
      const name = obj['name'];
      const args = obj['arguments'];
      if (
        typeof id === 'string' &&
        typeof name === 'string' &&
        args !== null &&
        typeof args === 'object' &&
        !Array.isArray(args)
      ) {
        calls.push({
          id,
          name,
          arguments: args as Record<string, unknown>,
        });
      }
    }
    return calls.length > 0 ? calls : undefined;
  } catch {
    return undefined;
  }
}

function rowToMessage(row: MessageRow): Message {
  const role = row.role;
  if (
    role !== 'user' &&
    role !== 'assistant' &&
    role !== 'system' &&
    role !== 'tool'
  ) {
    // Defensive — the CHECK constraint in SQL already guarantees this,
    // but TS needs the narrowing.
    throw new SessionDbError(`Invalid message role in DB: ${row.role}`);
  }

  const msg: Message = {
    id: row.id,
    role,
    content: row.content,
    createdAt: row.created_at,
  };

  if (role === 'tool') {
    if (row.tool_name !== null) msg.toolName = row.tool_name;
    // For a `tool` row we reuse `tool_args` to store the toolCallId.
    if (row.tool_args !== null) msg.toolCallId = row.tool_args;
  } else {
    const calls = parseToolCalls(row.tool_args);
    if (calls !== undefined) msg.toolCalls = calls;
  }

  // Round-3 telemetry columns. Only surface them when the DB actually
  // has a value so consumers can distinguish "no data" (undefined) from
  // a genuine zero count.
  if (row.tokens_input !== null) msg.tokensInput = row.tokens_input;
  if (row.tokens_output !== null) msg.tokensOutput = row.tokens_output;
  if (row.duration_ms !== null) msg.durationMs = row.duration_ms;
  if (row.model !== null) msg.model = row.model;
  // COST-PERSIST-SECTION
  if (row.cost_usd !== null && row.cost_usd !== undefined) {
    msg.cost = row.cost_usd;
  }
  if (row.cached_input_tokens !== null && row.cached_input_tokens !== undefined) {
    msg.cachedInputTokens = row.cached_input_tokens;
  }
  if (row.cache_creation_tokens !== null && row.cache_creation_tokens !== undefined) {
    msg.cacheCreationTokens = row.cache_creation_tokens;
  }
  // COST-PERSIST-SECTION-END

  return msg;
}

/**
 * Serialize an outgoing message's sidecar fields (tool_name, tool_args).
 *
 * - For role === 'tool' we persist `toolName` + `toolCallId` (both strings).
 * - For any other role we persist `toolCalls` as a JSON array under `tool_args`.
 *
 * This reuses the singular-named `tool_args` column on purpose —
 * per the Agent 5 contract it holds both JSON blobs (for assistant tool
 * calls) and plain `toolCallId` strings (for tool responses).
 */
function sidecarFor(message: Message): { toolName: string | null; toolArgs: string | null } {
  if (message.role === 'tool') {
    return {
      toolName: message.toolName ?? null,
      toolArgs: message.toolCallId ?? null,
    };
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    return {
      toolName: null,
      toolArgs: JSON.stringify(message.toolCalls),
    };
  }
  return { toolName: null, toolArgs: null };
}

// ---------- SessionManager ----------

export class SessionManager {
  private readonly db: SqliteDatabase;
  // READ-REPLICA-SECTION (start)
  /**
   * Dedicated read-only connection over the SAME on-disk database as
   * `this.db`. Heavy SELECTs (`getMessages`, `getAllMessages`,
   * `searchMessages`, `countSearchMessages`) run on this handle so a
   * long history fetch can't queue behind an ongoing write transaction
   * on the writer (and vice versa).
   *
   * Falls back to `this.db` (aliased) when:
   *   - the caller injected a custom `:memory:` writer (each `:memory:`
   *     open is isolated, so a separate reader wouldn't see writes),
   *   - the caller injected a single `Database` rather than a
   *     `{ writer, reader }` pair — backward-compat for tests that
   *     pre-date this change,
   *   - opening the readonly sibling failed (logged in `db.ts`).
   *
   * **Never use `readDb` for transactions.** SQLite errors
   * `attempt to write a readonly database` if you do — the predicate
   * is enforced by the router below: only `stmtGetMessages*` /
   * `stmtCountMessages` / `stmtSearch*` are bound to the reader.
   */
  private readonly readDb: SqliteDatabase;
  // READ-REPLICA-SECTION (end)

  // LAN-SYNC-SECTION (start) — optional fan-out hook the ShareCoordinator
  // wires once `--lan` is enabled. Default `null` ⇒ zero overhead on
  // every `addMessage` for the (default) standalone case.
  private lanSyncBridge: LanSyncBridge | null = null;
  // LAN-SYNC-SECTION (end)

  // Prepared statements — created once in the constructor.
  private readonly stmtInsertSession: Statement;
  private readonly stmtGetSession: Statement;
  private readonly stmtListSessions: Statement;
  private readonly stmtUpdateTitle: Statement;
  private readonly stmtUpdateSummary: Statement;
  private readonly stmtTouchSession: Statement;
  private readonly stmtDeleteMessages: Statement;
  private readonly stmtDeleteSession: Statement;
  private readonly stmtInsertMessage: Statement;
  // ROADMAP #4 — `stmtGetMessages` returns chronological order
  // (oldest → newest) and only fetches the most-recent N rows by
  // default. The recent-N is fetched DESC, then reversed in TS for
  // the chronological return order.
  //
  // READ-REPLICA-SECTION: these are prepared on `readDb` (read-only
  // connection) so they never contend with writer transactions.
  private readonly stmtGetRecentMessages: Statement;
  private readonly stmtGetRecentMessagesBefore: Statement;
  private readonly stmtGetAllMessages: Statement;
  private readonly stmtCountMessages: Statement;
  private readonly stmtGetStats: Statement;
  private readonly stmtGetTodos: Statement;
  private readonly stmtSetTodos: Statement;

  /**
   * Construct a SessionManager.
   *
   * Three argument shapes for `db`:
   *  - `undefined` — open the default singleton writer + reader pair.
   *  - `SqliteDatabase` — single handle (back-compat for tests that
   *    inject a `:memory:` DB). Reads alias to the same handle.
   *  - `{ writer, reader }` — explicit pair (e.g. `openDbPair(path)`),
   *    used by production code on file-backed databases.
   */
  constructor(db?: SqliteDatabase | { writer: SqliteDatabase; reader: SqliteDatabase }) {
    // READ-REPLICA-SECTION (router)
    if (db === undefined) {
      this.db = getDb();
      this.readDb = getReadDb();
    } else if ('writer' in db && 'reader' in db) {
      this.db = db.writer;
      this.readDb = db.reader;
    } else {
      this.db = db;
      // Single-handle injection — alias the reader. Heavy reads still
      // work; they just don't get the contention-relief benefit.
      this.readDb = db;
    }
    // READ-REPLICA-SECTION (end)

    try {
      this.stmtInsertSession = this.db.prepare(
        `INSERT INTO sessions
           (id, created_at, updated_at, project_root, title, model, backend, summary)
         VALUES
           ($id, $createdAt, $updatedAt, $projectRoot, $title, $model, $backend, $summary)`,
      );

      this.stmtGetSession = this.db.prepare(
        `SELECT id, created_at, updated_at, project_root, title, model, backend, summary
         FROM sessions
         WHERE id = ?`,
      );

      this.stmtListSessions = this.db.prepare(
        `SELECT id, created_at, updated_at, project_root, title, model, backend, summary
         FROM sessions
         ORDER BY updated_at DESC
         LIMIT ?`,
      );

      this.stmtUpdateTitle = this.db.prepare(
        `UPDATE sessions
         SET title = $title, updated_at = $updatedAt
         WHERE id = $id`,
      );

      this.stmtUpdateSummary = this.db.prepare(
        `UPDATE sessions
         SET summary = $summary, updated_at = $updatedAt
         WHERE id = $id`,
      );

      this.stmtTouchSession = this.db.prepare(
        `UPDATE sessions
         SET updated_at = $updatedAt
         WHERE id = $id`,
      );

      this.stmtDeleteMessages = this.db.prepare(
        `DELETE FROM messages WHERE session_id = ?`,
      );

      this.stmtDeleteSession = this.db.prepare(
        `DELETE FROM sessions WHERE id = ?`,
      );

      this.stmtInsertMessage = this.db.prepare(
        `INSERT INTO messages
           (id, session_id, role, content, tool_name, tool_args, created_at,
            tokens_input, tokens_output, duration_ms, model,
            cost_usd, cached_input_tokens, cache_creation_tokens)
         VALUES
           ($id, $sessionId, $role, $content, $toolName, $toolArgs, $createdAt,
            $tokensInput, $tokensOutput, $durationMs, $model,
            $costUsd, $cachedInputTokens, $cacheCreationTokens)`,
      );

      // ROADMAP #4 — Lazy pagination.
      //
      // `stmtGetRecentMessages` fetches the *most recent* N rows for a
      // session (DESC order). Callers reverse the array in TS to get
      // chronological order. SQLite treats `LIMIT -1` as "no limit",
      // so the same statement also covers the "give me everything"
      // path used by `getAllMessages`.
      //
      // `stmtGetRecentMessagesBefore` is the paginated cousin: it
      // returns the most-recent N rows that precede a given anchor
      // message (by `created_at`, with insertion order as a tiebreaker
      // via implicit `rowid`). The anchor row itself is excluded.
      //
      // We use `rowid` (insertion order) — not `id` (UUID) — for
      // tie-breaking so that messages inserted within the same
      // millisecond preserve the order they were stored, matching the
      // historical behaviour of the previous chronological scan.
      //
      // Both queries are covered by `idx_messages_session_created_id`
      // for the dominant `(session_id, created_at)` predicate; the
      // rowid-based tiebreaker is then a cheap row-id comparison.
      // READ-REPLICA-SECTION (start) — bind heavy SELECTs to the
      // read-only connection. When `readDb === db` (in-memory test
      // path, or fallback when the readonly open failed) this is just
      // the writer handle and behaviour is unchanged.
      this.stmtGetRecentMessages = this.readDb.prepare(
        `SELECT id, session_id, role, content, tool_name, tool_args, created_at,
                tokens_input, tokens_output, duration_ms, model,
                cost_usd, cached_input_tokens, cache_creation_tokens
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      );

      this.stmtGetRecentMessagesBefore = this.readDb.prepare(
        `SELECT id, session_id, role, content, tool_name, tool_args, created_at,
                tokens_input, tokens_output, duration_ms, model,
                cost_usd, cached_input_tokens, cache_creation_tokens
         FROM messages
         WHERE session_id = $sessionId
           AND (
             created_at < (SELECT created_at FROM messages WHERE id = $beforeId)
             OR (
               created_at = (SELECT created_at FROM messages WHERE id = $beforeId)
               AND rowid < (SELECT rowid FROM messages WHERE id = $beforeId)
             )
           )
         ORDER BY created_at DESC, rowid DESC
         LIMIT $limit`,
      );

      // Backward-compat fallback (`getAllMessages`) — full chronological
      // scan. Same shape as the historical `stmtGetMessages` from before
      // pagination landed.
      this.stmtGetAllMessages = this.readDb.prepare(
        `SELECT id, session_id, role, content, tool_name, tool_args, created_at,
                tokens_input, tokens_output, duration_ms, model,
                cost_usd, cached_input_tokens, cache_creation_tokens
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      );

      this.stmtCountMessages = this.readDb.prepare(
        `SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?`,
      );
      // READ-REPLICA-SECTION (end)

      this.stmtGetStats = this.db.prepare(
        `SELECT
           COALESCE(SUM(tokens_input), 0)  AS total_tokens_input,
           COALESCE(SUM(tokens_output), 0) AS total_tokens_output,
           COALESCE(SUM(duration_ms), 0)   AS total_duration_ms,
           COUNT(*)                        AS message_count
         FROM messages
         WHERE session_id = ?`,
      );

      this.stmtGetTodos = this.db.prepare(
        `SELECT session_todos FROM sessions WHERE id = ?`,
      );

      this.stmtSetTodos = this.db.prepare(
        `UPDATE sessions SET session_todos = $todos WHERE id = $id`,
      );
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(`Failed to prepare session statements: ${msg}`, cause);
    }
  }

  // ---------- Sessions ----------

  /**
   * Persist a fresh session row.
   *
   * When `id` is omitted, a UUID is minted (the standard path used by
   * the chat UI). When `id` is supplied, the caller is asserting
   * ownership of the id namespace — the agent runner-factory uses
   * this to persist worker rows under the synthetic
   * `<parent>.agent.<agentId>` id so AgentTeamPanel deep-dives can
   * later query worker history by that exact key.
   */
  createSession(
    projectRoot: string,
    model: string,
    backend: string,
    options?: { id?: string },
  ): Session {
    const now = Date.now();
    const session: Session = {
      id: options?.id ?? crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      projectRoot,
      title: null,
      model,
      backend,
      summary: null,
    };

    try {
      this.stmtInsertSession.run({
        $id: session.id,
        $createdAt: session.createdAt,
        $updatedAt: session.updatedAt,
        $projectRoot: session.projectRoot,
        $title: session.title,
        $model: session.model,
        $backend: session.backend,
        $summary: session.summary,
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(`Failed to create session: ${msg}`, cause);
    }

    return session;
  }

  getSession(id: string): Session | null {
    try {
      // `bun:sqlite` returns `null` for no-row, `better-sqlite3` returns
      // `undefined`. Treat both as absence.
      const row = this.stmtGetSession.get(id) as SessionRow | null | undefined;
      return row === null || row === undefined ? null : rowToSession(row);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(`Failed to get session ${id}: ${msg}`, cause);
    }
  }

  listSessions(limit: number = 20): Session[] {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    try {
      const rows = this.stmtListSessions.all(safeLimit) as SessionRow[];
      return rows.map(rowToSession);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(`Failed to list sessions: ${msg}`, cause);
    }
  }

  updateTitle(id: string, title: string): void {
    try {
      this.stmtUpdateTitle.run({
        $id: id,
        $title: title,
        $updatedAt: Date.now(),
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(`Failed to update title for ${id}: ${msg}`, cause);
    }
  }

  /**
   * Persist a compressed chat summary on the session row so that a
   * subsequent `/resume` can re-inject prior context into the model.
   * Overwrites any previously-stored summary (callers are expected to
   * append or rewrite externally before calling this).
   */
  updateSummary(sessionId: string, summary: string): void {
    try {
      this.stmtUpdateSummary.run({
        $id: sessionId,
        $summary: summary,
        $updatedAt: Date.now(),
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to update summary for ${sessionId}: ${msg}`,
        cause,
      );
    }
  }

  /**
   * Cascade-delete every session whose `project_root` matches the given
   * absolute path. Idempotent — returns 0 when nothing matches. Used by
   * `DELETE /api/projects/:id` so removing a project also cleans up its
   * stored conversations (the user's source code on disk is never
   * touched). The transaction wraps both the messages and sessions
   * deletes so partial failures can't leave orphan rows.
   */
  deleteSessionsForProjectRoot(projectRoot: string): number {
    try {
      const stmtSelect = this.db.prepare(
        `SELECT id FROM sessions WHERE project_root = ?`,
      );
      const rows = stmtSelect.all(projectRoot) as { id: string }[];
      if (rows.length === 0) return 0;
      const tx = this.db.transaction((ids: readonly string[]) => {
        for (const sid of ids) {
          this.stmtDeleteMessages.run(sid);
          this.stmtDeleteSession.run(sid);
        }
      });
      tx(rows.map((r) => r.id));
      return rows.length;
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to cascade-delete sessions for ${projectRoot}: ${msg}`,
        cause,
      );
    }
  }

  deleteSession(id: string): void {
    // We don't have ON DELETE CASCADE in the schema — per the Agent 5
    // contract, explicitly delete messages first, then the session row.
    // Wrap in a transaction so partial failure doesn't leave orphans.
    try {
      const tx = this.db.transaction((sessionId: string) => {
        this.stmtDeleteMessages.run(sessionId);
        this.stmtDeleteSession.run(sessionId);
      });
      tx(id);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(`Failed to delete session ${id}: ${msg}`, cause);
    }
  }

  // LAN-SYNC-SECTION (setter)
  /**
   * Install (or clear) the LAN sync fan-out bridge. Wired by the
   * ShareCoordinator's startup code in `app.tsx` / web boot. Passing
   * `null` disables fan-out (used during shutdown).
   */
  setLanSyncBridge(bridge: LanSyncBridge | null): void {
    this.lanSyncBridge = bridge;
  }
  // LAN-SYNC-SECTION (setter end)

  // ---------- Messages ----------

  addMessage(
    sessionId: string,
    message: Message,
    options?: AddMessageOptions,
  ): void {
    const { toolName, toolArgs } = sidecarFor(message);
    const createdAt = message.createdAt;

    // Accept both inline `message.tokensInput/…` fields and an explicit
    // `options` argument. The explicit argument wins when both are set
    // (callers that know the fresh numbers pass them through `options`).
    const tokensInput = options?.tokensInput ?? message.tokensInput ?? null;
    const tokensOutput = options?.tokensOutput ?? message.tokensOutput ?? null;
    const durationMs = options?.durationMs ?? message.durationMs ?? null;
    const model = options?.model ?? message.model ?? null;
    // COST-PERSIST-SECTION
    const cachedInputTokens =
      options?.cachedInputTokens ?? message.cachedInputTokens ?? null;
    const cacheCreationTokens =
      options?.cacheCreationTokens ?? message.cacheCreationTokens ?? null;
    // Compute a per-message USD cost via the OpenRouter-aware resolver
    // so the dashboards can read the persisted value rather than
    // re-resolving prices on every render. Only assistant rows that
    // carry pricing-eligible telemetry get a non-null cost — local
    // providers and rows without tokens leave the column null.
    let costUsd: number | null = null;
    if (
      message.role === 'assistant' &&
      model !== null &&
      ((tokensInput !== null && tokensInput > 0) ||
        (tokensOutput !== null && tokensOutput > 0))
    ) {
      // Backend hint order: explicit option ▸ stored session backend ▸
      // unknown (resolver falls through to static lookup). The session
      // lookup is cheap (PK GET on the cached SessionRow path).
      let backend: Backend | string | undefined = options?.backend;
      if (backend === undefined) {
        try {
          const sess = this.getSession(sessionId);
          backend = sess?.backend;
        } catch {
          backend = undefined;
        }
      }
      try {
        const pricing = resolvePrice(backend ?? 'unknown', model);
        if (pricing !== null) {
          const breakdown = computeCostBreakdown(
            {
              ...(tokensInput !== null ? { inputTokens: tokensInput } : {}),
              ...(tokensOutput !== null ? { outputTokens: tokensOutput } : {}),
              ...(cachedInputTokens !== null
                ? { cachedInputTokens }
                : {}),
              ...(cacheCreationTokens !== null
                ? { cacheCreationTokens }
                : {}),
            },
            pricing,
          );
          if (breakdown.total > 0) costUsd = breakdown.total;
        }
      } catch {
        // Pricing failures are non-fatal — store row without cost.
      }
    }
    // COST-PERSIST-SECTION-END

    try {
      const tx = this.db.transaction(() => {
        this.stmtInsertMessage.run({
          $id: message.id,
          $sessionId: sessionId,
          $role: message.role,
          $content: message.content,
          $toolName: toolName,
          $toolArgs: toolArgs,
          $createdAt: createdAt,
          $tokensInput: tokensInput,
          $tokensOutput: tokensOutput,
          $durationMs: durationMs,
          $model: model,
          // COST-PERSIST-SECTION
          $costUsd: costUsd,
          $cachedInputTokens: cachedInputTokens,
          $cacheCreationTokens: cacheCreationTokens,
          // COST-PERSIST-SECTION-END
        });
        this.stmtTouchSession.run({
          $id: sessionId,
          $updatedAt: Date.now(),
        });
      });
      tx();
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to add message to session ${sessionId}: ${msg}`,
        cause,
      );
    }
    // COST-PERSIST-SECTION — mutate the in-memory copy so callers that
    // forward the same Message object to UI emitters surface the cost
    // chip without re-querying. Mirrors what `rowToMessage` would do
    // on a subsequent read.
    if (costUsd !== null) message.cost = costUsd;
    if (cachedInputTokens !== null && message.cachedInputTokens === undefined) {
      message.cachedInputTokens = cachedInputTokens;
    }
    if (
      cacheCreationTokens !== null &&
      message.cacheCreationTokens === undefined
    ) {
      message.cacheCreationTokens = cacheCreationTokens;
    }
    // COST-PERSIST-SECTION-END
    // LAN-SYNC-SECTION (start) — fan the freshly-persisted message out
    // to any LAN peer subscribed to this session. The bridge is opt-in
    // (wired only when `--lan` is active) and best-effort: a broadcast
    // failure must NOT throw out of addMessage and disrupt the local
    // write path.
    const bridge = this.lanSyncBridge;
    if (bridge !== null) {
      try {
        bridge.onLocalMessage(sessionId, message);
      } catch {
        /* swallow — sharing is best-effort */
      }
    }
    // LAN-SYNC-SECTION (end)
  }

  /**
   * Read messages for a session.
   *
   * **Behavioural change (ROADMAP #4):** prior to this revision the
   * default `getMessages(sid)` call returned every row in the session.
   * It now returns at most the **most recent 100** messages, in
   * chronological order. Callers that need the full history must use
   * either `getAllMessages(sessionId)` (explicit unbounded fetch) or
   * pass `{ limit: Infinity }`.
   *
   * @param sessionId — session whose messages to read.
   * @param options.limit — max rows to return. Defaults to `100`.
   *   Pass `Infinity` to disable the cap (use `getAllMessages` for
   *   self-documenting code). Non-positive or non-finite values are
   *   coerced to the default.
   * @param options.before — optional anchor message id. When provided,
   *   only messages strictly older than the anchor (by `created_at`,
   *   `id` tie-broken) are returned. Powers "scroll up to load older
   *   messages" UX. If the anchor id does not exist, the call returns
   *   the most-recent `limit` messages — no error is thrown so the UI
   *   keeps working through deletes/clock skews.
   * @returns chronologically-ordered (oldest → newest) array. Up to
   *   `limit` entries; may be empty for unknown / empty sessions.
   */
  getMessages(sessionId: string, options?: GetMessagesOptions): Message[] {
    const limit = normaliseLimit(options?.limit);
    const before = options?.before;
    try {
      let rows: MessageRow[];
      if (before === undefined || before === '') {
        rows = this.stmtGetRecentMessages.all(sessionId, limit) as MessageRow[];
      } else {
        rows = this.stmtGetRecentMessagesBefore.all({
          $sessionId: sessionId,
          $beforeId: before,
          $limit: limit,
        }) as MessageRow[];
      }
      // Statements ORDER BY DESC for the LIMIT-friendly index seek;
      // surface the data in chronological order to keep the
      // historical contract.
      const chronological: Message[] = [];
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row !== undefined) chronological.push(rowToMessage(row));
      }
      return chronological;
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to read messages for session ${sessionId}: ${msg}`,
        cause,
      );
    }
  }

  /**
   * Explicit unbounded fetch — returns every message for the session
   * in chronological order. Provided as a backward-compat helper for
   * call sites that genuinely need the whole history (full export,
   * stats over all rows, etc.).
   *
   * Prefer `getMessages` (paginated) for any UI-facing path: long
   * sessions can have many thousands of rows and the full scan is
   * expensive.
   */
  getAllMessages(sessionId: string): Message[] {
    try {
      const rows = this.stmtGetAllMessages.all(sessionId) as MessageRow[];
      return rows.map(rowToMessage);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to read messages for session ${sessionId}: ${msg}`,
        cause,
      );
    }
  }

  /**
   * Load N more older messages preceding a known anchor. Convenience
   * wrapper around `getMessages(sid, { before, limit })` with the same
   * chronological return order — exists so call sites that handle the
   * "scroll up to load older" UX can read more naturally.
   */
  loadOlderMessages(
    sessionId: string,
    beforeMessageId: string,
    limit: number = DEFAULT_PAGE_SIZE,
  ): Message[] {
    return this.getMessages(sessionId, { before: beforeMessageId, limit });
  }

  /**
   * Total number of messages stored for a session. Powers the chat
   * overlay's "X earlier messages — scroll to load" hint without
   * paying for a full row materialisation. Unknown sessions return 0.
   */
  getMessageCount(sessionId: string): number {
    try {
      const row = this.stmtCountMessages.get(sessionId) as
        | MessageCountRow
        | null
        | undefined;
      if (row === null || row === undefined) return 0;
      return row.cnt ?? 0;
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to count messages for session ${sessionId}: ${msg}`,
        cause,
      );
    }
  }

  // ---------- Todos ----------

  /**
   * Read the current todos list for a session. Returns an empty array
   * for an unknown session, a session with no todos yet, or if the
   * persisted JSON is malformed (Zod validation failure).
   */
  getTodos(sessionId: string): Todo[] {
    try {
      const row = this.stmtGetTodos.get(sessionId) as
        | { session_todos: string | null }
        | null
        | undefined;
      if (row === null || row === undefined) return [];
      const raw = row.session_todos;
      if (raw === null || raw === '') return [];
      const parsed: unknown = JSON.parse(raw);
      const result = TodosArraySchema.safeParse(parsed);
      if (!result.success) return [];
      return result.data;
    } catch {
      return [];
    }
  }

  /**
   * Persist a new todos list for a session, replacing any previously
   * stored list. Serialises to JSON and writes to the `session_todos`
   * column. Throws `SessionDbError` on SQLite failure.
   */
  setTodos(sessionId: string, todos: readonly Todo[]): void {
    try {
      this.stmtSetTodos.run({
        $id: sessionId,
        $todos: JSON.stringify(todos),
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to set todos for session ${sessionId}: ${msg}`,
        cause,
      );
    }
  }

  /**
   * Aggregate per-session usage / timing totals. Intended for the UI's
   * usage footer and any future "session cost" views.
   *
   * - Unknown / NULL columns contribute 0.
   * - Returns `{ …: 0, messageCount: 0 }` for a session that has no
   *   rows yet (or an unknown `sessionId`).
   */
  getSessionStats(sessionId: string): SessionStats {
    try {
      const row = this.stmtGetStats.get(sessionId) as
        | MessageStatsRow
        | null
        | undefined;

      if (row === null || row === undefined) {
        return {
          totalTokensInput: 0,
          totalTokensOutput: 0,
          totalDurationMs: 0,
          messageCount: 0,
        };
      }

      return {
        totalTokensInput: row.total_tokens_input ?? 0,
        totalTokensOutput: row.total_tokens_output ?? 0,
        totalDurationMs: row.total_duration_ms ?? 0,
        messageCount: row.message_count ?? 0,
      };
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to read session stats for ${sessionId}: ${msg}`,
        cause,
      );
    }
  }

  /**
   * Aggregate usage / cost across many sessions in a single SQL pass.
   *
   * Power-user analytics for the usage dashboard: read-only, pure
   * aggregation, no mutation. The pricing-table multiplier is applied
   * in TS after the SQL pulls per-message token telemetry — that lets
   * us share `computeCost` with the per-row chat footer rendering and
   * keeps the SQL portable.
   *
   * Cached-token tracking: the messages table doesn't have a
   * `cache_read_input_tokens` column, so `totalCachedTokens` is 0 here.
   * If/when telemetry persistence lands the field is wired up.
   *
   * **Performance.** The driving query scans the messages table once
   * with a `WHERE created_at >= ?` predicate. There is no index on
   * `created_at` alone — the idx_messages_session_created_id covering
   * index is session-scoped — but for typical user databases (single-
   * digit thousand messages) a full scan completes in <10ms.
   */
  getUsageStats(options: GetUsageStatsOptions = {}): UsageStats {
    const sinceMs =
      options.sinceMs !== undefined && Number.isFinite(options.sinceMs)
        ? Math.floor(options.sinceMs)
        : Date.now() - 30 * 24 * 60 * 60 * 1000;
    const modelFilter = options.modelFilter?.trim().toLowerCase() ?? '';
    const projectRoot = options.projectRoot;
    const topLimit =
      options.topSessionsLimit !== undefined &&
      Number.isFinite(options.topSessionsLimit) &&
      options.topSessionsLimit > 0
        ? Math.floor(options.topSessionsLimit)
        : 10;

    interface RowMsg {
      session_id: string;
      model: string | null;
      tokens_input: number | null;
      tokens_output: number | null;
      duration_ms: number | null;
      created_at: number;
      project_root: string;
      title: string | null;
      // COST-PERSIST-SECTION
      backend: string | null;
      cost_usd: number | null;
      cached_input_tokens: number | null;
      // COST-PERSIST-SECTION-END
    }
    let sql =
      `SELECT m.session_id, m.model, m.tokens_input, m.tokens_output,
              m.duration_ms, m.created_at, s.project_root, s.title,
              s.backend AS backend,
              m.cost_usd AS cost_usd,
              m.cached_input_tokens AS cached_input_tokens
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.created_at >= $sinceMs
         AND (m.tokens_input IS NOT NULL OR m.tokens_output IS NOT NULL)`;
    const params: Record<string, string | number> = { $sinceMs: sinceMs };
    if (projectRoot !== undefined && projectRoot.length > 0) {
      sql += ` AND s.project_root = $projectRoot`;
      params.$projectRoot = projectRoot;
    }

    let rows: RowMsg[];
    try {
      const stmt = this.db.prepare(sql);
      rows = stmt.all(params) as RowMsg[];
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(`Failed to aggregate usage stats: ${msg}`, cause);
    }

    // Sub-agent rows are excluded from user-facing analytics, matching
    // the sidebar's exclusion via `.agent.` substring.
    const filtered = rows.filter((r) => !r.session_id.includes('.agent.'));

    let totalIn = 0;
    let totalOut = 0;
    let totalDuration = 0;
    let totalCost = 0;
    let turnCount = 0;

    const perModelMap = new Map<string, UsagePerModel>();
    const perDayMap = new Map<string, UsagePerDay>();
    const perSessionMap = new Map<
      string,
      {
        tokens: number;
        cost: number;
        lastUsedAt: number;
        title: string | null;
      }
    >();

    for (const r of filtered) {
      const model = r.model ?? 'unknown';
      if (modelFilter.length > 0 && !model.toLowerCase().includes(modelFilter)) {
        continue;
      }
      const tokIn = r.tokens_input ?? 0;
      const tokOut = r.tokens_output ?? 0;
      const dur = r.duration_ms ?? 0;
      // COST-PERSIST-SECTION — prefer persisted per-row cost; fall
      // back to OpenRouter-aware resolver, then static `computeCost`.
      let cost = 0;
      if (r.cost_usd !== null && r.cost_usd > 0) {
        cost = r.cost_usd;
      } else {
        const pricing = resolvePrice(r.backend ?? 'unknown', model);
        if (pricing !== null) {
          const breakdown = computeCostBreakdown(
            {
              inputTokens: tokIn,
              outputTokens: tokOut,
              ...(r.cached_input_tokens !== null
                ? { cachedInputTokens: r.cached_input_tokens }
                : {}),
            },
            pricing,
          );
          cost = breakdown.total;
        } else {
          cost = computeCost(model, tokIn, tokOut);
        }
      }
      // COST-PERSIST-SECTION-END

      totalIn += tokIn;
      totalOut += tokOut;
      totalDuration += dur;
      totalCost += cost;
      turnCount += 1;

      const m = perModelMap.get(model);
      if (m === undefined) {
        perModelMap.set(model, {
          model,
          tokensIn: tokIn,
          tokensOut: tokOut,
          cost,
          turns: 1,
        });
      } else {
        m.tokensIn += tokIn;
        m.tokensOut += tokOut;
        m.cost += cost;
        m.turns += 1;
      }

      const date = new Date(r.created_at).toISOString().slice(0, 10);
      const d = perDayMap.get(date);
      if (d === undefined) {
        perDayMap.set(date, { date, tokensIn: tokIn, tokensOut: tokOut, cost });
      } else {
        d.tokensIn += tokIn;
        d.tokensOut += tokOut;
        d.cost += cost;
      }

      const sess = perSessionMap.get(r.session_id);
      const sessTokens = tokIn + tokOut;
      if (sess === undefined) {
        perSessionMap.set(r.session_id, {
          tokens: sessTokens,
          cost,
          lastUsedAt: r.created_at,
          title: r.title,
        });
      } else {
        sess.tokens += sessTokens;
        sess.cost += cost;
        if (r.created_at > sess.lastUsedAt) sess.lastUsedAt = r.created_at;
        if (sess.title === null && r.title !== null) sess.title = r.title;
      }
    }

    const perModel = Array.from(perModelMap.values()).sort(
      (a, b) =>
        b.cost - a.cost || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut),
    );
    const perDay = Array.from(perDayMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    const topSessions: UsageTopSession[] = Array.from(perSessionMap.entries())
      .map(([sessionId, v]) => ({
        sessionId,
        title: v.title,
        tokens: v.tokens,
        cost: v.cost,
        lastUsedAt: v.lastUsedAt,
      }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
      .slice(0, topLimit);

    return {
      totalTokensIn: totalIn,
      totalTokensOut: totalOut,
      totalCachedTokens: 0,
      totalDurationMs: totalDuration,
      totalCostUsd: totalCost,
      sessionCount: perSessionMap.size,
      turnCount,
      perModel,
      perDay,
      topSessions,
    };
  }

  // ---------- USAGE-AGGREGATE-SECTION (start) ----------
  //
  // `/usage` dashboard helpers. The legacy {@link getUsageStats} above
  // is purpose-built for the SPA /api/usage envelope and accepts a
  // `sinceMs` floor / project filter — the methods below produce a
  // simpler "all time" rollup for the TUI dashboard. Each method runs
  // a single covering scan over the messages table (via the
  // `idx_messages_session_created_id` index) and aggregates in TS.
  //
  // Cached-token aggregation: the messages table does NOT persist
  // cache-hit counts today (see the comment on getUsageStats). The
  // schema field is computed as 0 here so the UI surface is forward-
  // compatible — when telemetry persistence lands the field flows
  // through without an API change.

  /**
   * Aggregate token usage / session counts per distinct model, across
   * every session in the database. Sub-agent sessions are excluded so
   * the user-facing dashboard never lands a row for an internal worker.
   *
   * Each entry is sorted by combined-token volume (desc) at the call
   * site — this method returns rows in arbitrary order so the caller
   * can re-sort by cost (which requires the pricing table).
   */
  aggregateUsageByModel(): Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    sessions: number;
    firstUsedAt: number;
    lastUsedAt: number;
  }> {
    interface Row {
      session_id: string;
      model: string | null;
      tokens_input: number | null;
      tokens_output: number | null;
      created_at: number;
    }
    try {
      const stmt = this.readDb.prepare(
        `SELECT session_id, model, tokens_input, tokens_output, created_at
         FROM messages
         WHERE tokens_input IS NOT NULL OR tokens_output IS NOT NULL`,
      );
      const rows = stmt.all() as Row[];
      const perModel = new Map<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cachedTokens: number;
          sessions: Set<string>;
          firstUsedAt: number;
          lastUsedAt: number;
        }
      >();
      for (const r of rows) {
        if (r.session_id.includes('.agent.')) continue;
        const model = r.model ?? 'unknown';
        const tokIn = r.tokens_input ?? 0;
        const tokOut = r.tokens_output ?? 0;
        const ts = r.created_at;
        const entry = perModel.get(model);
        if (entry === undefined) {
          perModel.set(model, {
            inputTokens: tokIn,
            outputTokens: tokOut,
            cachedTokens: 0,
            sessions: new Set([r.session_id]),
            firstUsedAt: ts,
            lastUsedAt: ts,
          });
        } else {
          entry.inputTokens += tokIn;
          entry.outputTokens += tokOut;
          entry.sessions.add(r.session_id);
          if (ts < entry.firstUsedAt) entry.firstUsedAt = ts;
          if (ts > entry.lastUsedAt) entry.lastUsedAt = ts;
        }
      }
      return Array.from(perModel.entries()).map(([model, v]) => ({
        model,
        inputTokens: v.inputTokens,
        outputTokens: v.outputTokens,
        cachedTokens: v.cachedTokens,
        sessions: v.sessions.size,
        firstUsedAt: v.firstUsedAt,
        lastUsedAt: v.lastUsedAt,
      }));
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to aggregate usage by model: ${msg}`,
        cause,
      );
    }
  }

  /**
   * Aggregate token + cost usage per session, capped at the top N most
   * expensive. Cost is computed in TS via the legacy `computeCost`
   * helper (which routes through the static pricing table). The
   * dashboard reapplies the OpenRouter-aware resolver for the final
   * display so the cost shown to the user reflects the freshest data.
   *
   * Returns:
   *   - sessionId, title, model (most-used model in the session by
   *     turn count — important for mixed-model sessions),
   *   - aggregated input/output tokens,
   *   - rolled-up cost,
   *   - `createdAt` for the "when" column.
   */
  aggregateUsageBySession(limit: number = 20): Array<{
    sessionId: string;
    title: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
    createdAt: number;
  }> {
    const cap =
      Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    interface Row {
      session_id: string;
      title: string | null;
      created_at: number;
      msg_created_at: number;
      model: string | null;
      tokens_input: number | null;
      tokens_output: number | null;
      // COST-PERSIST-SECTION
      backend: string | null;
      cost_usd: number | null;
      cached_input_tokens: number | null;
      // COST-PERSIST-SECTION-END
    }
    try {
      const stmt = this.readDb.prepare(
        `SELECT s.id AS session_id,
                s.title AS title,
                s.created_at AS created_at,
                s.backend AS backend,
                m.created_at AS msg_created_at,
                m.model AS model,
                m.tokens_input AS tokens_input,
                m.tokens_output AS tokens_output,
                m.cost_usd AS cost_usd,
                m.cached_input_tokens AS cached_input_tokens
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.tokens_input IS NOT NULL OR m.tokens_output IS NOT NULL`,
      );
      const rows = stmt.all() as Row[];
      const acc = new Map<
        string,
        {
          title: string | null;
          createdAt: number;
          inputTokens: number;
          outputTokens: number;
          totalCost: number;
          // Per-model turn counts so we can pick the dominant model
          // for the session in the UI.
          modelTurns: Map<string, number>;
        }
      >();
      for (const r of rows) {
        if (r.session_id.includes('.agent.')) continue;
        const model = r.model ?? 'unknown';
        const tokIn = r.tokens_input ?? 0;
        const tokOut = r.tokens_output ?? 0;
        // COST-PERSIST-SECTION
        // Prefer the persisted per-row cost (computed at addMessage
        // time via the OpenRouter-aware resolver). Only fall through
        // to the live resolver when the column is null — e.g. rows
        // that pre-date this column. The legacy `computeCost` (static
        // table only) is the second fallback so old static-only tests
        // continue to pass.
        let cost = 0;
        if (r.cost_usd !== null && r.cost_usd > 0) {
          cost = r.cost_usd;
        } else {
          const pricing = resolvePrice(r.backend ?? 'unknown', model);
          if (pricing !== null) {
            const breakdown = computeCostBreakdown(
              {
                inputTokens: tokIn,
                outputTokens: tokOut,
                ...(r.cached_input_tokens !== null
                  ? { cachedInputTokens: r.cached_input_tokens }
                  : {}),
              },
              pricing,
            );
            cost = breakdown.total;
          } else {
            cost = computeCost(model, tokIn, tokOut);
          }
        }
        // COST-PERSIST-SECTION-END
        const entry = acc.get(r.session_id);
        if (entry === undefined) {
          acc.set(r.session_id, {
            title: r.title,
            createdAt: r.created_at,
            inputTokens: tokIn,
            outputTokens: tokOut,
            totalCost: cost,
            modelTurns: new Map([[model, 1]]),
          });
        } else {
          entry.inputTokens += tokIn;
          entry.outputTokens += tokOut;
          entry.totalCost += cost;
          entry.modelTurns.set(
            model,
            (entry.modelTurns.get(model) ?? 0) + 1,
          );
        }
      }

      const out = Array.from(acc.entries()).map(([sid, v]) => {
        // Dominant model = whichever has the most turns. Ties broken
        // alphabetically for determinism.
        let dominantModel = 'unknown';
        let dominantCount = -1;
        for (const [m, c] of v.modelTurns.entries()) {
          if (c > dominantCount || (c === dominantCount && m < dominantModel)) {
            dominantModel = m;
            dominantCount = c;
          }
        }
        return {
          sessionId: sid,
          title: v.title ?? '(untitled)',
          model: dominantModel,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
          totalCost: v.totalCost,
          createdAt: v.createdAt,
        };
      });
      out.sort((a, b) => {
        if (b.totalCost !== a.totalCost) return b.totalCost - a.totalCost;
        const aTok = a.inputTokens + a.outputTokens;
        const bTok = b.inputTokens + b.outputTokens;
        return bTok - aTok;
      });
      return out.slice(0, cap);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to aggregate usage by session: ${msg}`,
        cause,
      );
    }
  }

  // ---------- USAGE-AGGREGATE-SECTION (end) ----------

  // ---------- Full-text search ----------

  /**
   * Cross-session full-text search over `messages.content`.
   *
   * Returns BM25-ranked hits with an FTS5 `snippet()` that highlights
   * matched tokens. Results are joined onto `sessions` so callers can
   * navigate directly to the source chat without a follow-up fetch.
   *
   * - The user's query is escaped via {@link toFtsQuery} so arbitrary
   *   input (including FTS operators like `OR`, `NEAR`, quotes,
   *   parentheses, and dashes) is treated as plain prefix search rather
   *   than tripping the SQLite parser. Empty / whitespace-only input
   *   yields an empty result list with no SQL executed.
   *
   * - Sub-agent sessions (id `<parent>.agent.<id>`) are filtered out so
   *   the SPA's overlay never lands the user on an internal worker
   *   row — those are surfaced via the agent panel instead.
   */
  searchMessages(
    query: string,
    opts?: SearchMessagesOptions,
  ): SearchMessageResult[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery === null) return [];

    const limit = clampSearchLimit(opts?.limit);
    const offset = clampSearchOffset(opts?.offset);
    const projectRoot = opts?.projectRoot;

    try {
      const sql = buildSearchSql(projectRoot !== undefined);
      // READ-REPLICA-SECTION — search is pure read.
      const stmt = this.readDb.prepare(sql);
      const params: Record<string, string | number> = {
        $q: ftsQuery,
        $limit: limit,
        $offset: offset,
      };
      if (projectRoot !== undefined) {
        params['$projectRoot'] = projectRoot;
      }
      const rows = stmt.all(params) as SearchMessageRow[];
      const out: SearchMessageResult[] = [];
      for (const r of rows) {
        if (isSubAgentSessionId(r.session_id)) continue;
        out.push({
          sessionId: r.session_id,
          messageId: r.message_id,
          role: r.role,
          snippet: r.snippet,
          rank: r.rank,
          createdAt: r.created_at,
          sessionTitle: r.session_title,
          projectRoot: r.project_root,
        });
      }
      return out;
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to search messages for "${query}": ${msg}`,
        cause,
      );
    }
  }

  /**
   * Total number of search hits for the given query (filters applied).
   * Powers a "showing X of Y" hint in the overlay; cheap because the
   * COUNT path uses the same FTS index without materialising snippets.
   */
  countSearchMessages(query: string, opts?: SearchMessagesOptions): number {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery === null) return 0;
    const projectRoot = opts?.projectRoot;
    try {
      const sql = buildSearchCountSql(projectRoot !== undefined);
      // READ-REPLICA-SECTION — count is pure read.
      const stmt = this.readDb.prepare(sql);
      const params: Record<string, string> = { $q: ftsQuery };
      if (projectRoot !== undefined) {
        params['$projectRoot'] = projectRoot;
      }
      const row = stmt.get(params) as SearchCountRow | null | undefined;
      if (row === null || row === undefined) return 0;
      // Sub-agent rows aren't filtered server-side in COUNT — they are
      // a tiny minority. Treat as overestimate; the materialised search
      // result is the source of truth for what's actually shown.
      return row.cnt ?? 0;
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `Failed to count search results for "${query}": ${msg}`,
        cause,
      );
    }
  }

  // BRANCHES-SECTION (start) — branching sessions ("/branch").
  //
  // A "branch" is a brand-new session row whose `parent_session_id`
  // points at the source session and whose `branch_point_message_id` is
  // the last message common with the parent. createBranch copies every
  // message from the parent UP TO AND INCLUDING the branch point into
  // the child session in one transaction (INSERT...SELECT) so the
  // operation is O(rows) but a single round-trip.
  //
  // getBranches returns all sibling branches under the same root (i.e.
  // every session that descends from the same root) so the breadcrumb +
  // picker can show the user every related conversation.
  //
  // getBranchTree builds a recursive tree from a root session id so the
  // picker overlay can render an indented list.
  //
  // archiveBranch is the soft-delete for `/branch delete` — it flips
  // branch_archived = 1 and is reversible. Hard delete still goes
  // through deleteSession.

  /**
   * Fork a session at a specific message (or its latest) and produce a
   * new session that shares the message prefix with the parent.
   *
   * - `fromSessionId` — parent session whose prefix to copy.
   * - `branchName`    — user-chosen label (e.g. "experiment-A").
   * - `branchAtMessageId` — optional anchor; defaults to the most-recent
   *                     message in the parent. Anchor row INCLUSIVE
   *                     (the anchor itself is copied into the branch).
   *                     If the anchor is unknown / does not belong to
   *                     the parent, throws `SessionDbError`.
   *
   * Returns the freshly-created branch session row. Caller is responsible
   * for switching the active session id to it.
   */
  createBranch(
    fromSessionId: string,
    branchName: string,
    branchAtMessageId?: string,
  ): Session {
    const trimmedName = branchName.trim();
    if (trimmedName.length === 0) {
      throw new SessionDbError(
        'createBranch: branchName must be a non-empty string',
      );
    }

    const parent = this.getSession(fromSessionId);
    if (parent === null) {
      throw new SessionDbError(
        `createBranch: parent session not found: ${fromSessionId}`,
      );
    }

    // Resolve the branch-point row. When not specified, pick the most
    // recent message in the parent. If the parent is empty, the branch
    // simply starts empty (anchorId = null).
    let anchorId: string | null = null;
    let anchorCreatedAt: number | null = null;
    let anchorRowid: number | null = null;
    try {
      if (
        branchAtMessageId !== undefined &&
        branchAtMessageId !== null &&
        branchAtMessageId.length > 0
      ) {
        const lookup = this.db
          .prepare(
            `SELECT id, created_at, rowid AS rid
             FROM messages
             WHERE id = ? AND session_id = ?`,
          )
          .get(branchAtMessageId, fromSessionId) as
          | { id: string; created_at: number; rid: number }
          | null
          | undefined;
        if (lookup === null || lookup === undefined) {
          throw new SessionDbError(
            `createBranch: branch-point message ${branchAtMessageId} not found in session ${fromSessionId}`,
          );
        }
        anchorId = lookup.id;
        anchorCreatedAt = lookup.created_at;
        anchorRowid = lookup.rid;
      } else {
        const latest = this.db
          .prepare(
            `SELECT id, created_at, rowid AS rid
             FROM messages
             WHERE session_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1`,
          )
          .get(fromSessionId) as
          | { id: string; created_at: number; rid: number }
          | null
          | undefined;
        if (latest !== null && latest !== undefined) {
          anchorId = latest.id;
          anchorCreatedAt = latest.created_at;
          anchorRowid = latest.rid;
        }
      }
    } catch (cause) {
      if (cause instanceof SessionDbError) throw cause;
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `createBranch: failed to resolve branch point: ${msg}`,
        cause,
      );
    }

    const now = Date.now();
    const branchId = crypto.randomUUID();
    const childTitle =
      parent.title !== null && parent.title.length > 0
        ? `${parent.title} [${trimmedName}]`
        : `[${trimmedName}]`;

    try {
      // Single-transaction fork: insert the child session row, then
      // INSERT...SELECT the message prefix from the parent. New message
      // ids are minted per-row so the new session has its own primary
      // keys (FK to sessions.id is by session_id, not message id).
      const insertSessionStmt = this.db.prepare(
        `INSERT INTO sessions
           (id, created_at, updated_at, project_root, title, model, backend,
            summary, parent_session_id, branch_point_message_id,
            branch_name, branch_archived)
         VALUES
           ($id, $createdAt, $updatedAt, $projectRoot, $title, $model,
            $backend, $summary, $parentId, $branchPointId, $branchName, 0)`,
      );

      // The COPY uses sqlite's hex(randomblob(16)) for fresh per-row
      // message ids (UUID-like 32-char hex strings — distinct from the
      // parent's ids so message id stays globally unique). The WHERE
      // clause picks rows up to AND INCLUDING the anchor, ordered by
      // (created_at, rowid) so the tiebreaker matches getAllMessages.
      const copyMessagesStmt = this.db.prepare(
        `INSERT INTO messages
           (id, session_id, role, content, tool_name, tool_args,
            created_at, tokens_input, tokens_output, duration_ms, model)
         SELECT
            lower(hex(randomblob(16))) AS id,
            $branchId AS session_id,
            role, content, tool_name, tool_args, created_at,
            tokens_input, tokens_output, duration_ms, model
         FROM messages
         WHERE session_id = $parentId
           AND (
             $anchorCreatedAt IS NULL
             OR created_at < $anchorCreatedAt
             OR (created_at = $anchorCreatedAt AND rowid <= $anchorRowid)
           )
         ORDER BY created_at ASC, rowid ASC`,
      );

      const tx = this.db.transaction(() => {
        insertSessionStmt.run({
          $id: branchId,
          $createdAt: now,
          $updatedAt: now,
          $projectRoot: parent.projectRoot,
          $title: childTitle,
          $model: parent.model,
          $backend: parent.backend,
          $summary: parent.summary,
          $parentId: fromSessionId,
          $branchPointId: anchorId,
          $branchName: trimmedName,
        });
        copyMessagesStmt.run({
          $branchId: branchId,
          $parentId: fromSessionId,
          $anchorCreatedAt: anchorCreatedAt,
          $anchorRowid: anchorRowid,
        });
      });
      tx();
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `createBranch: failed to fork session ${fromSessionId}: ${msg}`,
        cause,
      );
    }

    const created = this.getSession(branchId);
    if (created === null) {
      throw new SessionDbError(
        `createBranch: child session ${branchId} not found after insert`,
      );
    }
    return created;
  }

  // FORK-AT-MESSAGE-SECTION
  /**
   * Fork a session AT (not after) a specific assistant message — the
   * Claude.ai-style "edit and continue" workflow.
   *
   * Semantics:
   *   - Copy every message in the parent that lives STRICTLY BEFORE the
   *     target message (chronological order with rowid tiebreaker).
   *   - Append a fresh assistant message carrying `editedContent` at the
   *     same logical position the target occupied. The original target
   *     message and every subsequent message are intentionally NOT copied
   *     — the new branch diverges with the edit as the new top.
   *
   * Returns the freshly-created branch session row plus the id of the
   * inserted edited assistant message so callers (the REST endpoint) can
   * return both to the SPA and switch the active session.
   *
   * Throws SessionDbError when the parent / target message doesn't exist
   * or the target message is not an assistant row.
   */
  forkAtMessage(
    fromSessionId: string,
    messageId: string,
    editedContent: string,
  ): { session: Session; editedMessageId: string } {
    const parent = this.getSession(fromSessionId);
    if (parent === null) {
      throw new SessionDbError(
        `forkAtMessage: parent session not found: ${fromSessionId}`,
      );
    }

    // Look up the target row + its (created_at, rowid) so we can copy
    // strictly older messages into the branch.
    const target = this.db
      .prepare(
        `SELECT id, role, created_at, rowid AS rid
         FROM messages
         WHERE id = ? AND session_id = ?`,
      )
      .get(messageId, fromSessionId) as
      | { id: string; role: string; created_at: number; rid: number }
      | null
      | undefined;
    if (target === null || target === undefined) {
      throw new SessionDbError(
        `forkAtMessage: target message ${messageId} not found in session ${fromSessionId}`,
      );
    }
    if (target.role !== 'assistant') {
      throw new SessionDbError(
        `forkAtMessage: target message must be an assistant row (got "${target.role}")`,
      );
    }

    const now = Date.now();
    const branchId = crypto.randomUUID();
    const branchTitle =
      parent.title !== null && parent.title.length > 0
        ? `${parent.title} [edit]`
        : '[edit]';

    // We need to insert the new branch session + copy strictly-older
    // messages + append the edited assistant message in a single
    // transaction so a partial failure doesn't leave a half-baked
    // branch row.
    const insertSessionStmt = this.db.prepare(
      `INSERT INTO sessions
         (id, created_at, updated_at, project_root, title, model, backend,
          summary, parent_session_id, branch_point_message_id,
          branch_name, branch_archived)
       VALUES
         ($id, $createdAt, $updatedAt, $projectRoot, $title, $model,
          $backend, $summary, $parentId, $branchPointId, $branchName, 0)`,
    );
    // Strictly-older copy — note the absence of the inclusive `=` clause
    // present in `createBranch` so the target message itself is NOT
    // copied; the edited replacement is appended below.
    const copyPrefixStmt = this.db.prepare(
      `INSERT INTO messages
         (id, session_id, role, content, tool_name, tool_args,
          created_at, tokens_input, tokens_output, duration_ms, model)
       SELECT
          lower(hex(randomblob(16))) AS id,
          $branchId AS session_id,
          role, content, tool_name, tool_args, created_at,
          tokens_input, tokens_output, duration_ms, model
       FROM messages
       WHERE session_id = $parentId
         AND (
           created_at < $anchorCreatedAt
           OR (created_at = $anchorCreatedAt AND rowid < $anchorRowid)
         )
       ORDER BY created_at ASC, rowid ASC`,
    );
    const editedMessageId =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `asst-edit-${Date.now().toString(36)}`;
    const insertEditedStmt = this.db.prepare(
      `INSERT INTO messages
         (id, session_id, role, content, tool_name, tool_args,
          created_at, tokens_input, tokens_output, duration_ms, model)
       VALUES
         ($id, $sessionId, 'assistant', $content, NULL, NULL,
          $createdAt, NULL, NULL, NULL, NULL)`,
    );

    try {
      const tx = this.db.transaction(() => {
        insertSessionStmt.run({
          $id: branchId,
          $createdAt: now,
          $updatedAt: now,
          $projectRoot: parent.projectRoot,
          $title: branchTitle,
          $model: parent.model,
          $backend: parent.backend,
          $summary: parent.summary,
          $parentId: fromSessionId,
          // Anchor the branch point at the message just being replaced
          // so the branch metadata (breadcrumb / picker) stays honest.
          $branchPointId: messageId,
          $branchName: 'edit',
        });
        copyPrefixStmt.run({
          $branchId: branchId,
          $parentId: fromSessionId,
          $anchorCreatedAt: target.created_at,
          $anchorRowid: target.rid,
        });
        insertEditedStmt.run({
          $id: editedMessageId,
          $sessionId: branchId,
          $content: editedContent,
          // Pin to the original anchor's timestamp so the edited message
          // sorts at the same logical position the original occupied.
          $createdAt: target.created_at,
        });
      });
      tx();
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `forkAtMessage: failed to fork session ${fromSessionId}: ${msg}`,
        cause,
      );
    }

    const created = this.getSession(branchId);
    if (created === null) {
      throw new SessionDbError(
        `forkAtMessage: child session ${branchId} not found after insert`,
      );
    }
    return { session: created, editedMessageId };
  }
  // FORK-AT-MESSAGE-SECTION-END

  /**
   * Public shape returned by getBranches. One entry per related session
   * (root + every descendant) so the breadcrumb / picker can render the
   * tree without a second query.
   */
  // (Declared as a class field rather than top-level export so callers
  // import a single symbol — SessionManager.)
  // (Type alias below; see the BranchInfo / BranchTreeNode interfaces
  // at module-bottom.)

  /**
   * Return every session in the same branch family as `sessionId`.
   *
   * The family is the transitive closure of parent_session_id links —
   * we walk UP to the root, then collect every descendant. Each entry
   * carries the bookkeeping the UI needs (id, branchName, divergedAt,
   * messageCount). Archived branches are included so the picker can
   * surface them (they're marked separately via branchArchived).
   */
  getBranches(sessionId: string): BranchInfo[] {
    const rootId = this.findBranchRoot(sessionId);
    if (rootId === null) return [];
    return this.collectBranchFamily(rootId);
  }

  /**
   * Build a recursive branch tree rooted at `rootSessionId`. The caller
   * supplies the root id (usually the result of `findBranchRoot`); the
   * returned tree mirrors the children-of relation captured in
   * parent_session_id.
   */
  getBranchTree(rootSessionId: string): BranchTreeNode | null {
    const root = this.getSession(rootSessionId);
    if (root === null) return null;
    return this.buildBranchTreeNode(root);
  }

  /**
   * Find the root of the branch family containing `sessionId`. Returns
   * the session id itself for sessions with no parent. Returns null when
   * the session does not exist.
   *
   * Loop-guarded — a corrupt parent_session_id cycle (should never
   * happen since createBranch only writes existing ids) cannot lock the
   * walker into an infinite loop.
   */
  findBranchRoot(sessionId: string): string | null {
    const stmt = this.db.prepare(
      `SELECT id, parent_session_id FROM sessions WHERE id = ?`,
    );
    let currentId: string | null = sessionId;
    const seen = new Set<string>();
    while (currentId !== null) {
      if (seen.has(currentId)) {
        // Cycle — return what we have to keep the UI working rather
        // than throwing into the user's chat.
        return currentId;
      }
      seen.add(currentId);
      const row = stmt.get(currentId) as
        | { id: string; parent_session_id: string | null }
        | null
        | undefined;
      if (row === null || row === undefined) return null;
      if (row.parent_session_id === null || row.parent_session_id === '') {
        return row.id;
      }
      currentId = row.parent_session_id;
    }
    return null;
  }

  /**
   * Walk from `sessionId` up to the root collecting one BranchInfo per
   * ancestor in order [root, …, current]. Used by the breadcrumb so the
   * UI can render the chain.
   */
  getBranchChain(sessionId: string): BranchInfo[] {
    const stmt = this.db.prepare(
      `SELECT id, parent_session_id, branch_point_message_id, branch_name,
              branch_archived, title
       FROM sessions WHERE id = ?`,
    );
    const out: BranchInfo[] = [];
    let currentId: string | null = sessionId;
    const seen = new Set<string>();
    while (currentId !== null) {
      if (seen.has(currentId)) break;
      seen.add(currentId);
      const row = stmt.get(currentId) as
        | {
            id: string;
            parent_session_id: string | null;
            branch_point_message_id: string | null;
            branch_name: string | null;
            branch_archived: number | null;
            title: string | null;
          }
        | null
        | undefined;
      if (row === null || row === undefined) break;
      out.unshift({
        id: row.id,
        branchName: row.branch_name,
        title: row.title,
        parentSessionId: row.parent_session_id,
        divergedAt: row.branch_point_message_id,
        messageCount: this.getMessageCount(row.id),
        branchArchived: (row.branch_archived ?? 0) !== 0,
      });
      currentId = row.parent_session_id;
    }
    return out;
  }

  /**
   * Mark a branch as archived (soft-delete). Idempotent — re-archiving
   * an already-archived row is a no-op. Throws when the session does
   * not exist; refuses to archive a row that has no parent (you can't
   * archive a root, only a branch).
   */
  archiveBranch(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session === null) {
      throw new SessionDbError(
        `archiveBranch: session not found: ${sessionId}`,
      );
    }
    const row = this.db
      .prepare(`SELECT parent_session_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { parent_session_id: string | null } | null | undefined;
    if (row === null || row === undefined) {
      throw new SessionDbError(
        `archiveBranch: session row vanished: ${sessionId}`,
      );
    }
    if (row.parent_session_id === null || row.parent_session_id === '') {
      throw new SessionDbError(
        `archiveBranch: refusing to archive root session ${sessionId} — only branches can be archived`,
      );
    }
    try {
      this.db
        .prepare(
          `UPDATE sessions
           SET branch_archived = 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), sessionId);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SessionDbError(
        `archiveBranch: failed to archive ${sessionId}: ${msg}`,
        cause,
      );
    }
  }

  // --- internal helpers for the branches API ---

  private collectBranchFamily(rootId: string): BranchInfo[] {
    // BFS over parent_session_id so the returned list is breadth-first
    // (root → its children → grandchildren …). One query per level
    // keeps the implementation simple; for typical branch counts (low
    // single digits) the cost is negligible.
    const out: BranchInfo[] = [];
    const queue: string[] = [rootId];
    const seen = new Set<string>();
    const childStmt = this.db.prepare(
      `SELECT id FROM sessions WHERE parent_session_id = ?`,
    );
    const rowStmt = this.db.prepare(
      `SELECT id, parent_session_id, branch_point_message_id, branch_name,
              branch_archived, title
       FROM sessions WHERE id = ?`,
    );
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const row = rowStmt.get(id) as
        | {
            id: string;
            parent_session_id: string | null;
            branch_point_message_id: string | null;
            branch_name: string | null;
            branch_archived: number | null;
            title: string | null;
          }
        | null
        | undefined;
      if (row === null || row === undefined) continue;
      out.push({
        id: row.id,
        branchName: row.branch_name,
        title: row.title,
        parentSessionId: row.parent_session_id,
        divergedAt: row.branch_point_message_id,
        messageCount: this.getMessageCount(row.id),
        branchArchived: (row.branch_archived ?? 0) !== 0,
      });
      const children = childStmt.all(id) as { id: string }[];
      for (const c of children) {
        if (!seen.has(c.id)) queue.push(c.id);
      }
    }
    return out;
  }

  private buildBranchTreeNode(session: Session): BranchTreeNode {
    const row = this.db
      .prepare(
        `SELECT branch_name, branch_archived, branch_point_message_id
         FROM sessions WHERE id = ?`,
      )
      .get(session.id) as
      | {
          branch_name: string | null;
          branch_archived: number | null;
          branch_point_message_id: string | null;
        }
      | null
      | undefined;
    const children = this.db
      .prepare(`SELECT id FROM sessions WHERE parent_session_id = ?`)
      .all(session.id) as { id: string }[];
    const childNodes: BranchTreeNode[] = [];
    for (const c of children) {
      const childSession = this.getSession(c.id);
      if (childSession !== null) {
        childNodes.push(this.buildBranchTreeNode(childSession));
      }
    }
    return {
      id: session.id,
      branchName: row?.branch_name ?? null,
      title: session.title,
      divergedAt: row?.branch_point_message_id ?? null,
      branchArchived: (row?.branch_archived ?? 0) !== 0,
      messageCount: this.getMessageCount(session.id),
      children: childNodes,
    };
  }

  // BRANCHES-SECTION (end)
}

// ---------- Search helpers (module-level pure functions) ----------

/**
 * Convert raw user input into a safe FTS5 MATCH query string.
 *
 * Strategy:
 *  - Strip every character that isn't a unicode letter, digit, or
 *    whitespace. This drops FTS operators (`AND`, `OR`, `NEAR`,
 *    `^`, `"`, `(`, `)`, `*`, `-`, `:`) so users can paste arbitrary
 *    content (e.g. snippets containing quotes / dashes) without
 *    tripping the parser.
 *  - Split on whitespace; for each token, wrap in double quotes
 *    (treats it as a literal phrase) and append `*` for prefix
 *    matching. Tokens are joined with implicit AND.
 *  - Returns `null` for empty input so callers can short-circuit.
 */
export function toFtsQuery(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  // Allow unicode letters / digits / whitespace only. Everything else
  // (punctuation, FTS operators, control chars) collapses to a space.
  const cleaned = raw.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (cleaned.length === 0) return null;
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

/**
 * Clamp a caller-supplied limit into the [1, SEARCH_MAX_LIMIT] range.
 * NaN / undefined / non-positive values fall back to the default.
 */
function clampSearchLimit(raw: number | undefined): number {
  if (raw === undefined) return SEARCH_DEFAULT_LIMIT;
  if (!Number.isFinite(raw)) return SEARCH_DEFAULT_LIMIT;
  if (raw <= 0) return SEARCH_DEFAULT_LIMIT;
  return Math.min(SEARCH_MAX_LIMIT, Math.floor(raw));
}

/** Clamp an offset to a non-negative integer. */
function clampSearchOffset(raw: number | undefined): number {
  if (raw === undefined) return 0;
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * Build the SQL for `searchMessages`. The project filter is included
 * conditionally so the dominant "search everywhere" path remains a
 * single covering FTS scan.
 */
function buildSearchSql(filterByProject: boolean): string {
  const projectClause = filterByProject
    ? `AND s.project_root = $projectRoot`
    : '';
  return `
    SELECT
      f.session_id AS session_id,
      f.message_id AS message_id,
      m.role AS role,
      snippet(messages_fts, 0, '<mark>', '</mark>', '…', 32) AS snippet,
      f.rank AS rank,
      m.created_at AS created_at,
      s.title AS session_title,
      s.project_root AS project_root
    FROM messages_fts AS f
    JOIN messages AS m ON m.id = f.message_id
    JOIN sessions AS s ON s.id = f.session_id
    WHERE messages_fts MATCH $q
      ${projectClause}
    ORDER BY f.rank
    LIMIT $limit OFFSET $offset
  `;
}

/** Companion COUNT query — same JOIN + WHERE, no ORDER/LIMIT. */
function buildSearchCountSql(filterByProject: boolean): string {
  const projectClause = filterByProject
    ? `AND s.project_root = $projectRoot`
    : '';
  return `
    SELECT COUNT(*) AS cnt
    FROM messages_fts AS f
    JOIN messages AS m ON m.id = f.message_id
    JOIN sessions AS s ON s.id = f.session_id
    WHERE messages_fts MATCH $q
      ${projectClause}
  `;
}
