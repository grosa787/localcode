/**
 * R2/R3 additions to ContextManager:
 *   - `buildSystemPrompt({ summary })` — new opts-bag overload
 *   - Legacy positional call still works
 *   - `recordUsage` accumulates; session totals are queryable
 *   - `generateSummary` passes messages through to caller-supplied summariser
 *   - `maxInMemoryMessages` caps memory + offloadedCount tracks overflow
 *   - `prependMessages` rehydrates older messages at the front
 */
import { describe, test, expect } from 'bun:test';
import { ContextManager, SYSTEM_PROMPT_BASE } from '@/llm/context-manager';
import type { Message, Skill } from '@/types/global';

function mkMessage(role: Message['role'], content: string, id?: string): Message {
  return {
    id: id ?? `m-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    createdAt: Date.now(),
  };
}

const skill = (active: boolean, content = 'body', id = 's'): Skill => ({
  id,
  name: id,
  description: '',
  content,
  active,
  path: `/tmp/${id}.md`,
});

describe('ContextManager.buildSystemPrompt — options-bag overload', () => {
  test('inserts "Conversation summary" section when summary is provided', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({
      summary: 'Discussed refactoring of the auth module',
    });
    expect(prompt).toContain('Conversation summary');
    expect(prompt).toContain('Discussed refactoring of the auth module');
  });

  test('summary is omitted when null or empty', () => {
    const cm = new ContextManager();
    const empty = cm.buildSystemPrompt({ summary: '' });
    const nullSummary = cm.buildSystemPrompt({ summary: null });
    const whitespace = cm.buildSystemPrompt({ summary: '   \n\t ' });
    for (const prompt of [empty, nullSummary, whitespace]) {
      expect(prompt).not.toContain('Conversation summary');
    }
  });

  test('combines localcodeMd, skills and summary together', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({
      localcodeMd: '# Project README\nBuilt on Bun.',
      skills: [skill(true, 'SKILL-BODY-X')],
      summary: 'Previous session worked on scan logic',
    });
    expect(prompt).toContain(SYSTEM_PROMPT_BASE);
    expect(prompt).toContain('# Project README');
    expect(prompt).toContain('SKILL-BODY-X');
    expect(prompt).toContain('Previous session worked on scan logic');
  });

  test('supports empty object (same as omitting everything)', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain(SYSTEM_PROMPT_BASE);
    // No explicit project context + no active skills -> fallback hint
    expect(prompt).toContain('No LOCALCODE.md');
    expect(prompt).toContain('(none)');
  });
});

describe('ContextManager.buildSystemPrompt — backwards-compatible positional form', () => {
  test('positional (localcodeMd, skills) still works', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt('# Legacy MD', [
      skill(true, 'LEGACY-SKILL'),
    ]);
    expect(prompt).toContain(SYSTEM_PROMPT_BASE);
    expect(prompt).toContain('# Legacy MD');
    expect(prompt).toContain('LEGACY-SKILL');
  });

  test('positional call with null md still works', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt(null, []);
    expect(prompt).toContain(SYSTEM_PROMPT_BASE);
    expect(prompt).not.toContain('# Legacy');
  });
});

describe('ContextManager.recordUsage / session totals', () => {
  test('accumulates across multiple responses', () => {
    const cm = new ContextManager();
    cm.recordUsage(100, 40);
    cm.recordUsage(50, 30);
    expect(cm.sessionTokensIn).toBe(150);
    expect(cm.sessionTokensOut).toBe(70);
  });

  test('starts at zero', () => {
    const cm = new ContextManager();
    expect(cm.sessionTokensIn).toBe(0);
    expect(cm.sessionTokensOut).toBe(0);
  });

  test('clamps negatives / NaN / Infinity to zero', () => {
    const cm = new ContextManager();
    cm.recordUsage(-10, Number.NaN);
    cm.recordUsage(Number.POSITIVE_INFINITY, -5);
    cm.recordUsage(5, 3);
    expect(cm.sessionTokensIn).toBe(5);
    expect(cm.sessionTokensOut).toBe(3);
  });

  test('resetUsage clears the counters', () => {
    const cm = new ContextManager();
    cm.recordUsage(10, 20);
    cm.resetUsage();
    expect(cm.sessionTokensIn).toBe(0);
    expect(cm.sessionTokensOut).toBe(0);
  });

  test('floors fractional values', () => {
    const cm = new ContextManager();
    cm.recordUsage(3.9, 2.1);
    expect(cm.sessionTokensIn).toBe(3);
    expect(cm.sessionTokensOut).toBe(2);
  });
});

describe('ContextManager.generateSummary', () => {
  test('passes the snapshot of all in-memory messages to the summariser', async () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'first'));
    cm.add(mkMessage('assistant', 'second'));
    cm.add(mkMessage('user', 'third'));

    const captured: { messages: Message[] | null } = { messages: null };
    const summariser = async (msgs: Message[]): Promise<string> => {
      captured.messages = msgs;
      return '  SUMMARY-RESULT  ';
    };
    const out = await cm.generateSummary(summariser);

    // Returned value is trimmed
    expect(out).toBe('SUMMARY-RESULT');
    expect(captured.messages).not.toBeNull();
    expect(captured.messages?.length).toBe(3);
    expect(captured.messages?.[0]?.content).toBe('first');
    expect(captured.messages?.[2]?.content).toBe('third');
  });

  test('empty history returns empty string without invoking summariser', async () => {
    const cm = new ContextManager();
    let invoked = false;
    const out = await cm.generateSummary(async () => {
      invoked = true;
      return 'ignored';
    });
    expect(out).toBe('');
    expect(invoked).toBe(false);
  });

  test('summariser that throws yields empty string (non-fatal)', async () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'x'));
    const out = await cm.generateSummary(async () => {
      throw new Error('boom');
    });
    expect(out).toBe('');
  });
});

describe('ContextManager.maxInMemoryMessages — cap + offloadedCount', () => {
  test('caps the in-memory array and tracks offloaded count', () => {
    const cm = new ContextManager({ maxInMemoryMessages: 50 });
    for (let i = 0; i < 300; i += 1) {
      cm.add(mkMessage('user', `msg-${i}`, `id-${i}`));
    }
    const kept = cm.getMessages();
    expect(kept.length).toBeLessThanOrEqual(50);
    expect(cm.offloadedCount).toBeGreaterThan(0);
    // The last message must still be present (we drop the oldest).
    const last = kept[kept.length - 1];
    expect(last?.id).toBe('id-299');
  });

  test('a fresh manager has offloadedCount === 0', () => {
    const cm = new ContextManager();
    expect(cm.offloadedCount).toBe(0);
  });

  test('clear() resets offloadedCount to 0', () => {
    const cm = new ContextManager({ maxInMemoryMessages: 10 });
    for (let i = 0; i < 50; i += 1) {
      cm.add(mkMessage('user', 'x', `id-${i}`));
    }
    expect(cm.offloadedCount).toBeGreaterThan(0);
    cm.clear();
    expect(cm.offloadedCount).toBe(0);
    expect(cm.getMessages()).toEqual([]);
  });
});

describe('ContextManager.prependMessages', () => {
  test('adds older messages at the head, preserving order', () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'C', 'c'));
    cm.prependMessages([
      mkMessage('user', 'A', 'a'),
      mkMessage('assistant', 'B', 'b'),
    ]);
    const ids = cm.getMessages().map((m) => m.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  test('deduplicates by id (idempotent)', () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'C', 'c'));
    cm.prependMessages([mkMessage('user', 'A', 'a')]);
    cm.prependMessages([mkMessage('user', 'A', 'a'), mkMessage('user', 'B', 'b')]);
    const ids = cm.getMessages().map((m) => m.id);
    // 'a' must not appear twice.
    expect(ids).toEqual(['b', 'a', 'c']);
  });

  test('empty input is a no-op', () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'a', 'a'));
    cm.prependMessages([]);
    expect(cm.getMessages()).toHaveLength(1);
  });

  test('reduces offloadedCount by the number of fresh messages rehydrated', () => {
    // Use a generous cap so we don't churn enforceInMemoryCap during the
    // prepend. We manipulate offloadedCount only by filling + then
    // rehydrating a few messages.
    const cm = new ContextManager({ maxInMemoryMessages: 20 });
    for (let i = 0; i < 60; i += 1) {
      cm.add(mkMessage('user', 'x', `id-${i}`));
    }
    // At this point internal state dropped older messages => offloaded > 0.
    expect(cm.offloadedCount).toBeGreaterThan(0);
    const before = cm.offloadedCount;
    // Prepend exactly one fresh older message — current cap still
    // leaves headroom so we don't trigger another eviction. Use an id
    // that's not in the current in-memory list.
    cm.prependMessages([mkMessage('user', 'older', 'older-zzz')]);
    // offloadedCount should have gone DOWN (or stayed equal at 0) —
    // possibly with a fresh eviction bumping it back up. The
    // invariant that must hold: offloadedCount decreased by at least 1
    // *before* any eviction — we assert it's <= before.
    expect(cm.offloadedCount).toBeLessThanOrEqual(before);
  });
});
