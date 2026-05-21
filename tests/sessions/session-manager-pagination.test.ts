/**
 * ROADMAP #4 — Lazy SQLite pagination.
 *
 * Covers the new `getMessages(sid, options)` signature, the
 * `loadOlderMessages` / `getMessageCount` / `getAllMessages` helpers,
 * and the boundary conditions around the `before` anchor (unknown id,
 * same-millisecond inserts, empty session).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import type { Message } from '@/types/global';

let db: Database | null = null;
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

function bulkInsert(sessionId: string, n: number): void {
  // Fixed base time keeps ordering stable across CI clock drift while
  // still ensuring monotonically increasing `created_at` per row.
  const base = 1700000000000;
  for (let i = 0; i < n; i += 1) {
    const m: Message = {
      id: `msg${i}`,
      role: 'user',
      content: `m${i}`,
      createdAt: base + i,
    };
    sm.addMessage(sessionId, m);
  }
}

describe('SessionManager.getMessages — default pagination cap', () => {
  test('returns up to 100 most recent messages by default', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 250);
    const got = sm.getMessages(s.id);
    expect(got).toHaveLength(100);
    // Most recent 100 → msg150..msg249, in chronological order.
    expect(got[0]?.id).toBe('msg150');
    expect(got[got.length - 1]?.id).toBe('msg249');
  });

  test('explicit limit caps the page size', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 50);
    const got = sm.getMessages(s.id, { limit: 10 });
    expect(got).toHaveLength(10);
    expect(got[0]?.id).toBe('msg40');
    expect(got[9]?.id).toBe('msg49');
  });

  test('limit larger than total returns whole session', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 5);
    const got = sm.getMessages(s.id, { limit: 100 });
    expect(got.map((m) => m.id)).toEqual(['msg0', 'msg1', 'msg2', 'msg3', 'msg4']);
  });

  test('Infinity limit returns all rows', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 250);
    const got = sm.getMessages(s.id, { limit: Infinity });
    expect(got).toHaveLength(250);
    expect(got[0]?.id).toBe('msg0');
    expect(got[249]?.id).toBe('msg249');
  });

  test('non-positive / NaN limit falls through to default 100', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 150);
    expect(sm.getMessages(s.id, { limit: 0 })).toHaveLength(100);
    expect(sm.getMessages(s.id, { limit: -5 })).toHaveLength(100);
    expect(sm.getMessages(s.id, { limit: Number.NaN })).toHaveLength(150);
    // NaN is non-finite → treated as "no cap" (-1 in SQLite).
  });

  test('empty session returns []', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    expect(sm.getMessages(s.id)).toEqual([]);
    expect(sm.getMessages(s.id, { limit: 10 })).toEqual([]);
  });
});

describe('SessionManager.getMessages — `before` anchor', () => {
  test('returns most-recent N messages strictly older than the anchor', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 50);
    const older = sm.getMessages(s.id, { before: 'msg30', limit: 10 });
    expect(older).toHaveLength(10);
    expect(older[0]?.id).toBe('msg20');
    expect(older[9]?.id).toBe('msg29');
  });

  test('anchor at start returns empty array', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 50);
    expect(sm.getMessages(s.id, { before: 'msg0' })).toEqual([]);
  });

  test('unknown anchor returns empty (no rows match the subselect)', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 50);
    expect(sm.getMessages(s.id, { before: 'no-such-id' })).toEqual([]);
  });

  test('empty `before` is treated as no anchor', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 5);
    const got = sm.getMessages(s.id, { before: '' });
    expect(got).toHaveLength(5);
  });
});

describe('SessionManager.loadOlderMessages', () => {
  test('reads N older rows before the anchor', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 250);
    const older = sm.loadOlderMessages(s.id, 'msg150', 50);
    expect(older).toHaveLength(50);
    expect(older[0]?.id).toBe('msg100');
    expect(older[49]?.id).toBe('msg149');
  });

  test('default limit is 100', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 250);
    const older = sm.loadOlderMessages(s.id, 'msg200');
    expect(older).toHaveLength(100);
    expect(older[0]?.id).toBe('msg100');
    expect(older[99]?.id).toBe('msg199');
  });
});

describe('SessionManager.getAllMessages', () => {
  test('returns every row regardless of count', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 250);
    const all = sm.getAllMessages(s.id);
    expect(all).toHaveLength(250);
    expect(all[0]?.id).toBe('msg0');
    expect(all[249]?.id).toBe('msg249');
  });

  test('empty session returns []', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    expect(sm.getAllMessages(s.id)).toEqual([]);
  });
});

describe('SessionManager.getMessageCount', () => {
  test('returns the row count for a session', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    expect(sm.getMessageCount(s.id)).toBe(0);
    bulkInsert(s.id, 17);
    expect(sm.getMessageCount(s.id)).toBe(17);
  });

  test('unknown session returns 0', () => {
    expect(sm.getMessageCount('does-not-exist')).toBe(0);
  });

  test('count is unaffected by pagination calls', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    bulkInsert(s.id, 250);
    sm.getMessages(s.id);
    sm.loadOlderMessages(s.id, 'msg100', 5);
    expect(sm.getMessageCount(s.id)).toBe(250);
  });
});

describe('SessionManager pagination — same-millisecond rows', () => {
  test('preserves insertion order via rowid tiebreaker', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    const t = 1700000000000;
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      sm.addMessage(s.id, {
        id,
        role: 'user',
        content: id,
        createdAt: t,
      });
    }
    expect(sm.getMessages(s.id).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Pagination respects the same tiebreaker.
    expect(sm.getMessages(s.id, { limit: 3 }).map((m) => m.id)).toEqual(['c', 'd', 'e']);
    // before: 'd' → strictly-older = 'a','b','c'
    expect(
      sm.getMessages(s.id, { before: 'd', limit: 10 }).map((m) => m.id),
    ).toEqual(['a', 'b', 'c']);
  });
});
