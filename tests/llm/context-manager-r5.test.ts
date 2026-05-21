/**
 * R5 additions to ContextManager (FIX #34 — `/compress`):
 *   - `compress(summarizer, opts?)` — replace older messages with one
 *     dense summary message tagged `[Compressed context]`.
 *   - `buildCompressPrompt(messages)` — pure helper that emits the
 *     "HIGH-COMPRESSION" instruction header + per-message U:/A:/T() lines.
 *   - System prompt addendum mentioning the `[Compressed context]` cue.
 */
import { describe, test, expect } from 'bun:test';
import {
  ContextManager,
  buildCompressPrompt,
} from '@/llm/context-manager';
import type { Message } from '@/types/global';

// ---------- helpers ----------

function mkMessage(
  role: Message['role'],
  content: string,
  id?: string,
  toolName?: string,
): Message {
  const m: Message = {
    id: id ?? `m-${Math.random().toString(36).slice(2, 10)}`,
    role,
    content,
    createdAt: Date.now(),
  };
  if (toolName !== undefined) m.toolName = toolName;
  return m;
}

// ---------- ContextManager.compress ----------

describe('ContextManager.compress — empty context', () => {
  test('returns 0/0/0 and empty summary', async () => {
    const cm = new ContextManager();
    let summarizerCalls = 0;
    const result = await cm.compress(async () => {
      summarizerCalls += 1;
      return 'should not run';
    });
    expect(result.oldCount).toBe(0);
    expect(result.newCount).toBe(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.summary).toBe('');
    expect(summarizerCalls).toBe(0);
  });
});

describe('ContextManager.compress — default keepLast (0)', () => {
  test('replaces all 10 messages with a single [Compressed context] summary', async () => {
    const cm = new ContextManager();
    for (let i = 0; i < 10; i += 1) {
      cm.add(
        mkMessage(
          i % 2 === 0 ? 'user' : 'assistant',
          `message body ${i}`.repeat(8),
          `id-${i}`,
        ),
      );
    }
    expect(cm.getMessages()).toHaveLength(10);

    const captured: { messages: Message[] | null } = { messages: null };
    const result = await cm.compress(async (msgs) => {
      captured.messages = msgs;
      return 'DENSE-SUMMARY';
    });

    expect(result.oldCount).toBe(10);
    expect(result.newCount).toBe(1);
    expect(captured.messages?.length).toBe(10);

    const live = cm.getMessages();
    expect(live).toHaveLength(1);
    expect(live[0]?.role).toBe('assistant');
    expect(live[0]?.content).toContain('[Compressed context]');
    expect(live[0]?.content).toContain('DENSE-SUMMARY');
    expect(result.summary).toBe('DENSE-SUMMARY');
    expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
  });
});

describe('ContextManager.compress — keepLast preserves recent messages', () => {
  test('keepLast: 2 → newCount = 3 (1 summary + 2 kept)', async () => {
    const cm = new ContextManager();
    for (let i = 0; i < 10; i += 1) {
      cm.add(
        mkMessage('user', `msg ${i}`, `id-${i}`),
      );
    }

    const result = await cm.compress(
      async () => 'short summary',
      { keepLast: 2 },
    );
    expect(result.oldCount).toBe(10);
    expect(result.newCount).toBe(3);

    const live = cm.getMessages();
    expect(live).toHaveLength(3);
    // First message is the summary marker.
    expect(live[0]?.content).toContain('[Compressed context]');
    // Last two are the originals (id-8, id-9).
    expect(live[1]?.id).toBe('id-8');
    expect(live[2]?.id).toBe('id-9');
  });

  test('keepLast >= length → no-op (history untouched)', async () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'a', 'a'));
    cm.add(mkMessage('user', 'b', 'b'));
    let summarizerCalls = 0;
    const result = await cm.compress(
      async () => {
        summarizerCalls += 1;
        return 'unused';
      },
      { keepLast: 99 },
    );
    expect(result.oldCount).toBe(2);
    expect(result.newCount).toBe(2);
    expect(result.tokensSaved).toBe(0);
    expect(summarizerCalls).toBe(0);
    expect(cm.getMessages().map((m) => m.id)).toEqual(['a', 'b']);
  });

  test('empty/whitespace summary leaves history untouched', async () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'a', 'a'));
    cm.add(mkMessage('user', 'b', 'b'));
    const result = await cm.compress(async () => '   \n\t ');
    expect(result.oldCount).toBe(2);
    expect(result.newCount).toBe(2);
    expect(result.summary).toBe('');
    expect(cm.getMessages().map((m) => m.id)).toEqual(['a', 'b']);
  });

  test('summarizer that throws propagates error and leaves state intact', async () => {
    const cm = new ContextManager();
    cm.add(mkMessage('user', 'a', 'a'));
    cm.add(mkMessage('user', 'b', 'b'));
    let threw = false;
    try {
      await cm.compress(async () => {
        throw new Error('summariser boom');
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toContain('summariser boom');
    }
    expect(threw).toBe(true);
    // History is preserved.
    expect(cm.getMessages().map((m) => m.id)).toEqual(['a', 'b']);
  });
});

// ---------- buildCompressPrompt (pure helper) ----------

describe('buildCompressPrompt', () => {
  test('includes HIGH-COMPRESSION header', () => {
    const prompt = buildCompressPrompt([
      mkMessage('user', 'hello'),
    ]);
    expect(prompt).toContain('HIGH-COMPRESSION');
  });

  test('renders user messages with `U:` tag', () => {
    const prompt = buildCompressPrompt([
      mkMessage('user', 'first request'),
    ]);
    expect(prompt).toContain('U: first request');
  });

  test('renders assistant messages with `A:` tag', () => {
    const prompt = buildCompressPrompt([
      mkMessage('assistant', 'sure thing'),
    ]);
    expect(prompt).toContain('A: sure thing');
  });

  test('renders tool messages with `T(<tool>):` tag', () => {
    const prompt = buildCompressPrompt([
      mkMessage('tool', 'tool result body', 'tm-1', 'read_file'),
    ]);
    expect(prompt).toContain('T(read_file): tool result body');
  });

  test('preserves message order in the rendered transcript', () => {
    const prompt = buildCompressPrompt([
      mkMessage('user', 'first', 'a'),
      mkMessage('assistant', 'second', 'b'),
      mkMessage('user', 'third', 'c'),
    ]);
    const idxFirst = prompt.indexOf('first');
    const idxSecond = prompt.indexOf('second');
    const idxThird = prompt.indexOf('third');
    expect(idxFirst).toBeGreaterThan(-1);
    expect(idxSecond).toBeGreaterThan(idxFirst);
    expect(idxThird).toBeGreaterThan(idxSecond);
  });

  test('empty input still produces a valid prompt with header', () => {
    const prompt = buildCompressPrompt([]);
    expect(prompt).toContain('HIGH-COMPRESSION');
  });
});

// ---------- buildSystemPrompt mentions [Compressed context] cue ----------

describe('ContextManager.buildSystemPrompt — [Compressed context] addendum', () => {
  test('mentions the [Compressed context] cue so the model can recognise compressed history', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('[Compressed context]');
  });

  test('cue is present even when no project / skills / summary supplied', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt(null, []);
    expect(prompt).toContain('[Compressed context]');
  });
});
