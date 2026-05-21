/**
 * Tests for getTodos / setTodos on SessionManager.
 *
 * Covers:
 *   - Roundtrip: setTodos then getTodos returns the same list
 *   - Unknown session returns empty array
 *   - Migration adds column to existing DB without losing rows
 *   - Invalid JSON returns empty array (Zod safeParse fallback)
 */

import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb } from '../../src/sessions/db';
import { SessionManager } from '../../src/sessions/session-manager';
import type { Todo } from '../../src/sessions/session-manager';

function makeDb() {
  return openDb(':memory:');
}

function makeManager(db: ReturnType<typeof makeDb>) {
  return new SessionManager(db);
}

function createTestSession(mgr: SessionManager): string {
  const sess = mgr.createSession('/tmp/test', 'test-model', 'ollama');
  return sess.id;
}

// ---------- Tests ----------

test('getTodos returns empty array for unknown session', () => {
  const db = makeDb();
  const mgr = makeManager(db);
  const result = mgr.getTodos('no-such-session');
  expect(result).toEqual([]);
});

test('getTodos returns empty array for session with no todos set', () => {
  const db = makeDb();
  const mgr = makeManager(db);
  const sid = createTestSession(mgr);
  expect(mgr.getTodos(sid)).toEqual([]);
});

test('setTodos then getTodos roundtrip', () => {
  const db = makeDb();
  const mgr = makeManager(db);
  const sid = createTestSession(mgr);

  const todos: Todo[] = [
    { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
    { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
    { content: 'Deploy', status: 'completed', activeForm: 'Deploying' },
  ];

  mgr.setTodos(sid, todos);
  const retrieved = mgr.getTodos(sid);

  expect(retrieved).toHaveLength(3);
  expect(retrieved[0]?.content).toBe('Write tests');
  expect(retrieved[0]?.status).toBe('pending');
  expect(retrieved[1]?.status).toBe('in_progress');
  expect(retrieved[2]?.status).toBe('completed');
});

test('setTodos replaces previous list', () => {
  const db = makeDb();
  const mgr = makeManager(db);
  const sid = createTestSession(mgr);

  mgr.setTodos(sid, [
    { content: 'Old task', status: 'pending', activeForm: 'Doing Old task' },
  ]);
  mgr.setTodos(sid, [
    { content: 'New task', status: 'completed', activeForm: 'Doing New task' },
  ]);

  const retrieved = mgr.getTodos(sid);
  expect(retrieved).toHaveLength(1);
  expect(retrieved[0]?.content).toBe('New task');
});

test('setTodos empty array clears the list', () => {
  const db = makeDb();
  const mgr = makeManager(db);
  const sid = createTestSession(mgr);

  mgr.setTodos(sid, [{ content: 'T', status: 'pending', activeForm: 'Doing T' }]);
  mgr.setTodos(sid, []);
  expect(mgr.getTodos(sid)).toEqual([]);
});

test('getTodos returns empty array when stored JSON is malformed', () => {
  const db = makeDb();
  const mgr = makeManager(db);
  const sid = createTestSession(mgr);

  // Directly corrupt the DB row to inject bad JSON
  db.run(`UPDATE sessions SET session_todos = 'not-valid-json' WHERE id = ?`, [sid]);

  const result = mgr.getTodos(sid);
  expect(result).toEqual([]);
});

test('getTodos returns empty array when stored JSON has wrong shape', () => {
  const db = makeDb();
  const mgr = makeManager(db);
  const sid = createTestSession(mgr);

  // Valid JSON but wrong shape (array of strings, not Todo objects)
  db.run(`UPDATE sessions SET session_todos = '["a","b"]' WHERE id = ?`, [sid]);

  const result = mgr.getTodos(sid);
  expect(result).toEqual([]);
});

test('migration: session_todos column exists on fresh DB', () => {
  const db = makeDb();
  // PRAGMA table_info returns rows for each column
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  const names = cols.map((c) => c.name);
  expect(names).toContain('session_todos');
});

test('migration: existing rows keep their data when column is added', () => {
  // Simulate a pre-migration DB that has no session_todos column
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = MEMORY');

  // Create the old schema WITHOUT session_todos
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      project_root TEXT NOT NULL,
      title TEXT,
      model TEXT NOT NULL,
      backend TEXT NOT NULL,
      summary TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_name TEXT,
      tool_args TEXT,
      created_at INTEGER NOT NULL,
      tokens_input INTEGER,
      tokens_output INTEGER,
      duration_ms INTEGER,
      model TEXT
    )
  `);

  const sid = 'migration-test-session';
  db.run(
    `INSERT INTO sessions (id, created_at, updated_at, project_root, title, model, backend, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sid, Date.now(), Date.now(), '/tmp', 'test session', 'model', 'ollama', null],
  );

  // Now open via openDb logic — but we can't use openDb directly since it
  // creates a new DB. Instead run the migration SQL directly to simulate what
  // runMigrations does.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN session_todos TEXT DEFAULT '[]'");
  } catch {
    // duplicate column — already present, that's fine
  }

  // Verify the existing row is still intact
  const row = db.prepare("SELECT title, session_todos FROM sessions WHERE id = ?")
    .get(sid) as { title: string; session_todos: string | null };

  expect(row.title).toBe('test session');
  // The default clause applies to new inserts; for the existing row the
  // value is NULL (SQLite behaviour for ALTER TABLE ADD COLUMN DEFAULT).
  // Our getTodos handles null gracefully.
  expect(row.session_todos === null || row.session_todos === '[]').toBe(true);
});
