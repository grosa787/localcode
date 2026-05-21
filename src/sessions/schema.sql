-- LocalCode — sessions persistence schema.
-- Authoritative DDL for the SQLite database backing `SessionManager`.
-- Kept in sync with the inline SQL string in `db.ts`.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  project_root TEXT NOT NULL,
  title TEXT,
  model TEXT NOT NULL,
  backend TEXT NOT NULL,
  -- Round-4 addition: compressed chat summary injected on /resume so the
  -- model remembers what the previous session was about. Nullable for
  -- backward-compat with pre-R4 rows; added via ALTER TABLE in db.ts's
  -- runMigrations step on existing DBs.
  summary TEXT,
  -- todo_write — JSON array of current session todos. Nullable; NULL/missing rows
  -- treated as empty list. Added via ALTER TABLE migration for existing DBs.
  session_todos TEXT DEFAULT '[]',
  -- BRANCHES-SCHEMA-SECTION (start)
  -- Branching sessions — like git branches for conversations. Each branch
  -- is a new session row whose `parent_session_id` points at the parent
  -- session, `branch_point_message_id` is the last message common with
  -- the parent (everything up to & including that id is copied into the
  -- new session), and `branch_name` is the user-chosen label. All three
  -- columns nullable for backward-compat with pre-branch rows; added to
  -- existing DBs via idempotent ALTER TABLE in db.ts's runMigrations.
  parent_session_id TEXT,
  branch_point_message_id TEXT,
  branch_name TEXT,
  -- Soft-delete flag for /branch delete. Set to 1 when archived so the
  -- conversation data is preserved (data forensics, recovery) while the
  -- branch is hidden from the breadcrumb + picker. NULL/0 = live.
  branch_archived INTEGER DEFAULT 0
  -- BRANCHES-SCHEMA-SECTION (end)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_args TEXT,
  created_at INTEGER NOT NULL,
  -- Round-3 additions (nullable for backward compat with pre-existing rows).
  -- On existing DBs the columns are added via ALTER TABLE in db.ts's
  -- runMigrations step; on fresh DBs they are created inline here.
  tokens_input INTEGER,
  tokens_output INTEGER,
  duration_ms INTEGER,
  -- Name of the model that generated this message (assistant role only).
  -- Nullable so legacy rows persisted before this column existed read
  -- back as null and gracefully fall back to the current model name in
  -- the UI label. Added to existing DBs via ALTER TABLE in db.ts's
  -- runMigrations step.
  model TEXT,
  -- COST-PERSIST-SECTION
  -- Per-message USD cost, computed via the OpenRouter-aware resolver
  -- + `computeCostBreakdown` at addMessage time (see SessionManager).
  -- NULL for rows where pricing was unknown or the row is non-assistant.
  -- Aggregators (`getUsageStats`, `aggregateUsageBySession`) prefer
  -- this persisted value over re-resolving prices on every dashboard
  -- open. Idempotent ALTER TABLE in db.ts brings existing DBs up.
  -- COST-PERSIST-SECTION-END
  cost_usd REAL,
  -- COST-PERSIST-SECTION
  -- Prompt tokens served from the provider's prefix cache (Anthropic's
  -- cache_read_input_tokens or OpenAI/OpenRouter's
  -- prompt_tokens_details.cached_tokens). Nullable.
  cached_input_tokens INTEGER,
  -- Tokens written into the prefix cache by THIS turn (Anthropic only).
  -- Nullable.
  cache_creation_tokens INTEGER
  -- COST-PERSIST-SECTION-END
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- ROADMAP #4 — lazy pagination. The session-scoped composite
-- (session_id, created_at DESC, id) covers `getMessages(sid, { limit })`
-- and `loadOlderMessages(sid, beforeId)` so that "scroll up to load
-- older" UX in the chat overlay does not have to scan all messages.
-- Idempotent: re-runs on already-upgraded DBs are a no-op.
CREATE INDEX IF NOT EXISTS idx_messages_session_created_id
  ON messages(session_id, created_at DESC, id);

-- Session-history full-text search (FTS5).
--
-- Mirrors the textual `messages.content` column so the SPA's session-
-- search overlay can run MATCH queries across every persisted chat.
-- `session_id` and `message_id` are carried as UNINDEXED metadata so
-- JOINs back to `sessions` (for title/project) are a cheap rowid
-- lookup. Tokenizer: porter stemmer over unicode61 with diacritics
-- folded — gives reasonable cross-language behaviour (Cyrillic,
-- Latin-with-accents, …) without per-language tuning.
--
-- The AFTER triggers below keep this table in lock-step with messages
-- INSERT / UPDATE / DELETE. On first open of a pre-existing database,
-- `db.ts::backfillFtsIndex` indexes historical rows once (idempotent).
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
