/**
 * COST-PERSIST-SECTION — round-trip per-message cost through addMessage.
 *
 * Verifies that an assistant row with token telemetry + a known model
 * has its `cost_usd` computed via the OpenRouter-aware resolver and
 * persisted into the SQLite column. The aggregateUsageBySession
 * accumulator must then report a non-zero rolled-up cost without
 * reaching for the legacy `computeCost` fallback.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
    /* ignore */
  }
  db = null;
});

function makeAssistant(content: string): Message {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content,
    createdAt: Date.now(),
  };
}

describe('addMessage — cost persistence', () => {
  test('assistant row gets cost_usd computed and round-trips via getAllMessages', () => {
    // gpt-4o-mini in the static table is 0.15 input / 0.6 output per 1M.
    // 10000 input + 5000 output → 0.0015 + 0.003 = 0.0045 USD.
    const session = sm.createSession('/proj', 'gpt-4o-mini', 'openai');
    const msg = makeAssistant('hello world');
    sm.addMessage(session.id, msg, {
      tokensInput: 10_000,
      tokensOutput: 5_000,
      durationMs: 1500,
      model: 'gpt-4o-mini',
      backend: 'openai',
    });

    // Persisted value visible to readers.
    const rows = sm.getAllMessages(session.id);
    expect(rows.length).toBe(1);
    const persisted = rows[0]!;
    expect(persisted.cost).toBeDefined();
    expect(persisted.cost).toBeGreaterThan(0);
    expect(persisted.cost).toBeCloseTo(0.0045, 6);

    // The in-memory Message object was also mutated so live callers
    // (chat-runtime → toWire fan-out) see the cost without re-reading
    // from disk.
    expect(msg.cost).toBeDefined();
    expect(msg.cost).toBeCloseTo(0.0045, 6);
  });

  test('aggregateUsageBySession sums the persisted per-row cost', () => {
    const session = sm.createSession('/proj', 'gpt-4o-mini', 'openai');
    sm.addMessage(session.id, makeAssistant('one'), {
      tokensInput: 10_000,
      tokensOutput: 5_000,
      model: 'gpt-4o-mini',
      backend: 'openai',
    });
    sm.addMessage(session.id, makeAssistant('two'), {
      tokensInput: 20_000,
      tokensOutput: 10_000,
      model: 'gpt-4o-mini',
      backend: 'openai',
    });

    const agg = sm.aggregateUsageBySession();
    expect(agg.length).toBe(1);
    const row = agg[0]!;
    expect(row.sessionId).toBe(session.id);
    // 0.0045 + 0.009 = 0.0135 (modulo rounding).
    expect(row.totalCost).toBeGreaterThan(0);
    expect(row.totalCost).toBeCloseTo(0.0135, 4);
    expect(row.inputTokens).toBe(30_000);
    expect(row.outputTokens).toBe(15_000);
  });

  test('cached + cache-creation tokens persist alongside cost', () => {
    const session = sm.createSession(
      '/proj',
      'anthropic/claude-3.5-sonnet',
      'anthropic',
    );
    sm.addMessage(session.id, makeAssistant('hi'), {
      tokensInput: 10_000,
      tokensOutput: 1_000,
      cachedInputTokens: 5_000,
      cacheCreationTokens: 2_000,
      model: 'anthropic/claude-3.5-sonnet',
      backend: 'anthropic',
    });

    const persisted = sm.getAllMessages(session.id)[0]!;
    expect(persisted.cachedInputTokens).toBe(5_000);
    expect(persisted.cacheCreationTokens).toBe(2_000);
    expect(persisted.cost).toBeGreaterThan(0);
  });

  test('local-provider row leaves cost_usd null', () => {
    const session = sm.createSession('/proj', 'qwen2.5-coder', 'ollama');
    sm.addMessage(session.id, makeAssistant('local'), {
      tokensInput: 1_000,
      tokensOutput: 500,
      model: 'qwen2.5-coder',
      backend: 'ollama',
    });

    const persisted = sm.getAllMessages(session.id)[0]!;
    expect(persisted.cost).toBeUndefined();
  });
});
