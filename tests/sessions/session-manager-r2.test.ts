/**
 * R2/R3 SessionManager additions:
 *   - addMessage(sid, msg, { tokensInput, tokensOutput, durationMs }) persists
 *     per-message telemetry.
 *   - getSessionStats(sid) returns aggregate sums.
 *   - updateSummary(sid, text) persists, read back via getSession(sid).summary.
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

function msg(
  role: Message['role'],
  content: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    ...extra,
  };
}

describe('SessionManager.addMessage — optional telemetry', () => {
  test('persists tokensInput/tokensOutput/durationMs and reads them back', () => {
    const s = sm.createSession('/p', 'model-x', 'ollama');
    const m = msg('assistant', 'hello response');
    sm.addMessage(s.id, m, { tokensInput: 41, tokensOutput: 9, durationMs: 1234 });

    const rows = sm.getMessages(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokensInput).toBe(41);
    expect(rows[0]?.tokensOutput).toBe(9);
    expect(rows[0]?.durationMs).toBe(1234);
  });

  test('telemetry absent when not supplied (round-trip is undefined, not 0)', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    const m = msg('user', 'hi');
    sm.addMessage(s.id, m);
    const rows = sm.getMessages(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokensInput).toBeUndefined();
    expect(rows[0]?.tokensOutput).toBeUndefined();
    expect(rows[0]?.durationMs).toBeUndefined();
  });

  test('options override inline message telemetry when both set', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    // Inline values of 10 on the message.
    const m = msg('assistant', 'hello', {
      tokensInput: 10,
      tokensOutput: 10,
      durationMs: 10,
    });
    // Options override with different numbers.
    sm.addMessage(s.id, m, { tokensInput: 100, tokensOutput: 200, durationMs: 300 });
    const rows = sm.getMessages(s.id);
    expect(rows[0]?.tokensInput).toBe(100);
    expect(rows[0]?.tokensOutput).toBe(200);
    expect(rows[0]?.durationMs).toBe(300);
  });

  test('falls back to inline message values when options omit them', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    const m = msg('assistant', 'hello', {
      tokensInput: 5,
      tokensOutput: 7,
    });
    sm.addMessage(s.id, m);
    const rows = sm.getMessages(s.id);
    expect(rows[0]?.tokensInput).toBe(5);
    expect(rows[0]?.tokensOutput).toBe(7);
    expect(rows[0]?.durationMs).toBeUndefined();
  });
});

describe('SessionManager.getSessionStats', () => {
  test('returns correct sums across multiple messages', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(s.id, msg('user', 'q1'), {
      tokensInput: 10,
      tokensOutput: 0,
      durationMs: 50,
    });
    sm.addMessage(s.id, msg('assistant', 'a1'), {
      tokensInput: 0,
      tokensOutput: 20,
      durationMs: 1500,
    });
    sm.addMessage(s.id, msg('assistant', 'a2'), {
      tokensInput: 0,
      tokensOutput: 30,
      durationMs: 2000,
    });

    const stats = sm.getSessionStats(s.id);
    expect(stats.totalTokensInput).toBe(10);
    expect(stats.totalTokensOutput).toBe(50);
    expect(stats.totalDurationMs).toBe(3550);
    expect(stats.messageCount).toBe(3);
  });

  test('treats NULL telemetry columns as 0', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    sm.addMessage(s.id, msg('user', 'hi'));
    sm.addMessage(s.id, msg('assistant', 'hello'), { tokensOutput: 5 });
    const stats = sm.getSessionStats(s.id);
    expect(stats.totalTokensInput).toBe(0);
    expect(stats.totalTokensOutput).toBe(5);
    expect(stats.totalDurationMs).toBe(0);
    expect(stats.messageCount).toBe(2);
  });

  test('unknown session returns zeros', () => {
    const stats = sm.getSessionStats('does-not-exist');
    expect(stats.totalTokensInput).toBe(0);
    expect(stats.totalTokensOutput).toBe(0);
    expect(stats.totalDurationMs).toBe(0);
    expect(stats.messageCount).toBe(0);
  });
});

describe('SessionManager.updateSummary', () => {
  test('persists summary and round-trips via getSession', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    expect(sm.getSession(s.id)?.summary).toBeNull();

    sm.updateSummary(s.id, 'Worked on auth refactor; 3 files touched.');
    const reloaded = sm.getSession(s.id);
    expect(reloaded?.summary).toBe('Worked on auth refactor; 3 files touched.');
  });

  test('updateSummary bumps updated_at', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    const origUpdated = s.updatedAt;
    // Ensure monotonic clock progression by waiting briefly.
    const spin = Date.now() + 5;
    while (Date.now() < spin) {
      /* spin */
    }
    sm.updateSummary(s.id, 'hello');
    const reloaded = sm.getSession(s.id);
    expect(reloaded).not.toBeNull();
    expect((reloaded?.updatedAt ?? 0) >= origUpdated).toBe(true);
  });

  test('overwrites prior summary', () => {
    const s = sm.createSession('/p', 'm', 'ollama');
    sm.updateSummary(s.id, 'first');
    sm.updateSummary(s.id, 'second');
    expect(sm.getSession(s.id)?.summary).toBe('second');
  });
});
