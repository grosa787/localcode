/**
 * BRANCHES-MIGRATIONS-SECTION — verify the idempotent ALTER TABLE
 * migrations work against:
 *   1. A fresh DB (where the columns already exist via CREATE TABLE).
 *   2. A pre-branches DB (simulated by creating the legacy schema
 *      directly, then re-opening through openDb which runs migrations).
 *
 * Re-opening an already-upgraded DB MUST be a no-op (no duplicate-
 * column error escapes).
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';

const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  project_root TEXT NOT NULL,
  title TEXT,
  model TEXT NOT NULL,
  backend TEXT NOT NULL,
  summary TEXT,
  session_todos TEXT DEFAULT '[]'
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
  model TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
`;

describe('BRANCHES-MIGRATIONS-SECTION — pre-branches DB upgrade', () => {
  test('opening a legacy DB adds parent_session_id / branch_point_message_id / branch_name / branch_archived', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'lc-br-mig-'));
    const dbPath = path.join(tmp, 'sessions.db');
    try {
      // Seed a "pre-branches" DB.
      const raw = new Database(dbPath);
      raw.exec(LEGACY_SCHEMA);
      raw.close();

      // Re-open through the production code — runs runMigrations.
      const db = openDb(dbPath);
      const cols = db
        .prepare(`PRAGMA table_info(sessions)`)
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('parent_session_id');
      expect(names).toContain('branch_point_message_id');
      expect(names).toContain('branch_name');
      expect(names).toContain('branch_archived');

      // And SessionManager works end-to-end on the upgraded DB.
      const sm = new SessionManager(db);
      const root = sm.createSession('/p', 'm', 'ollama');
      sm.addMessage(root.id, {
        id: crypto.randomUUID(),
        role: 'user',
        content: 'hi',
        createdAt: Date.now(),
      });
      const branch = sm.createBranch(root.id, 'A');
      expect(branch.id).not.toBe(root.id);

      const family = sm.getBranches(root.id).map((b) => b.id).sort();
      expect(family).toEqual([root.id, branch.id].sort());

      db.close();
    } finally {
      try {
        if (existsSync(dbPath)) rmSync(dbPath);
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test('re-opening an already-upgraded DB is a no-op (idempotent)', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'lc-br-mig2-'));
    const dbPath = path.join(tmp, 'sessions.db');
    try {
      // First open creates + upgrades.
      const db1 = openDb(dbPath);
      db1.close();

      // Second open MUST not throw "duplicate column name".
      expect(() => {
        const db2 = openDb(dbPath);
        db2.close();
      }).not.toThrow();

      // And third open with the SessionManager wrapper still works.
      const db3 = openDb(dbPath);
      const sm = new SessionManager(db3);
      const s = sm.createSession('/p', 'm', 'ollama');
      expect(s.id).toBeTruthy();
      db3.close();
    } finally {
      try {
        if (existsSync(dbPath)) rmSync(dbPath);
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe('BRANCHES-MIGRATIONS-SECTION — fresh DB has the columns', () => {
  test('a brand-new :memory: DB exposes the branch columns inline', () => {
    const db = new Database(':memory:');
    // Force the SCHEMA_SQL path by routing through SessionManager.
    void new SessionManager(openDb(':memory:'));
    db.close();
    // Sanity: openDb itself creates the columns from SCHEMA_SQL
    const fresh = openDb(':memory:');
    const cols = fresh
      .prepare(`PRAGMA table_info(sessions)`)
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('parent_session_id');
    expect(names).toContain('branch_point_message_id');
    expect(names).toContain('branch_name');
    expect(names).toContain('branch_archived');
    fresh.close();
  });
});

// Silence unused import linter warning.
void writeFileSync;
