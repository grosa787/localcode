/**
 * SessionManager — aggregateUsageByModel / aggregateUsageBySession.
 *
 * Verifies the new TUI-dashboard aggregates produce correct sums,
 * exclude sub-agent rows, and sort top sessions by cost desc.
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

function makeMessage(
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

describe('aggregateUsageByModel', () => {
  test('sums input/output per distinct model and counts sessions', () => {
    const s1 = sm.createSession('/proj', 'gpt-4o', 'openai');
    const s2 = sm.createSession('/proj', 'gpt-4o', 'openai');
    sm.addMessage(s1.id, makeMessage('assistant', 'a', {
      tokensInput: 100,
      tokensOutput: 50,
      model: 'gpt-4o',
    }));
    sm.addMessage(s1.id, makeMessage('assistant', 'b', {
      tokensInput: 200,
      tokensOutput: 80,
      model: 'gpt-4o',
    }));
    sm.addMessage(s2.id, makeMessage('assistant', 'c', {
      tokensInput: 300,
      tokensOutput: 120,
      model: 'claude-3.5-sonnet',
    }));

    const rows = sm.aggregateUsageByModel();
    const gpt = rows.find((r) => r.model === 'gpt-4o');
    const claude = rows.find((r) => r.model === 'claude-3.5-sonnet');
    expect(gpt).toBeDefined();
    expect(claude).toBeDefined();
    expect(gpt?.inputTokens).toBe(300);
    expect(gpt?.outputTokens).toBe(130);
    expect(gpt?.sessions).toBe(1);
    expect(claude?.inputTokens).toBe(300);
    expect(claude?.outputTokens).toBe(120);
    expect(claude?.sessions).toBe(1);
  });

  test('excludes sub-agent sessions (.agent. in id)', () => {
    const parent = sm.createSession('/proj', 'gpt-4o', 'openai');
    // Sub-agent session: id contains `.agent.`
    const subId = `${parent.id}.agent.worker1`;
    sm.createSession('/proj', 'gpt-4o', 'openai', { id: subId });
    sm.addMessage(parent.id, makeMessage('assistant', 'a', {
      tokensInput: 100,
      tokensOutput: 50,
      model: 'gpt-4o',
    }));
    sm.addMessage(subId, makeMessage('assistant', 'b', {
      tokensInput: 999,
      tokensOutput: 999,
      model: 'gpt-4o',
    }));

    const rows = sm.aggregateUsageByModel();
    const gpt = rows.find((r) => r.model === 'gpt-4o');
    expect(gpt?.inputTokens).toBe(100);
    expect(gpt?.outputTokens).toBe(50);
  });

  test('empty database returns empty array', () => {
    const rows = sm.aggregateUsageByModel();
    expect(rows).toEqual([]);
  });

  test('null model defaults to "unknown"', () => {
    const s = sm.createSession('/proj', 'x', 'ollama');
    sm.addMessage(s.id, makeMessage('assistant', 'a', {
      tokensInput: 10,
      tokensOutput: 5,
    }));
    const rows = sm.aggregateUsageByModel();
    expect(rows[0]?.model).toBe('unknown');
  });
});

describe('aggregateUsageBySession', () => {
  test('sorts by cost descending with limit', () => {
    const expensive = sm.createSession('/proj', 'claude-3-opus', 'anthropic');
    const cheap = sm.createSession('/proj', 'gpt-4o-mini', 'openai');
    sm.updateTitle(expensive.id, 'Expensive');
    sm.updateTitle(cheap.id, 'Cheap');
    sm.addMessage(expensive.id, makeMessage('assistant', 'a', {
      tokensInput: 100_000,
      tokensOutput: 50_000,
      model: 'claude-3-opus',
    }));
    sm.addMessage(cheap.id, makeMessage('assistant', 'b', {
      tokensInput: 100_000,
      tokensOutput: 50_000,
      model: 'gpt-4o-mini',
    }));

    const rows = sm.aggregateUsageBySession(10);
    expect(rows.length).toBe(2);
    expect(rows[0]?.title).toBe('Expensive');
    expect(rows[1]?.title).toBe('Cheap');
    expect(rows[0]?.totalCost).toBeGreaterThan(rows[1]?.totalCost ?? 0);
  });

  test('respects the limit', () => {
    for (let i = 0; i < 5; i += 1) {
      const s = sm.createSession('/proj', 'gpt-4o', 'openai');
      sm.addMessage(s.id, makeMessage('assistant', 'a', {
        tokensInput: 1000 * (i + 1),
        tokensOutput: 100,
        model: 'gpt-4o',
      }));
    }
    const rows = sm.aggregateUsageBySession(3);
    expect(rows.length).toBe(3);
  });

  test('excludes sub-agent rows', () => {
    const parent = sm.createSession('/proj', 'gpt-4o', 'openai');
    const subId = `${parent.id}.agent.worker1`;
    sm.createSession('/proj', 'gpt-4o', 'openai', { id: subId });
    sm.addMessage(subId, makeMessage('assistant', 'a', {
      tokensInput: 999,
      tokensOutput: 999,
      model: 'gpt-4o',
    }));
    sm.addMessage(parent.id, makeMessage('assistant', 'b', {
      tokensInput: 10,
      tokensOutput: 5,
      model: 'gpt-4o',
    }));

    const rows = sm.aggregateUsageBySession();
    expect(rows.length).toBe(1);
    expect(rows[0]?.sessionId).toBe(parent.id);
  });

  test('dominant model — picks the model with most turns', () => {
    const s = sm.createSession('/proj', 'gpt-4o', 'openai');
    sm.addMessage(s.id, makeMessage('assistant', 'a', {
      tokensInput: 10,
      tokensOutput: 5,
      model: 'gpt-4o',
    }));
    sm.addMessage(s.id, makeMessage('assistant', 'b', {
      tokensInput: 10,
      tokensOutput: 5,
      model: 'gpt-4o',
    }));
    sm.addMessage(s.id, makeMessage('assistant', 'c', {
      tokensInput: 1000,
      tokensOutput: 1000,
      model: 'claude-3.5-sonnet',
    }));

    const rows = sm.aggregateUsageBySession();
    expect(rows[0]?.model).toBe('gpt-4o');
  });
});
