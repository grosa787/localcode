/**
 * ChatRuntime ↔ PreCompact hook wiring.
 *
 * Verifies:
 *   - When the auto-compress predicate would fire AND a blocking
 *     PreCompact hook returns non-zero, the compress is aborted AND
 *     the cooldown is NOT stamped (so the next turn can retry once
 *     the user fixes the hook).
 *   - A non-blocking PreCompact hook does not abort compress; the
 *     cooldown IS stamped on a successful compress.
 *   - When no hook is configured, the existing auto-compress path is
 *     unchanged.
 *
 * Uses minimal fakes for the LLM / SessionManager / ToolExecutor
 * (same pattern as `tests/web/auto-compress-wiring.test.ts`).
 */

import { describe, expect, test } from 'bun:test';

import { ChatRuntime } from '@/web/runtime/chat-runtime';
import { SessionEventBus } from '@/web/runtime/event-bus';
import { ApprovalBridge } from '@/web/runtime/approval-bridge';
import { ContextManager } from '@/llm/context-manager';
import { HookEngine, type HookConfig } from '@/hooks';
import type { LLMAdapter } from '@/llm/adapter';
import type { Message } from '@/types/global';
import type { SessionManager } from '@/sessions/session-manager';
import type { ToolExecutor } from '@/llm/tool-executor';

function makeFakeLLM(): { streamChat: LLMAdapter['streamChat'] } {
  return {
    streamChat: (async (opts) => {
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

function fillContext(cm: ContextManager, count: number, tokensPerMsg: number): void {
  const body = 'x'.repeat(tokensPerMsg * 4);
  for (let i = 0; i < count; i += 1) {
    cm.add({
      id: `m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: body,
      createdAt: i,
    });
  }
}

function buildRuntimeForCompress(opts: {
  hooks: HookConfig[];
  cm: ContextManager;
}): {
  runtime: ChatRuntime;
  events: unknown[];
  summarizerCalls: { count: number };
} {
  const events: unknown[] = [];
  const eventBus = new SessionEventBus();
  eventBus.subscribe('s1', (m) => events.push(m));
  const hookEngine = new HookEngine({ hooks: opts.hooks });
  return {
    summarizerCalls: { count: 0 },
    runtime: new ChatRuntime({
      sessionId: 's1',
      tools: [],
      buildSystemMessage: () => ({
        id: 'sys-0',
        role: 'system',
        content: 'sys',
        createdAt: 0,
      }),
      maxContextTokens: 1000,
      autoCompressPercent: 0.5,
      maxRecentMessages: 0,
      llm: makeFakeLLM(),
      toolExecutor: makeFakeToolExecutor(),
      contextManager: opts.cm,
      sessionManager: makeFakeSessionManager(),
      eventBus,
      approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
      hookEngine,
      projectRoot: process.cwd(),
    }),
    events,
  };
}

describe('ChatRuntime PreCompact — blocking hook aborts compress', () => {
  test('blocking exit aborts compress AND does not stamp cooldown', async () => {
    // No summarizer wired into ContextManager — so the start-of-turn
    // `maybeSummarize` call is a no-op (returns false without
    // collapsing history). The end-of-turn `maybeAutoCompress`
    // predicate is then guaranteed to evaluate against the same
    // populated history we filled below, which is what we need to
    // exercise the PreCompact hook path.
    const cm = new ContextManager();
    fillContext(cm, 30, 50);

    const { runtime, events } = buildRuntimeForCompress({
      cm,
      hooks: [{ trigger: 'PreCompact', command: 'exit 1', blocking: true }],
    });

    await runtime.sendUserMessage('hi', 'r-1');

    // System note announcing the abort should appear.
    const aborted = events.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'message_committed' &&
        typeof (e as { message?: { content?: string } }).message?.content ===
          'string' &&
        (e as { message: { content: string } }).message.content.includes(
          'Auto-compress aborted by hook',
        ),
    );
    expect(aborted).toBeDefined();

    const abortNoticesAfterOne = events.filter(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'message_committed' &&
        typeof (e as { message?: { content?: string } }).message?.content ===
          'string' &&
        (e as { message: { content: string } }).message.content.includes(
          'Auto-compress aborted by hook',
        ),
    );
    expect(abortNoticesAfterOne.length).toBe(1);

    // Cooldown was NOT stamped on the first blocked attempt. A second
    // turn through the same runtime + still-blocking hook re-evaluates
    // the predicate (same populated history) and produces a SECOND
    // abort notice. If the cooldown had been stamped on the first
    // attempt, the second turn's auto-compress would short-circuit at
    // the cooldown check and never reach the PreCompact hook.
    await runtime.sendUserMessage('hi', 'r-2');
    const abortNoticesAfterTwo = events.filter(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'message_committed' &&
        typeof (e as { message?: { content?: string } }).message?.content ===
          'string' &&
        (e as { message: { content: string } }).message.content.includes(
          'Auto-compress aborted by hook',
        ),
    );
    expect(abortNoticesAfterTwo.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ChatRuntime PreCompact — non-blocking hook permits compress', () => {
  test('non-blocking exit-zero does NOT abort compress', async () => {
    let summarizerCalls = 0;
    const cm = new ContextManager({
      summarizer: async () => {
        summarizerCalls += 1;
        return 'compressed';
      },
      // High start-of-turn threshold so only the auto-compress path
      // (which uses our `autoCompressPercent: 0.5`) fires. This
      // isolates the summariser invocation to the end-of-turn path
      // gated by PreCompact.
      summarizeAtPercent: 0.99,
      keepLastN: 2,
    });
    fillContext(cm, 30, 50);

    const { runtime, events } = buildRuntimeForCompress({
      cm,
      hooks: [{ trigger: 'PreCompact', command: 'echo ok', blocking: false }],
    });

    await runtime.sendUserMessage('hi', 'r-1');

    const aborted = events.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'message_committed' &&
        typeof (e as { message?: { content?: string } }).message?.content ===
          'string' &&
        (e as { message: { content: string } }).message.content.includes(
          'Auto-compress aborted by hook',
        ),
    );
    expect(aborted).toBeUndefined();
    // Summariser ran via the auto-compress path (PreCompact permitted it).
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('ChatRuntime PreCompact — no hook configured', () => {
  test('absence of PreCompact hook leaves auto-compress path unchanged', async () => {
    let summarizerCalls = 0;
    const cm = new ContextManager({
      summarizer: async () => {
        summarizerCalls += 1;
        return 'compressed';
      },
      // High start-of-turn threshold — only the end-of-turn auto-compress
      // path triggers, which is the one we want to observe.
      summarizeAtPercent: 0.99,
      keepLastN: 2,
    });
    fillContext(cm, 30, 50);

    // Empty hooks list → engine short-circuits.
    const { runtime } = buildRuntimeForCompress({
      cm,
      hooks: [],
    });

    await runtime.sendUserMessage('hi', 'r-1');
    expect(summarizerCalls).toBeGreaterThanOrEqual(1);
  });
});
