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

describe('ContextManager.add / getMessages', () => {
  test('round-trips a single message', () => {
    const cm = new ContextManager();
    const msg = mkMessage('user', 'hello');
    cm.add(msg);
    expect(cm.getMessages()).toEqual([msg]);
  });

  test('returns a defensive copy', () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'a'));
    const snapshot = cm.getMessages();
    snapshot.push(mkMessage('assistant', 'b'));
    expect(cm.getMessages()).toHaveLength(1);
  });

  test('addMany appends in order', () => {
    const cm = new ContextManager();
    cm.addMany([mkMessage('user', 'a'), mkMessage('assistant', 'b')]);
    const msgs = cm.getMessages();
    expect(msgs.map((m) => m.content)).toEqual(['a', 'b']);
  });

  test('clear empties message list', () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'x'));
    cm.clear();
    expect(cm.getMessages()).toEqual([]);
  });

  test('replaceAll swaps the entire list', () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'old'));
    cm.replaceAll([mkMessage('assistant', 'new')]);
    expect(cm.getMessages().map((m) => m.content)).toEqual(['new']);
  });
});

describe('ContextManager.getTokenCount / getContextPercent', () => {
  test('empty manager has zero tokens', () => {
    const cm = new ContextManager();
    expect(cm.getTokenCount()).toBe(0);
  });

  test('token count increases with message content', () => {
    const cm = new ContextManager();
    const before = cm.getTokenCount();
    cm.add(mkMessage('user', 'a much longer user message used to bump the count'));
    expect(cm.getTokenCount()).toBeGreaterThan(before);
  });

  test('percent returns ratio relative to max', () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'abcd'.repeat(20))); // ~20 tokens
    const percent = cm.getContextPercent(200);
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThan(1);
  });

  test('getUsage returns both tokenCount and percent', () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'hello'));
    const usage = cm.getUsage(1000);
    expect(usage.tokenCount).toBeGreaterThan(0);
    expect(usage.percent).toBe(usage.tokenCount / 1000);
  });
});

describe('ContextManager.maybeSummarize', () => {
  test('returns false when no summarizer is configured', async () => {
    const cm = new ContextManager();
    for (let i = 0; i < 20; i += 1) cm.add(mkMessage('user', 'x'.repeat(500)));
    const ran = await cm.maybeSummarize(100);
    expect(ran).toBe(false);
  });

  test('summarises older messages, keeps last N verbatim', async () => {
    let summarizerCalls = 0;
    let receivedCount = 0;
    const cm = new ContextManager({
      summarizer: async (msgs) => {
        summarizerCalls += 1;
        receivedCount = msgs.length;
        return 'SUMMARY-OK';
      },
      summarizeAtPercent: 0.1,
      keepLastN: 5,
    });
    for (let i = 0; i < 20; i += 1) {
      cm.add(mkMessage('user', `m${i}-${'x'.repeat(200)}`, `id-${i}`));
    }

    const ran = await cm.maybeSummarize(1000);
    expect(ran).toBe(true);
    expect(summarizerCalls).toBe(1);
    // 20 messages - 5 kept = 15 summarised
    expect(receivedCount).toBe(15);

    const msgs = cm.getMessages();
    expect(msgs).toHaveLength(6); // 1 summary + 5 kept
    expect(msgs[0]?.content.startsWith('[Previous context summary]: ')).toBe(true);
    expect(msgs[1]?.id).toBe('id-15');
    expect(msgs[5]?.id).toBe('id-19');
  });

  test('does not summarise when under threshold', async () => {
    let called = false;
    const cm = new ContextManager({
      summarizer: async () => {
        called = true;
        return 'X';
      },
      summarizeAtPercent: 0.99,
      keepLastN: 2,
    });
    for (let i = 0; i < 3; i += 1) cm.add(mkMessage('user', 'hi'));
    const ran = await cm.maybeSummarize(10_000);
    expect(ran).toBe(false);
    expect(called).toBe(false);
  });

  test('fires onSummarized callback with savedTokens', async () => {
    let saved = -1;
    const cm = new ContextManager({
      summarizer: async () => 'short summary',
      summarizeAtPercent: 0.1,
      keepLastN: 2,
      onSummarized: (s) => {
        saved = s;
      },
    });
    for (let i = 0; i < 10; i += 1) cm.add(mkMessage('user', 'x'.repeat(400)));
    await cm.maybeSummarize(500);
    expect(saved).toBeGreaterThan(0);
  });

  test('summariser exception leaves history untouched', async () => {
    const cm = new ContextManager({
      summarizer: async () => {
        throw new Error('boom');
      },
      summarizeAtPercent: 0.1,
      keepLastN: 2,
    });
    for (let i = 0; i < 5; i += 1) cm.add(mkMessage('user', 'x'.repeat(400), `id-${i}`));
    const before = cm.getMessages();
    const ran = await cm.maybeSummarize(100);
    expect(ran).toBe(false);
    expect(cm.getMessages()).toEqual(before);
  });
});

describe('ContextManager.buildSystemPrompt', () => {
  const skill = (active: boolean, content = 'body', id = 's'): Skill => ({
    id,
    name: id,
    description: '',
    content,
    active,
    path: `/tmp/${id}.md`,
  });

  test('includes base prompt when no md and no skills', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt(null, []);
    expect(prompt).toContain(SYSTEM_PROMPT_BASE);
    expect(prompt).not.toContain('[PROJECT CONTEXT]');
    expect(prompt).not.toContain('[ACTIVE SKILLS]');
  });

  test('includes [PROJECT CONTEXT] when LOCALCODE.md is non-empty', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt('# README\nHello', []);
    expect(prompt).toContain('[PROJECT CONTEXT]');
    expect(prompt).toContain('# README');
  });

  test('includes [ACTIVE SKILLS] only for active, non-empty skills', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt(null, [
      skill(true, 'ACTIVE1'),
      skill(false, 'INACTIVE', 'i'),
      skill(true, '   ', 'empty'),
    ]);
    expect(prompt).toContain('[ACTIVE SKILLS]');
    expect(prompt).toContain('ACTIVE1');
    expect(prompt).not.toContain('INACTIVE');
  });

  test('omits skills section when nothing active', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt(null, [skill(false)]);
    expect(prompt).not.toContain('[ACTIVE SKILLS]');
  });
});
