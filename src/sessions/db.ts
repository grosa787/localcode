/**
 * SQLite database opener + singleton for LocalCode sessions.
 *
 * Responsibilities:
 * - Open a `bun:sqlite` database at `~/.localcode/sessions.db` by default.
 * - Create the parent directory if it does not yet exist.
 * - Apply pragmas (`journal_mode = WAL`, `foreign_keys = ON`).
 * - Execute the schema DDL (idempotent) on first open.
 * - Support `:memory:` for tests.
 * - Support caller-provided custom paths (e.g. for tests) while still
 *   caching one default instance as a singleton.
 *
 * Only `SessionManager` should import this file. All errors from I/O
 * or SQLite are rethrown as `SessionDbError`.
 *
 * Note: we use Bun's native `bun:sqlite` rather than `better-sqlite3`
 * because the latter has native bindings that do not load under Bun
 * (see https://github.com/oven-sh/bun/issues/4290). The API surface we
 * need (prepare / run / get / all / exec / transaction / pragma /
 * close) is compatible.
 */

import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

// ---------- Errors ----------

export class SessionDbError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SessionDbError';
  }
}

// ---------- Schema (kept in sync with schema.sql) ----------

/**
 * Inline schema mirrored from `schema.sql`. The SQL file is the
 * authoritative human-readable copy; this constant is what we actually
 * execute at runtime so we do not need to resolve a file path at runtime
 * (which is awkward when bundling with `bun build`).
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  project_root TEXT NOT NULL,
  title TEXT,
  model TEXT NOT NULL,
  backend TEXT NOT NULL,
  summary TEXT,
  -- todo_write — JSON array of current session todos.
  session_todos TEXT DEFAULT '[]',
  -- BRANCHES-SCHEMA-SECTION — branching sessions. See schema.sql for the
  -- authoritative comment block. parent_session_id links a branch to its
  -- parent; branch_point_message_id is the last message common with the
  -- parent (message prefix copied via INSERT...SELECT in createBranch).
  -- branch_archived is a soft-delete flag for /branch delete.
  parent_session_id TEXT,
  branch_point_message_id TEXT,
  branch_name TEXT,
  branch_archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_args TEXT,
  created_at INTEGER NOT NULL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  duration_ms INTEGER,
  model TEXT,
  -- COST-PERSIST-SECTION — see schema.sql.
  cost_usd REAL,
  cached_input_tokens INTEGER,
  cache_creation_tokens INTEGER
  -- COST-PERSIST-SECTION-END
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- ROADMAP #4 — covering index for lazy pagination
-- (\`getMessages\` with limit/before, \`loadOlderMessages\`). Idempotent;
-- re-running it on already-upgraded DBs is a no-op.
CREATE INDEX IF NOT EXISTS idx_messages_session_created_id
  ON messages(session_id, created_at DESC, id);

-- Session-history full-text search (FTS5).
--
-- The virtual table mirrors \`messages.content\` so the user can search
-- across every persisted chat from the SPA's session-search overlay.
-- We index ONLY the textual content; session_id + message_id are
-- carried as UNINDEXED metadata so we can JOIN back to the parent
-- session row for title/project lookups without a second lookup.
--
-- Tokenizer: \`porter unicode61\` — porter stemmer over unicode61
-- normalization. The \`remove_diacritics 2\` option folds Cyrillic /
-- Latin accent marks so a user searching "доступ" matches stored
-- "доступ" regardless of NFC/NFD form.
--
-- Triggers below keep the virtual table in lock-step with messages
-- INSERT / UPDATE / DELETE — the FTS table never needs to be rebuilt
-- by hand after the initial backfill in \`runMigrations\`.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  message_id UNINDEXED,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_ai_fts
AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts(content, session_id, message_id)
  VALUES (new.content, new.session_id, new.id);
END;

CREATE TRIGGER IF NOT EXISTS messages_au_fts
AFTER UPDATE ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(content, session_id, message_id)
  VALUES (new.content, new.session_id, new.id);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad_fts
AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
`;

/**
 * Incremental ALTER TABLE statements that bring a pre-Round-3 database
 * up to date with the current `SCHEMA_SQL`. Running any of these against
 * a fresh DB (where the columns already exist thanks to the CREATE
 * TABLE above) produces a "duplicate column name" error — which we
 * swallow on purpose in `runMigrations` below.
 *
 * New migrations may be appended here; each entry must be self-
 * contained and idempotent so re-opening an already-upgraded DB is
 * a no-op.
 */
const MIGRATIONS: readonly string[] = [
  'ALTER TABLE messages ADD COLUMN tokens_input INTEGER',
  'ALTER TABLE messages ADD COLUMN tokens_output INTEGER',
  'ALTER TABLE messages ADD COLUMN duration_ms INTEGER',
  // Round-4: compressed session summary for `/resume` context injection.
  'ALTER TABLE sessions ADD COLUMN summary TEXT',
  // Per-message model name. Lets the chat UI label each assistant
  // message with the model that actually generated it, instead of
  // retroactively relabeling history when the user switches models.
  'ALTER TABLE messages ADD COLUMN model TEXT',
  // todo_write — per-session task list stored as a JSON array.
  // Default is '[]' so getTodos() never needs to handle NULL.
  "ALTER TABLE sessions ADD COLUMN session_todos TEXT DEFAULT '[]'",
  // BRANCHES-MIGRATIONS-SECTION (start)
  // Branching sessions — see schema.sql. Three nullable columns plus
  // a soft-delete flag. Idempotent ALTER TABLE — runMigrations swallows
  // the duplicate-column error on already-upgraded DBs.
  'ALTER TABLE sessions ADD COLUMN parent_session_id TEXT',
  'ALTER TABLE sessions ADD COLUMN branch_point_message_id TEXT',
  'ALTER TABLE sessions ADD COLUMN branch_name TEXT',
  'ALTER TABLE sessions ADD COLUMN branch_archived INTEGER DEFAULT 0',
  // BRANCHES-MIGRATIONS-SECTION (end)
  // COST-PERSIST-SECTION — per-message persisted cost + extra usage
  // counters. Idempotent ALTER TABLE — runMigrations swallows the
  // duplicate-column error on already-upgraded DBs.
  'ALTER TABLE messages ADD COLUMN cost_usd REAL',
  'ALTER TABLE messages ADD COLUMN cached_input_tokens INTEGER',
  'ALTER TABLE messages ADD COLUMN cache_creation_tokens INTEGER',
  // COST-PERSIST-SECTION-END
];

/**
 * True when `err` is SQLite's "duplicate column name" error — the one
 * case we want to swallow during `runMigrations`. Everything else is
 * re-thrown so real problems (locked DB, disk full, …) surface.
 *
 * `bun:sqlite` surfaces these as plain `Error`s with the SQLite message
 * embedded, so we sniff the text. Check both the typical forms
 * `"duplicate column name: X"` and the less-common `"SQLITE_ERROR:
 * duplicate column ..."` that some versions emit.
 */
function isDuplicateColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('duplicate column');
}

/**
 * Apply each migration in order, swallowing only "duplicate column"
 * errors (which mean the column was already present — expected on
 * both fresh DBs and already-upgraded DBs).
 */
function runMigrations(db: SqliteDatabase): void {
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (cause) {
      if (isDuplicateColumnError(cause)) {
        continue;
      }
      throw cause;
    }
  }
}

/**
 * One-time backfill: index every existing `messages` row into the FTS
 * virtual table. Idempotent — the WHERE NOT IN guard ensures rows
 * already present in `messages_fts` (e.g. inserted by the AFTER INSERT
 * trigger on a fresh DB, or carried over from a prior backfill) are
 * skipped. Run unconditionally on every `openDb` so a pre-existing
 * database upgraded to this revision picks up its historical content
 * the first time it's opened.
 *
 * `bun:sqlite` lets us do the entire backfill in a single SELECT-INTO
 * style statement; no need to iterate rows from TS.
 */
function backfillFtsIndex(db: SqliteDatabase): void {
  try {
    db.exec(`
      INSERT INTO messages_fts(content, session_id, message_id)
      SELECT content, session_id, id FROM messages
      WHERE id NOT IN (SELECT message_id FROM messages_fts);
    `);
  } catch (cause) {
    // Non-fatal: if the virtual table is somehow missing (rare —
    // SCHEMA_SQL creates it) or the SELECT errors out on a malformed
    // legacy row, we don't want to brick the entire DB open. The user
    // will simply see no historical results in session search; new
    // messages will index normally via the AFTER INSERT trigger.
    const msg = cause instanceof Error ? cause.message : String(cause);
    // eslint-disable-next-line no-console
    console.warn(`[sessions/db] FTS backfill skipped: ${msg}`);
  }
}

// ---------- Defaults ----------

export const DEFAULT_DB_DIR = path.join(homedir(), '.localcode');
export const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'sessions.db');

// ---------- Read-replica pairing ----------

/**
 * A writer + dedicated read-only handle for the same on-disk database.
 *
 * `bun:sqlite` is single-connection per `Database` instance. WAL mode
 * permits one writer concurrent with many readers, but a single shared
 * handle still serialises long SELECTs behind any pending writes (and
 * vice versa). Opening a second handle with `{ readonly: true }` lets
 * heavy read paths (`getMessages`, `getAllMessages`, `searchMessages`,
 * `countSearchMessages`) issue their queries on a connection that
 * SQLite knows cannot mutate — long-running writes on the writer no
 * longer block reads, and reads on the reader cannot lock out writes.
 *
 * Invariants:
 * - Both handles point at the same file (no schema drift).
 * - The reader inherits the writer's WAL journal (same `:memory:` /
 *   filesystem rules; `:memory:` databases have a single shared handle
 *   because each `:memory:` open creates a new isolated DB).
 * - Writers must NEVER use the reader for transactions — SQLite will
 *   error `attempt to write a readonly database`. The router in
 *   `SessionManager` enforces this by routing only specific queries
 *   to `readDb`.
 */
export interface SessionDb {
  /** Read-write connection. Owns writes + transactions. */
  writer: SqliteDatabase;
  /**
   * Read-only connection over the SAME file. Aliased to `writer` when
   * the target is `:memory:` (each `:memory:` open is isolated, so a
   * second handle would not see the writer's rows).
   */
  reader: SqliteDatabase;
  /** True when `reader` is a dedicated handle rather than aliased to `writer`. */
  hasDedicatedReader: boolean;
}

// ---------- Singleton cache ----------

let cachedDefaultDb: SqliteDatabase | null = null;
let cachedDefaultReader: SqliteDatabase | null = null;

/**
 * Open a database and apply schema + pragmas. Not cached — callers that
 * want the singleton must go through `getDb()`.
 *
 * Returns the writer handle. To obtain the matched read-only sibling,
 * use {@link openDbPair} instead.
 */
export function openDb(targetPath: string): SqliteDatabase {
  try {
    if (targetPath !== ':memory:') {
      const parent = path.dirname(targetPath);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
    }

    const db = new Database(targetPath);

    // Enforce foreign keys and WAL for durable concurrent reads.
    // `:memory:` does not support WAL — fall back to `MEMORY` journal.
    // `bun:sqlite` does not expose a `.pragma()` method, so we use
    // plain `exec()` for PRAGMA statements.
    db.exec('PRAGMA foreign_keys = ON');
    if (targetPath === ':memory:') {
      db.exec('PRAGMA journal_mode = MEMORY');
    } else {
      // WAL mode — better crash safety, concurrent reads, less I/O contention.
      // Wrapped in try/catch because some platforms / network filesystems
      // may reject WAL (non-fatal — fall back to default journaling).
      try {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL'); // safe with WAL, faster than FULL
        db.exec('PRAGMA wal_autocheckpoint = 1000'); // checkpoint every 1000 pages (~4MB)
        db.exec('PRAGMA busy_timeout = 5000'); // 5s wait if locked
      } catch {
        // Non-fatal: WAL not supported on this filesystem — keep default journal.
      }
    }

    // Idempotent schema creation.
    db.exec(SCHEMA_SQL);

    // Bring pre-existing DBs (created before the Round-3 additions)
    // up to date. A fresh DB already has these columns thanks to
    // `SCHEMA_SQL`, so every ALTER will raise "duplicate column name"
    // which `runMigrations` swallows.
    runMigrations(db);

    // Backfill the FTS5 virtual table from any historical messages.
    // Idempotent (guarded by NOT IN), and cheap on a fresh DB (zero rows).
    backfillFtsIndex(db);

    return db;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new SessionDbError(`Failed to open session DB at ${targetPath}: ${msg}`, cause);
  }
}

/**
 * Open a writer + read-only sibling pair backed by the same on-disk
 * database. Used to relieve read/write contention on long sessions —
 * the reader is opened with SQLite's `SQLITE_OPEN_READONLY` flag so its
 * transactions never queue behind the writer's.
 *
 * For `:memory:` databases the reader is aliased to the writer (each
 * `:memory:` open is a fresh isolated DB; a second handle wouldn't see
 * the writer's rows). `hasDedicatedReader` distinguishes the two cases
 * so tests / diagnostics can introspect.
 *
 * The reader has `busy_timeout = 5000` set so it can briefly wait if
 * the writer is mid-commit (WAL keeps these waits microsecond-scale).
 */
export function openDbPair(targetPath: string): SessionDb {
  const writer = openDb(targetPath);
  if (targetPath === ':memory:') {
    return { writer, reader: writer, hasDedicatedReader: false };
  }
  try {
    const reader = new Database(targetPath, { readonly: true });
    // Match the writer's runtime tuning. PRAGMA on a readonly connection
    // applies to that connection only and never mutates the file.
    try {
      reader.exec('PRAGMA busy_timeout = 5000');
    } catch {
      // Non-fatal — reader still works without a custom busy timeout.
    }
    return { writer, reader, hasDedicatedReader: true };
  } catch (cause) {
    // Reader open failed — fall back to the writer so callers keep
    // working (no contention relief, but functionality unchanged).
    const msg = cause instanceof Error ? cause.message : String(cause);
    // eslint-disable-next-line no-console
    console.warn(`[sessions/db] read-only sibling open failed: ${msg}; falling back to writer`);
    return { writer, reader: writer, hasDedicatedReader: false };
  }
}

/**
 * Return a singleton database handle.
 *
 * - `getDb()` or `getDb(undefined)` returns a cached instance at
 *   `~/.localcode/sessions.db`.
 * - `getDb(customPath)` opens a fresh handle at `customPath` (not cached,
 *   so tests can open independent `:memory:` databases).
 */
export function getDb(customPath?: string): SqliteDatabase {
  if (customPath !== undefined) {
    return openDb(customPath);
  }

  if (cachedDefaultDb === null) {
    cachedDefaultDb = openDb(DEFAULT_DB_PATH);
  }
  return cachedDefaultDb;
}

/**
 * Return the cached read-only sibling for the default-path singleton.
 *
 * Lazily opened on first call. If `getDb()` has already cached a writer
 * handle (the common path: SessionManager constructor opens writer
 * first), this just adds the reader. If both are absent, both are
 * opened — they MUST point at the same file so a freshly-cached
 * default reader sees the writer's writes via WAL.
 *
 * `:memory:` is not reachable via this helper because the default
 * singleton is always file-backed.
 */
export function getReadDb(): SqliteDatabase {
  if (cachedDefaultReader === null) {
    if (cachedDefaultDb === null) {
      cachedDefaultDb = openDb(DEFAULT_DB_PATH);
    }
    try {
      cachedDefaultReader = new Database(DEFAULT_DB_PATH, { readonly: true });
      try {
        cachedDefaultReader.exec('PRAGMA busy_timeout = 5000');
      } catch {
        // best-effort
      }
    } catch (cause) {
      // Fall back to the writer if the reader cannot be opened. The
      // caller still gets a working connection; we just lose the
      // contention-relief benefit. Logged so the operator can notice.
      const msg = cause instanceof Error ? cause.message : String(cause);
      // eslint-disable-next-line no-console
      console.warn(`[sessions/db] default read-only sibling open failed: ${msg}; using writer`);
      cachedDefaultReader = cachedDefaultDb;
    }
  }
  return cachedDefaultReader;
}

/**
 * Close and clear the cached default handle. Intended for tests and
 * graceful shutdown paths.
 */
export function resetDefaultDb(): void {
  if (cachedDefaultReader !== null && cachedDefaultReader !== cachedDefaultDb) {
    try {
      cachedDefaultReader.close();
    } catch {
      // ignore — best-effort close.
    }
  }
  cachedDefaultReader = null;
  if (cachedDefaultDb !== null) {
    try {
      cachedDefaultDb.close();
    } catch {
      // ignore — best-effort close.
    }
    cachedDefaultDb = null;
  }
}
