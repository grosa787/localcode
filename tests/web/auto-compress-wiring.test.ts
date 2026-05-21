/**
 * ChatRuntime auto-compress wiring + sliding-window invocation.
 *
 * Verifies that:
 *   - The runtime calls `contextManager.maybeSummarize` after the final
 *     assistant reply when `shouldAutoCompress` returns true.
 *   - The cooldown gate prevents back-to-back triggers within
 *     `DEFAULT_AUTO_COMPRESS_COOLDOWN_MS` even when the predicate
 *     keeps firing.
 *   - The sliding window is applied to messages forwarded to
 *     `llm.streamChat` — the system prompt always rides on top, and
 *     the tail is capped to `maxRecentMessages`.
 *
 * Uses minimal fakes for the LLM, ToolExecutor, SessionManager, and
 * ContextManager — only the surface area exercised by these paths is
 * implemented.
 */

import { describe, expect, test } from 'bun:test';

import { ChatRuntime } from '@/web/runtime/chat-runtime';
import { SessionEventBus } from '@/web/runtime/event-bus';
import { ApprovalBridge } from '@/web/runtime/approval-bridge';
import { ContextManager } from '@/llm/context-manager';
import type { LLMAdapter } from '@/llm/adapter';
import type { Message } from '@/types/global';
import type { SessionManager } from '@/sessions/session-manager';
import type { ToolExecutor } from '@/llm/tool-executor';

// ---------- fakes ----------

interface FakeStreamLog {
  callCount: number;
  lastMessages: Message[];
}

function makeFakeLLM(log: FakeStreamLog): { streamChat: LLMAdapter['streamChat'] } {
  return {
    streamChat: (async (opts) => {
      log.callCount += 1;
      log.lastMessages = [...opts.messages];
      // Stream a tiny final reply with no tool calls.
      opts.onChunk?.('ok');
      opts.onDone?.({
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
      });
    }) as LLMAdapter['streamChat'],
  };
}

function makeFakeSessionManager(): SessionManager {
  return {
    addMessage: () => undefined,
    getMessages: () => [],
    getSession: () => null,
  } as unknown as SessionManager;
}

function makeFakeToolExecutor(): ToolExecutor {
  return {
    execute: async () => ({ success: true, output: '' }),
  } as unknown as ToolExecutor;
}

function makeRuntime(opts: {
  contextManager: ContextManager;
  maxContextTokens: number;
  maxRecentMessages?: number;
  autoCompressPercent?: number;
  llmLog: FakeStreamLog;
}): { runtime: ChatRuntime; events: unknown[] } {
  const events: unknown[] = [];
  const eventBus = new SessionEventBus();
  eventBus.subscribe('s1', (m) => events.push(m));
  const llm = makeFakeLLM(opts.llmLog);

  const runtime = new ChatRuntime({
    sessionId: 's1',
    tools: [],
    buildSystemMessage: () => ({
      id: 'sys-0',
      role: 'system',
      content: 'You are LocalCode.',
      createdAt: 0,
    }),
    maxContextTokens: opts.maxContextTokens,
    ...(opts.maxRecentMessages !== undefined
      ? { maxRecentMessages: opts.maxRecentMessages }
      : {}),
    ...(opts.autoCompressPercent !== undefined
      ? { autoCompressPercent: opts.autoCompressPercent }
      : {}),
    llm,
    toolExecutor: makeFakeToolExecutor(),
    contextManager: opts.contextManager,
    sessionManager: makeFakeSessionManager(),
    eventBus,
    approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
  });
  return { runtime, events };
}

function fillContext(cm: ContextManager, count: number, tokensPerMsg: number): void {
  // Generate ~tokensPerMsg-ish content per message (4 chars ≈ 1 token).
  const body = 'x'.repeat(tokensPerMsg * 4);
  for (let i = 0; i < count; i += 1) {
    cm.add({
      id: `u-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: body,
      createdAt: i,
    });
  }
}

// ---------- tests ----------

describe('ChatRuntime auto-compress wiring', () => {
  test('calls summarizer when shouldAutoCompress is true', async () => {
    let summarizeCalls = 0;
    const cm = new ContextManager({
      summarizer: async () => {
        summarizeCalls += 1;
        return 'compressed';
      },
      // Trigger easily — anything over 50% of maxTokens.
      summarizeAtPercent: 0.5,
      keepLastN: 2,
    });
    // ~5000 chars ≈ 1250 tokens; with maxContextTokens=1000 we're
    // comfortably above the 0.8 trigger threshold.
    fillContext(cm, 30, 50);

    const log: FakeStreamLog = { callCount: 0, lastMessages: [] };
    const { runtime } = makeRuntime({
      contextManager: cm,
      maxContextTokens: 1000,
      autoCompressPercent: 0.5,
      maxRecentMessages: 0, // disable so we don't slice the test history
      llmLog: log,
    });

    await runtime.sendUserMessage('hello', 'req-1');

    // maybeSummarize was called both at start-of-turn (always) and at
    // end-of-turn (auto-compress predicate fired). At least one of
    // them produced a summary.
    expect(summarizeCalls).toBeGreaterThanOrEqual(1);
  });

  test('cooldown blocks back-to-back auto-compress', async () => {
    let summarizeCalls = 0;
    const cm = new ContextManager({
      summarizer: async () => {
        summarizeCalls += 1;
        return 'compressed';
      },
      summarizeAtPercent: 0.5,
      keepLastN: 2,
    });
    fillContext(cm, 30, 50);

    const log: FakeStreamLog = { callCount: 0, lastMessages: [] };
    const { runtime } = makeRuntime({
      contextManager: cm,
      maxContextTokens: 1000,
      autoCompressPercent: 0.5,
      maxRecentMessages: 0,
      llmLog: log,
    });

    await runtime.sendUserMessage('first', 'r-1');
    const after1 = summarizeCalls;
    // Refill so the predicate would fire again.
    fillContext(cm, 30, 50);
    await runtime.sendUserMessage('second', 'r-2');
    const after2 = summarizeCalls;

    // The end-of-turn auto-compress on the second turn should be
    // blocked by the cooldown — but `maybeSummarize` is also called at
    // the START of every turn (the unconditional best-effort one). So
    // we expect SOME growth, but not the full duplication that would
    // happen without a cooldown gate. Practically: each turn produces
    // at most 2 calls (start + end), with cooldown the second turn
    // produces 1 (start only). Total ≤ 3.
    expect(after1).toBeGreaterThanOrEqual(1);
    expect(after2 - after1).toBeLessThanOrEqual(1);
  });

  test('no auto-compress when below threshold', async () => {
    let summarizeCalls = 0;
    const cm = new ContextManager({
      summarizer: async () => {
        summarizeCalls += 1;
        return 'compressed';
      },
      summarizeAtPercent: 0.95,
      keepLastN: 2,
    });
    // Tiny history — well under threshold.
    fillContext(cm, 4, 5);

    const log: FakeStreamLog = { callCount: 0, lastMessages: [] };
    const { runtime } = makeRuntime({
      contextManager: cm,
      maxContextTokens: 100_000,
      autoCompressPercent: 0.95,
      maxRecentMessages: 0,
      llmLog: log,
    });

    await runtime.sendUserMessage('hi', 'req-1');
    // Both start-of-turn and end-of-turn predicates short-circuit
    // (well below 95%), so the summarizer is never invoked.
    expect(summarizeCalls).toBe(0);
  });

  test('sliding window applied to messages forwarded to llm.streamChat', async () => {
    const cm = new ContextManager();
    // 50 small messages; window of 5 should cut to system + 5 = 6.
    fillContext(cm, 50, 2);

    const log: FakeStreamLog = { callCount: 0, lastMessages: [] };
    const { runtime } = makeRuntime({
      contextManager: cm,
      maxContextTokens: 100_000,
      autoCompressPercent: 0.95,
      maxRecentMessages: 5,
      llmLog: log,
    });

    await runtime.sendUserMessage('latest', 'req-1');
    expect(log.callCount).toBe(1);
    // System on top + sliding-window tail. The user message just
    // submitted is also part of the tail.
    expect(log.lastMessages[0]?.role).toBe('system');
    // We capped at 5 plus the system pin, so total is 6.
    expect(log.lastMessages.length).toBe(6);
  });
});
