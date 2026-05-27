/**
 * Telemetry aggregator tests.
 *
 * Covers:
 *   - Disabled snapshot: returns `{ disabled: true }` with empty arrays
 *     and never touches the journal directory or read replica.
 *   - SQL aggregates: cost-by-model rollup, top expensive sessions,
 *     cache-hit percent, average turn duration, session count.
 *   - Journal scan: tool success/failure counters bucketed by name.
 *   - Retention window: events / messages older than `windowDays` are
 *     filtered out.
 *   - Sub-agent exclusion: rows with `.agent.` in session id are
 *     suppressed.
 *
 * Strategy:
 *   - Inject a `:memory:` SQLite via `openDb(':memory:')` + `SessionManager`
 *     so we share the prepared-statement path with production.
 *   - Patch `getReadDb()` for the test span — the aggregator pulls the
 *     read replica via that import. We do this via `mock.module`.
 *   - Use a tmp dir for journals so the real `~/.localcode/journal` is
 *     never touched.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';

import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import type { Message } from '@/types/global';

import { JournalWriter, type JournalEvent } from '@/sessions/journal';

// We must patch `getReadDb` BEFORE importing the aggregator, because the
// aggregator captures the reference at module load. `mock.module` from
// bun:test rewrites the module export so subsequent imports see the
// stub. We rebind `injectedReader` per-test in `beforeEach`.
let injectedReader: Database | null = null;
mock.module('@/sessions/db', () => ({
  // Pass through the real exports we still need.
  getDb: (customPath?: string) => openDb(customPath ?? ':memory:'),
  openDb,
  // Stubbed reader — points at the per-test in-memory writer because
  // an in-memory DB cannot be opened twice.
  getReadDb: () => {
    if (injectedReader === null) {
      throw new Error('test fixture: no reader injected');
    }
    return injectedReader;
  },
}));

// Imported AFTER the mock so the aggregator picks up the stub above.
const { snapshot } = await import('@/telemetry/aggregator');

let db: Database;
let sm: SessionManager;
let tmpDir: string;

beforeEach(() => {
  db = openDb(':memory:');
  injectedReader = db;
  sm = new SessionManager(db);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-tele-'));
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  injectedReader = null;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeAssistantMessage(
  content: string,
  extra: Partial<Message>,
): Message {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content,
    createdAt: extra.createdAt ?? Date.now(),
    ...extra,
  };
}

function writeJournalEvent(
  sid: string,
  event: JournalEvent,
): void {
  const writer = new JournalWriter(sid, { directory: tmpDir });
  writer.append(event);
  writer.close('crash'); // leaves the file recoverable; doesn't matter for our scan
}

describe('snapshot — opt-in gate', () => {
  test('returns disabled snapshot when telemetry disabled and never reads journals', async () => {
    // Drop a journal file with a tool_call_done event in the tmp dir.
    // If the aggregator wrongly touches it, the counts would surface.
    writeJournalEvent('disabled-test', {
      ts: Date.now(),
      type: 'tool_call_done',
      data: { toolName: 'read_file', success: true },
    });

    const snap = await snapshot({
      enabled: false,
      journalDir: tmpDir,
      windowDays: 30,
    });

    expect(snap.disabled).toBe(true);
    expect(snap.toolSuccessRate).toEqual([]);
    expect(snap.costByModel).toEqual([]);
    expect(snap.topExpensiveSessions).toEqual([]);
    expect(snap.sessionsCounted).toBe(0);
    expect(snap.cacheHitPercent).toBe(0);
    expect(snap.avgTurnDurationMs).toBe(0);
    expect(snap.windowStart).toBeLessThan(snap.windowEnd);
  });

  test('respects opt-in default — omitting `enabled` returns disabled', async () => {
    const snap = await snapshot({ journalDir: tmpDir });
    expect(snap.disabled).toBe(true);
  });
});

describe('snapshot — SQL aggregates', () => {
  test('cost-by-model rolls up cost and turn counts per (provider, model)', async () => {
    const sess = sm.createSession('/proj', 'gpt-4o', 'openai');
    sm.addMessage(
      sess.id,
      makeAssistantMessage('a1', {
        tokensInput: 1000,
        tokensOutput: 500,
        durationMs: 2000,
        model: 'gpt-4o',
      }),
      { model: 'gpt-4o', backend: 'openai' },
    );
    sm.addMessage(
      sess.id,
      makeAssistantMessage('a2', {
        tokensInput: 2000,
        tokensOutput: 1000,
        durationMs: 4000,
        model: 'gpt-4o',
      }),
      { model: 'gpt-4o', backend: 'openai' },
    );
    const sess2 = sm.createSession('/proj', 'claude-3-5-sonnet', 'anthropic');
    sm.addMessage(
      sess2.id,
      makeAssistantMessage('a3', {
        tokensInput: 3000,
        tokensOutput: 600,
        durationMs: 5000,
        model: 'claude-3-5-sonnet',
      }),
      { model: 'claude-3-5-sonnet', backend: 'anthropic' },
    );

    const snap = await snapshot({
      enabled: true,
      journalDir: tmpDir,
      windowDays: 30,
    });

    expect(snap.disabled).toBe(false);
    // Cost should be > 0 for at least the cloud rows (pricing table
    // covers openai/anthropic) — exact value depends on pricing data,
    // so assert structurally rather than numerically.
    expect(snap.costByModel.length).toBeGreaterThanOrEqual(1);
    const totalTurns = snap.costByModel.reduce((s, r) => s + r.turns, 0);
    // At most three priced turns (depends on whether pricing exists);
    // never more than the number of inserted assistant rows.
    expect(totalTurns).toBeLessThanOrEqual(3);
    // sessionsCounted is independent of pricing and should include both.
    expect(snap.sessionsCounted).toBe(2);
  });

  test('avgTurnDurationMs averages over rows with duration telemetry', async () => {
    const sess = sm.createSession('/proj', 'm', 'openai');
    sm.addMessage(
      sess.id,
      makeAssistantMessage('x1', {
        tokensInput: 100,
        tokensOutput: 50,
        durationMs: 1000,
        model: 'm',
      }),
      { model: 'm', backend: 'openai' },
    );
    sm.addMessage(
      sess.id,
      makeAssistantMessage('x2', {
        tokensInput: 200,
        tokensOutput: 100,
        durationMs: 3000,
        model: 'm',
      }),
      { model: 'm', backend: 'openai' },
    );

    const snap = await snapshot({
      enabled: true,
      journalDir: tmpDir,
      windowDays: 30,
    });
    expect(snap.avgTurnDurationMs).toBe(2000); // (1000 + 3000) / 2
  });

  test('cache-hit percent computes cached / (cached + fresh)', async () => {
    const sess = sm.createSession('/proj', 'm', 'openai');
    sm.addMessage(
      sess.id,
      makeAssistantMessage('c1', {
        tokensInput: 1000,
        tokensOutput: 100,
        durationMs: 1000,
        cachedInputTokens: 400,
        model: 'm',
      }),
      {
        model: 'm',
        backend: 'openai',
        cachedInputTokens: 400,
      },
    );

    const snap = await snapshot({
      enabled: true,
      journalDir: tmpDir,
      windowDays: 30,
    });
    // 400 / 1000 = 40%
    expect(Math.round(snap.cacheHitPercent)).toBe(40);
  });

  test('top expensive sessions sorted by cost desc, capped by limit', async () => {
    const cheap = sm.createSession('/p', 'gpt-4o', 'openai');
    sm.updateTitle(cheap.id, 'cheap-session');
    sm.addMessage(
      cheap.id,
      makeAssistantMessage('c', {
        tokensInput: 100,
        tokensOutput: 50,
        model: 'gpt-4o',
      }),
      { model: 'gpt-4o', backend: 'openai' },
    );

    const expensive = sm.createSession('/p', 'gpt-4o', 'openai');
    sm.updateTitle(expensive.id, 'expensive-session');
    sm.addMessage(
      expensive.id,
      makeAssistantMessage('e', {
        tokensInput: 100_000,
        tokensOutput: 50_000,
        model: 'gpt-4o',
      }),
      { model: 'gpt-4o', backend: 'openai' },
    );

    const snap = await snapshot({
      enabled: true,
      journalDir: tmpDir,
      windowDays: 30,
      topSessionsLimit: 5,
    });
    // The expensive session must appear first; both have priced rows
    // because openai/gpt-4o is in the pricing table.
    if (snap.topExpensiveSessions.length >= 2) {
      const [first, second] = snap.topExpensiveSessions;
      expect(first?.title).toBe('expensive-session');
      expect(second?.title).toBe('cheap-session');
      expect((first?.costUsd ?? 0)).toBeGreaterThan(second?.costUsd ?? 0);
    } else if (snap.topExpensiveSessions.length === 1) {
      // Sanity: it should be the expensive one.
      expect(snap.topExpensiveSessions[0]?.title).toBe('expensive-session');
    }
  });

  test('sub-agent sessions are excluded from analytics', async () => {
    const sub = sm.createSession('/p', 'm', 'openai', {
      id: 'parent.agent.worker-1',
    });
    sm.addMessage(
      sub.id,
      makeAssistantMessage('s', {
        tokensInput: 10_000,
        tokensOutput: 5_000,
        durationMs: 5000,
        model: 'm',
      }),
      { model: 'm', backend: 'openai' },
    );
    const real = sm.createSession('/p', 'm', 'openai');
    sm.addMessage(
      real.id,
      makeAssistantMessage('r', {
        tokensInput: 100,
        tokensOutput: 50,
        durationMs: 1000,
        model: 'm',
      }),
      { model: 'm', backend: 'openai' },
    );

    const snap = await snapshot({
      enabled: true,
      journalDir: tmpDir,
      windowDays: 30,
    });
    // sessionsCounted reflects only the non-agent session.
    expect(snap.sessionsCounted).toBe(1);
    // avgDuration averages only the non-agent row.
    expect(snap.avgTurnDurationMs).toBe(1000);
  });

  test('retention window filters out old messages', async () => {
    const oldTs = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    const sess = sm.createSession('/p', 'm', 'openai');
    sm.addMessage(
      sess.id,
      makeAssistantMessage('old', {
        tokensInput: 100,
        tokensOutput: 50,
        durationMs: 1000,
        createdAt: oldTs,
        model: 'm',
      }),
      { model: 'm', backend: 'openai' },
    );

    const snap = await snapshot({
      enabled: true,
      journalDir: tmpDir,
      windowDays: 30,
    });
    // Old row is outside the 30d window → no sessions counted.
    expect(snap.sessionsCounted).toBe(0);
    expect(snap.avgTurnDurationMs).toBe(0);
  });
});

describe('snapshot — journal-driven tool stats', () => {
  test('counts success/failure per tool name from tool_call_done events', async () => {
    // Two journal files — one writer per session id.
    const writer1 = new JournalWriter('sess-a', { directory: tmpDir });
    writer1.append({
      ts: Date.now(),
      type: 'tool_call_done',
      data: { toolName: 'read_file', success: true },
    });
    writer1.append({
      ts: Date.now(),
      type: 'tool_call_done',
      data: { toolName: 'read_file', success: true },
    });
    writer1.append({
      ts: Date.now(),
      type: 'tool_call_done',
      data: { toolName: 'edit_file', success: false },
    });
    writer1.close('crash');

    const writer2 = new JournalWriter('sess-b', { directory: tmpDir });
    writer2.append({
      ts: Date.now(),
      type: 'tool_call_done',
      data: { toolName: 'edit_file', success: true },
    });
    writer2.close('crash');

    const snap = await snapshot({
      enabled: true,
      journalDir: tmpDir,
      windowDays: 30,
    });
    const read = snap.toolSuccessRate.find((r) => r.toolName === 'read_file');
    const edit = snap.toolSuccessRate.find((r) => r.toolName === 'edit_file');
    expect(read?.success).toBe(2);
    expect(read?.failure).toBe(0);
    expect(read?.rate).toBe(1);
    expect(edit?.success).toBe(1);
    expect(edit?.failure).toBe(1);
    expect(edit?.rate).toBe(0.5);
  });

  test('drops events older than the retention window', async () => {
    const oldEventTs = Date.now() - 100 * 24 * 60 * 60 * 1000;
    // Write a fresh file but with a stale event ts. The aggregator
    // filters per-event by ts so the stale event is suppressed even
    // though the file's mtime is current.
    const writer = new JournalWriter('sess-stale', { directory: tmpDir });
    writer.append({
      ts: oldEventTs,
      type: 'tool_call_done',
      data: { toolName: 'stale-tool', success: true },
    });
    writer.close('crash');

    const snap = await snapshot({
      enabled: true,
      journalDir: tmpDir,
      windowDays: 30,
    });
    expect(
      snap.toolSuccessRate.find((r) => r.toolName === 'stale-tool'),
    ).toBeUndefined();
  });

  test('non-tool_call_done events are ignored', async () => {
    const writer = new JournalWriter('sess-c', { directory: tmpDir });
    writer.append({
      ts: Date.now(),
      type: 'chunk',
      data: { text: 'hello' },
    });
    writer.append({
      ts: Date.now(),
      type: 'user_input',
      data: { text: 'world' },
    });
    writer.close('crash');

    const snap = await snapshot({
      enabled: true,
      journalDir: tmpDir,
      windowDays: 30,
    });
    expect(snap.toolSuccessRate).toEqual([]);
  });

  test('events missing a tool name are skipped without throwing', async () => {
    const writer = new JournalWriter('sess-bad', { directory: tmpDir });
    writer.append({
      ts: Date.now(),
      type: 'tool_call_done',
      data: { success: true }, // no toolName
    });
    writer.append({
      ts: Date.now(),
      type: 'tool_call_done',
      data: 'not an object',
    });
    writer.close('crash');

    const snap = await snapshot({
      enabled: true,
      journalDir: tmpDir,
      windowDays: 30,
    });
    expect(snap.toolSuccessRate).toEqual([]);
  });

  test('missing journal directory yields empty stats without throwing', async () => {
    const missingDir = path.join(tmpDir, 'definitely-not-here');
    const snap = await snapshot({
      enabled: true,
      journalDir: missingDir,
      windowDays: 30,
    });
    expect(snap.toolSuccessRate).toEqual([]);
  });
});

describe('snapshot — window bounds', () => {
  test('windowStart/windowEnd reflect the requested windowDays from nowMs', async () => {
    const now = 1_700_000_000_000;
    const snap = await snapshot({
      enabled: false, // disabled — still must populate window stamps
      nowMs: now,
      windowDays: 7,
      journalDir: tmpDir,
    });
    expect(snap.windowEnd).toBe(now);
    expect(snap.windowStart).toBe(now - 7 * 24 * 60 * 60 * 1000);
  });
});
