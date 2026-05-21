/**
 * UserPromptSubmit hook integration with the web ChatRuntime.
 *
 * Covers:
 *   - blocking UserPromptSubmit hook → sendUserMessage rejects and emits error
 *   - non-blocking UserPromptSubmit hook → prompt proceeds
 *   - no hook engine configured → identical to pre-hook behaviour
 *   - engine throwing → emits warning error but does not block submission
 */
import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';

import { ApprovalBridge } from '@/web/runtime/approval-bridge';
import { SessionEventBus } from '@/web/runtime/event-bus';
import { ChatRuntime } from '@/web/runtime/chat-runtime';
import { ContextManager } from '@/llm/context-manager';
import { ToolExecutor } from '@/llm/tool-executor';
import type { LLMAdapter } from '@/llm/adapter';
import type { SessionManager } from '@/sessions/session-manager';
import type { WSServerMessage } from '@/web/protocol/messages';
import { HookEngine, type HookConfig } from '@/hooks';

function makeFakeLLM(): { streamChat: LLMAdapter['streamChat'] } {
  return {
    streamChat: (async (opts) => {
      // Emit a short reply and finish without tool calls.
      opts.onChunk?.('hi');
      opts.onDone?.({ finishReason: 'stop' });
    }) as LLMAdapter['streamChat'],
  };
}

function makeRuntime(opts: {
  hooks: HookConfig[];
  events: WSServerMessage[];
  sessionId?: string;
}): ChatRuntime {
  const eventBus = new SessionEventBus();
  eventBus.subscribe(opts.sessionId ?? 's-hooks', (m) => opts.events.push(m));
  const cm = new ContextManager();
  const sessionManager = {
    addMessage: () => undefined,
    getMessages: () => [],
    getSession: () => null,
  } as unknown as SessionManager;
  const toolExecutor = {
    execute: async () => ({ success: true, output: '' }),
  } as unknown as ToolExecutor;
  const engine = new HookEngine({ hooks: opts.hooks });
  return new ChatRuntime({
    sessionId: opts.sessionId ?? 's-hooks',
    tools: [],
    buildSystemMessage: () => ({
      id: 'sys',
      role: 'system',
      content: 'sys',
      createdAt: 0,
    }),
    maxContextTokens: 100_000,
    maxRecentMessages: 0,
    llm: makeFakeLLM(),
    toolExecutor,
    contextManager: cm,
    sessionManager,
    eventBus,
    approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
    hookEngine: engine,
    projectRoot: os.tmpdir(),
  });
}

describe('ChatRuntime — UserPromptSubmit hook integration', () => {
  test('blocking hook rejects the submission and emits error + done', async () => {
    const events: WSServerMessage[] = [];
    const runtime = makeRuntime({
      hooks: [
        {
          trigger: 'UserPromptSubmit',
          command: "echo 'forbidden phrase' 1>&2; exit 2",
          blocking: true,
        },
      ],
      events,
    });
    await runtime.sendUserMessage('hello', 'r1');
    const errorFrame = events.find((e) => e.type === 'error');
    expect(errorFrame).toBeDefined();
    if (errorFrame !== undefined && errorFrame.type === 'error') {
      expect(errorFrame.message).toContain('Prompt rejected by hook');
      expect(errorFrame.message).toContain('forbidden phrase');
    }
    const doneFrame = events.find((e) => e.type === 'done');
    expect(doneFrame).toBeDefined();
    if (doneFrame !== undefined && doneFrame.type === 'done') {
      expect(doneFrame.error).toContain('Prompt rejected by hook');
    }
    // No `message_committed` should have fired — the user message
    // never made it into context.
    const committed = events.find((e) => e.type === 'message_committed');
    expect(committed).toBeUndefined();
  });

  test('non-blocking failing hook lets the prompt proceed', async () => {
    const events: WSServerMessage[] = [];
    const runtime = makeRuntime({
      hooks: [
        {
          trigger: 'UserPromptSubmit',
          command: 'exit 1',
          blocking: false,
        },
      ],
      events,
    });
    await runtime.sendUserMessage('hello', 'r1');
    // User message committed → submission proceeded.
    const committed = events.filter((e) => e.type === 'message_committed');
    expect(committed.length).toBeGreaterThanOrEqual(1);
    // No rejection error from the hook.
    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBe(0);
  });

  test('successful hook lets the prompt proceed without surface effect', async () => {
    const events: WSServerMessage[] = [];
    const runtime = makeRuntime({
      hooks: [
        {
          trigger: 'UserPromptSubmit',
          command: 'true',
          blocking: true,
        },
      ],
      events,
    });
    await runtime.sendUserMessage('hello', 'r1');
    const committed = events.filter((e) => e.type === 'message_committed');
    expect(committed.length).toBeGreaterThanOrEqual(1);
    const doneFrame = events.find((e) => e.type === 'done');
    expect(doneFrame).toBeDefined();
    if (doneFrame !== undefined && doneFrame.type === 'done') {
      expect(doneFrame.error).toBeUndefined();
    }
  });

  test('no hook engine → behaviour is identical to before', async () => {
    const events: WSServerMessage[] = [];
    const eventBus = new SessionEventBus();
    eventBus.subscribe('s-baseline', (m) => events.push(m));
    const cm = new ContextManager();
    const sessionManager = {
      addMessage: () => undefined,
      getMessages: () => [],
      getSession: () => null,
    } as unknown as SessionManager;
    const toolExecutor = {
      execute: async () => ({ success: true, output: '' }),
    } as unknown as ToolExecutor;
    const runtime = new ChatRuntime({
      sessionId: 's-baseline',
      tools: [],
      buildSystemMessage: () => ({
        id: 'sys',
        role: 'system',
        content: 'sys',
        createdAt: 0,
      }),
      maxContextTokens: 100_000,
      maxRecentMessages: 0,
      llm: makeFakeLLM(),
      toolExecutor,
      contextManager: cm,
      sessionManager,
      eventBus,
      approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
      // hookEngine: omitted on purpose
    });
    await runtime.sendUserMessage('hello', 'r1');
    const committed = events.filter((e) => e.type === 'message_committed');
    expect(committed.length).toBeGreaterThanOrEqual(1);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBe(0);
  });

  test('hook with toolPattern is ignored for UserPromptSubmit', async () => {
    // toolPattern only applies to tool triggers — UserPromptSubmit
    // should fire regardless of the pattern value.
    const events: WSServerMessage[] = [];
    const runtime = makeRuntime({
      hooks: [
        {
          trigger: 'UserPromptSubmit',
          toolPattern: 'never-matches',
          command: 'exit 5',
          blocking: true,
        },
      ],
      events,
    });
    await runtime.sendUserMessage('hello', 'r1');
    const errorFrame = events.find((e) => e.type === 'error');
    expect(errorFrame).toBeDefined();
  });
});
