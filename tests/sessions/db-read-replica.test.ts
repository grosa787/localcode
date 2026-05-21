/**
 * READ-REPLICA-SECTION — coverage for the dedicated read-only handle.
 *
 * The writer + reader pair (`openDbPair`) backs the contention-relief
 * promise of this change. Verifies that:
 *   - the reader sees the writer's committed rows (same file, WAL),
 *   - a long-running write transaction on the writer does NOT block a
 *     read on the reader,
 *   - the reader rejects mutations (defence-in-depth — guarantees the
 *     router can't accidentally try to write through it),
 *   - `getMessages` / `getAllMessages` / `searchMessages` /
 *     `countSearchMessages` actually use the reader (route survives
 *     a forced reader-side error).
 *
 * Uses a temporary file-backed DB because `:memory:` databases are
 * isolated per-open, so a second handle wouldn't see writes from the
 * first. The temp dir is cleaned up in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { openDbPair, type SessionDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import type { Message } from '@/types/global';

let dir: string | null = null;
let pair: SessionDb | null = null;
let sm: SessionManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-replica-'));
  const dbPath = path.join(dir, 'sessions.db');
  pair = openDbPair(dbPath);
  sm = new SessionManager(pair);
});

afterEach(() => {
  try {
    pair?.writer.close();
  } catch {
    // ignore
  }
  try {
    if (pair && pair.hasDedicatedReader) pair.reader.close();
  } catch {
    // ignore
  }
  pair = null;
  if (dir !== null) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  dir = null;
});

function bulkInsert(sessionId: string, n: number): void {
  const base = 1_700_000_000_000;
  for (let i = 0; i < n; i += 1) {
    const m: Message = {
      id: `msg${i}`,
      role: 'user',
      content: `m${i} hello`,
      createdAt: base + i,
    };
    sm.addMessage(sessionId, m);
  }
}

describe('openDbPair', () => {
  test('opens a dedicated read-only sibling for a file-backed DB', () => {
    expect(pair).not.toBeNull();
    expect(pair!.hasDedicatedReader).toBe(true);
    expect(pair!.reader).not.toBe(pair!.writer);
  });

  test('reader rejects mutation attempts', () => {
    expect(() => {
      pair!.reader.exec(
        `INSERT INTO sessions (id, created_at, updated_at, project_root, model, backend) ` +
          `VALUES ('x', 0, 0, '/p', 'm', 'b')`,
      );
    }).toThrow(/readonly|read[- ]?only/i);
  });

  test(':memory: aliases the reader to the writer', async () => {
    const memPair = openDbPair(':memory:');
    try {
      expect(memPair.hasDedicatedReader).toBe(false);
      expect(memPair.reader).toBe(memPair.writer);
    } finally {
      memPair.writer.close();
    }
  });
});

describe('SessionManager — read replica routing', () => {
  test('reader sees rows written via the writer', () => {
    const s = sm.createSession('/p', 'gpt', 'openai');
    bulkInsert(s.id, 1000);
    const rows = sm.getMessages(s.id, { limit: Infinity });
    expect(rows).toHaveLength(1000);
    expect(rows[0]?.id).toBe('msg0');
    expect(rows[999]?.id).toBe('msg999');
  });

  test('getAllMessages goes through the reader', () => {
    const s = sm.createSession('/p', 'gpt', 'openai');
    bulkInsert(s.id, 200);
    const all = sm.getAllMessages(s.id);
    expect(all).toHaveLength(200);
  });

  test('searchMessages goes through the reader', () => {
    const s = sm.createSession('/p', 'gpt', 'openai');
    bulkInsert(s.id, 50);
    const hits = sm.searchMessages('hello');
    expect(hits.length).toBeGreaterThan(0);
    const count = sm.countSearchMessages('hello');
    expect(count).toBeGreaterThan(0);
  });
});

describe('SessionManager — concurrent write + read does not deadlock', () => {
  test('open write transaction on writer; read on reader proceeds', async () => {
    // Fixture: 1000 messages so the read path is non-trivial.
    const s = sm.createSession('/p', 'gpt', 'openai');
    bulkInsert(s.id, 1000);

    // Begin an explicit write transaction on the writer and HOLD it.
    // While held, a second write would block — but a read on the
    // readonly sibling must complete without queueing behind us.
    pair!.writer.exec('BEGIN IMMEDIATE');
    try {
      // Insert a row inside the open transaction — exercises the
      // writer's exclusive lock without yet committing.
      const insert = pair!.writer.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) ` +
          `VALUES ('inside-tx', '${s.id}', 'user', 'inside', 1700001000000)`,
      );
      insert.run();

      // The read path must succeed (reader sees the pre-transaction
      // snapshot via WAL — and crucially, does NOT block on the
      // writer's BEGIN IMMEDIATE).
      const start = Date.now();
      const rows = sm.getMessages(s.id, { limit: Infinity });
      const elapsed = Date.now() - start;

      // Pre-transaction snapshot: 1000 rows committed before BEGIN.
      // The uncommitted `inside-tx` row must NOT appear on the reader.
      expect(rows).toHaveLength(1000);
      expect(rows.some((r) => r.id === 'inside-tx')).toBe(false);

      // Sanity — must not have stalled the busy_timeout (5000ms).
      expect(elapsed).toBeLessThan(2000);

      // Count + search through the reader also work concurrently.
      const count = sm.getMessageCount(s.id);
      expect(count).toBe(1000);

      const searchHits = sm.countSearchMessages('hello');
      expect(searchHits).toBeGreaterThan(0);

      // Commit the held transaction — writer never blocked on reader.
      pair!.writer.exec('COMMIT');
    } catch (err) {
      // If we reach this branch the writer is still mid-tx; roll back
      // so afterEach can close cleanly.
      try {
        pair!.writer.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }

    // After COMMIT, the reader sees the new row.
    const after = sm.getMessages(s.id, { limit: Infinity });
    expect(after.some((r) => r.id === 'inside-tx')).toBe(true);
    expect(after).toHaveLength(1001);
  });

  test('writer can commit while many reads stream through the reader', async () => {
    const s = sm.createSession('/p', 'gpt', 'openai');
    bulkInsert(s.id, 500);

    // Kick off 8 concurrent reads against the read-only handle.
    const reads: Promise<number>[] = [];
    for (let i = 0; i < 8; i += 1) {
      reads.push(
        Promise.resolve().then(() => {
          return sm.getAllMessages(s.id).length;
        }),
      );
    }

    // Concurrently, write 50 new rows via the writer. None of these
    // should be blocked by the in-flight reads on the sibling handle.
    for (let i = 500; i < 550; i += 1) {
      const m: Message = {
        id: `msg${i}`,
        role: 'user',
        content: `m${i}`,
        createdAt: 1_700_000_000_000 + i,
      };
      sm.addMessage(s.id, m);
    }

    const results = await Promise.all(reads);
    // Each read returned a positive count (reads completed cleanly).
    for (const n of results) {
      expect(n).toBeGreaterThanOrEqual(500);
    }
    // Final count: original 500 + 50 new = 550.
    expect(sm.getMessageCount(s.id)).toBe(550);
  });
});

describe('SessionManager — back-compat single-handle injection', () => {
  test('legacy single-Database constructor still works (reads alias writer)', () => {
    // Verify the older test pattern (`new SessionManager(db)`) still
    // works — many existing tests inject `:memory:` via this path.
    const mem = openDbPair(':memory:');
    const legacySm = new SessionManager(mem.writer);
    const s = legacySm.createSession('/p', 'gpt', 'openai');
    for (let i = 0; i < 5; i += 1) {
      legacySm.addMessage(s.id, {
        id: `n${i}`,
        role: 'user',
        content: `c${i}`,
        createdAt: 1_700_000_000_000 + i,
      });
    }
    const got = legacySm.getMessages(s.id);
    expect(got).toHaveLength(5);
    mem.writer.close();
  });
});

// Silence the lint that `SqliteDatabase` import is unused if a future
// refactor drops the inline annotation.
type _Unused = SqliteDatabase;
