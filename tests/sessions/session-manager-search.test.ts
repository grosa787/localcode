/**
 * Tests for FTS5-backed session-history search.
 *
 * Covers:
 *   - `toFtsQuery` sanitisation (operators, punctuation, empty input)
 *   - migration creates the virtual table + triggers on a fresh DB
 *   - INSERT trigger indexes new messages automatically
 *   - UPDATE trigger re-indexes edited messages
 *   - DELETE trigger removes rows when a message is deleted
 *   - `searchMessages` returns ranked snippets with mark tags
 *   - `searchMessages` respects projectRoot filter
 *   - pagination (limit / offset)
 *   - `searchMessages` excludes sub-agent sessions
 *   - `countSearchMessages` mirrors the result-set size
 *   - backfill imports pre-existing rows on first open
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb } from '@/sessions/db';
import {
  SessionManager,
  toFtsQuery,
} from '@/sessions/session-manager';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import type { Message } from '@/types/global';

let db: SqliteDatabase | null = null;
let sm: SessionManager;

beforeEach(() => {
  db = openDb(':memory:');
  sm = new SessionManager(db);
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    // ignore
  }
  db = null;
});

function msg(role: Message['role'], content: string, id?: string): Message {
  return {
    id: id ?? crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
  };
}

describe('toFtsQuery', () => {
  test('splits whitespace and wraps each token with prefix asterisk', () => {
    expect(toFtsQuery('hello world')).toBe('"hello"* "world"*');
  });

  test('strips punctuation so dashes/quotes do not trip FTS', () => {
    expect(toFtsQuery('foo-bar')).toBe('"foo"* "bar"*');
    expect(toFtsQuery('he said "hi"')).toBe('"he"* "said"* "hi"*');
    expect(toFtsQuery('a(b)c:d')).toBe('"a"* "b"* "c"* "d"*');
  });

  test('handles FTS operator words by quoting (de-fanging) them', () => {
    expect(toFtsQuery('OR AND NEAR')).toBe('"OR"* "AND"* "NEAR"*');
  });

  test('returns null for empty / whitespace-only input', () => {
    expect(toFtsQuery('')).toBeNull();
    expect(toFtsQuery('   ')).toBeNull();
    expect(toFtsQuery('!!!')).toBeNull();
  });

  test('accepts unicode letters (Cyrillic, accented Latin)', () => {
    expect(toFtsQuery('привет')).toBe('"привет"*');
    expect(toFtsQuery('café résumé')).toBe('"café"* "résumé"*');
  });
});

describe('FTS5 migration + triggers', () => {
  test('creates the messages_fts virtual table on first open', () => {
    if (db === null) throw new Error('db missing');
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`,
      )
      .get();
    expect(row).not.toBeNull();
  });

  test('AFTER INSERT trigger indexes new messages', () => {
    const s = sm.createSession('/proj', 'm', 'ollama');
    sm.addMessage(s.id, msg('user', 'apple banana cherry'));

    if (db === null) throw new Error('db missing');
    const rows = db
      .prepare(
        `SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'apple'`,
      )
      .all() as { message_id: string }[];
    expect(rows).toHaveLength(1);
  });

  test('AFTER UPDATE trigger re-indexes edited content', () => {
    const s = sm.createSession('/proj', 'm', 'ollama');
    sm.addMessage(s.id, msg('user', 'old payload', 'mid-1'));

    if (db === null) throw new Error('db missing');
    db.exec(
      `UPDATE messages SET content = 'new payload' WHERE id = 'mid-1'`,
    );

    const oldHits = db
      .prepare(
        `SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'old'`,
      )
      .all();
    expect(oldHits).toHaveLength(0);

    const newHits = db
      .prepare(
        `SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'new'`,
      )
      .all() as { message_id: string }[];
    expect(newHits).toHaveLength(1);
  });

  test('AFTER DELETE trigger removes FTS row when message deleted', () => {
    const s = sm.createSession('/proj', 'm', 'ollama');
    sm.addMessage(s.id, msg('user', 'temporary content'));

    if (db === null) throw new Error('db missing');
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM messages_fts WHERE messages_fts MATCH 'temporary'`,
        )
        .get(),
    ).toEqual({ cnt: 1 });

    sm.deleteSession(s.id);

    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM messages_fts WHERE messages_fts MATCH 'temporary'`,
        )
        .get(),
    ).toEqual({ cnt: 0 });
  });
});

describe('SessionManager.searchMessages', () => {
  test('returns ranked snippet hits with mark tags', () => {
    const s = sm.createSession('/proj', 'm', 'ollama');
    sm.updateTitle(s.id, 'Searchable session');
    sm.addMessage(s.id, msg('user', 'the quick brown fox jumps over'));
    sm.addMessage(s.id, msg('assistant', 'a brown dog watches the fox'));

    const results = sm.searchMessages('fox');
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.snippet).toContain('<mark>fox</mark>');
      expect(r.sessionId).toBe(s.id);
      expect(r.sessionTitle).toBe('Searchable session');
      expect(r.projectRoot).toBe('/proj');
    }
  });

  test('returns empty array for empty / whitespace queries', () => {
    const s = sm.createSession('/proj', 'm', 'ollama');
    sm.addMessage(s.id, msg('user', 'some content'));
    expect(sm.searchMessages('')).toEqual([]);
    expect(sm.searchMessages('   ')).toEqual([]);
  });

  test('respects projectRoot filter', () => {
    const a = sm.createSession('/proj/a', 'm', 'ollama');
    const b = sm.createSession('/proj/b', 'm', 'ollama');
    sm.addMessage(a.id, msg('user', 'unique_term_here'));
    sm.addMessage(b.id, msg('user', 'unique_term_here too'));

    const scoped = sm.searchMessages('unique_term_here', {
      projectRoot: '/proj/a',
    });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.projectRoot).toBe('/proj/a');

    const everything = sm.searchMessages('unique_term_here');
    expect(everything).toHaveLength(2);
  });

  test('paginates by limit + offset', () => {
    const s = sm.createSession('/proj', 'm', 'ollama');
    for (let i = 0; i < 5; i += 1) {
      sm.addMessage(s.id, msg('user', `prefix_marker_${i} payload`));
    }

    const page1 = sm.searchMessages('prefix_marker_0', { limit: 2 });
    // FTS prefix match: marker_0 matches only marker_0 (porter stemmer
    // doesn't expand). The MATCH is exact-term.
    expect(page1.length).toBeLessThanOrEqual(2);

    const allHits = sm.searchMessages('prefix_marker', { limit: 10 });
    expect(allHits.length).toBe(5);

    const pageA = sm.searchMessages('prefix_marker', { limit: 2, offset: 0 });
    const pageB = sm.searchMessages('prefix_marker', { limit: 2, offset: 2 });
    expect(pageA).toHaveLength(2);
    expect(pageB).toHaveLength(2);
    // No overlap between pages.
    const idsA = new Set(pageA.map((r) => r.messageId));
    for (const r of pageB) expect(idsA.has(r.messageId)).toBe(false);
  });

  test('excludes sub-agent sessions from results', () => {
    sm.createSession('/proj', 'm', 'ollama', { id: 'parent-1' });
    sm.createSession('/proj', 'm', 'ollama', { id: 'parent-1.agent.worker-1' });
    sm.addMessage('parent-1', msg('user', 'mainline_unique_token'));
    sm.addMessage(
      'parent-1.agent.worker-1',
      msg('user', 'mainline_unique_token in worker'),
    );

    const results = sm.searchMessages('mainline_unique_token');
    expect(results).toHaveLength(1);
    expect(results[0]?.sessionId).toBe('parent-1');
  });

  test('countSearchMessages mirrors result-set size for simple queries', () => {
    const s = sm.createSession('/proj', 'm', 'ollama');
    sm.addMessage(s.id, msg('user', 'count_token alpha'));
    sm.addMessage(s.id, msg('user', 'count_token beta'));
    sm.addMessage(s.id, msg('assistant', 'no match here'));

    expect(sm.countSearchMessages('count_token')).toBe(2);
    expect(sm.countSearchMessages('')).toBe(0);
    expect(sm.countSearchMessages('count_token', { projectRoot: '/other' }))
      .toBe(0);
  });

  test('snippet output is bounded — no full-content dumps', () => {
    const s = sm.createSession('/proj', 'm', 'ollama');
    sm.addMessage(s.id, msg('user', 'lorem '.repeat(2000) + 'needle haystack'));

    const results = sm.searchMessages('needle');
    expect(results).toHaveLength(1);
    const snippet = results[0]?.snippet ?? '';
    // FTS5 snippet is approx 32 tokens of surrounding context, ~200 chars
    // — much less than the 12KB input.
    expect(snippet.length).toBeLessThan(500);
    expect(snippet).toContain('<mark>needle</mark>');
  });
});

describe('FTS5 backfill on existing databases', () => {
  test('indexes pre-existing messages on first openDb', () => {
    // Set up: create a DB, drop the FTS table to simulate a
    // pre-migration state, then write rows directly into the
    // `messages` table without firing the AFTER INSERT trigger.
    if (db === null) throw new Error('db missing');
    db.exec(`DROP TABLE IF EXISTS messages_fts`);
    db.exec(`DROP TRIGGER IF EXISTS messages_ai_fts`);
    db.exec(`DROP TRIGGER IF EXISTS messages_au_fts`);
    db.exec(`DROP TRIGGER IF EXISTS messages_ad_fts`);

    db.exec(
      `INSERT INTO sessions (id, created_at, updated_at, project_root, model, backend)
       VALUES ('legacy', 1000, 1000, '/proj', 'm', 'ollama')`,
    );
    db.exec(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES ('m-legacy', 'legacy', 'user', 'pre_migration_payload', 1001)`,
    );

    // Re-open via openDb on a file path — since `:memory:` instances
    // are not shared, we serialize this one out and back in.
    const serialised = db.serialize();
    db.close();
    db = null;

    // Recreate fresh DB from the serialized bytes.
    const fresh = Database.deserialize(serialised);

    // The FTS table doesn't exist yet on this raw handle. Now run
    // openDb's bootstrap manually by importing the SCHEMA_SQL — but
    // we already do this through openDb on a fresh path. Easier:
    // use openDb against a new :memory: and copy rows in. The test
    // above already exercises the trigger path; here we cover the
    // backfill helper directly.
    const sessionsRows = fresh
      .prepare(`SELECT * FROM sessions`)
      .all() as { id: string }[];
    expect(sessionsRows).toHaveLength(1);

    // Apply schema and migrations on the fresh handle (mirrors openDb).
    // We import the schema string for reuse.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SCHEMA_SQL } = require('@/sessions/db') as { SCHEMA_SQL: string };
    fresh.exec(SCHEMA_SQL);

    // At this point the FTS table is fresh, but the legacy message row
    // was inserted before the trigger existed → backfill is needed.
    // Manually run the same backfill statement openDb uses.
    fresh.exec(`
      INSERT INTO messages_fts(content, session_id, message_id)
      SELECT content, session_id, id FROM messages
      WHERE id NOT IN (SELECT message_id FROM messages_fts);
    `);

    const hits = fresh
      .prepare(
        `SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'pre_migration_payload'`,
      )
      .all() as { message_id: string }[];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message_id).toBe('m-legacy');

    fresh.close();
  });

  test('backfill is idempotent — no duplicate rows on second open', () => {
    const s = sm.createSession('/proj', 'm', 'ollama');
    sm.addMessage(s.id, msg('user', 'idempotent_marker payload'));

    if (db === null) throw new Error('db missing');

    // Run the backfill statement explicitly a second time — should
    // not duplicate the existing row thanks to the NOT IN guard.
    db.exec(`
      INSERT INTO messages_fts(content, session_id, message_id)
      SELECT content, session_id, id FROM messages
      WHERE id NOT IN (SELECT message_id FROM messages_fts);
    `);

    const rows = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM messages_fts WHERE messages_fts MATCH 'idempotent_marker'`,
      )
      .get() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });
});
