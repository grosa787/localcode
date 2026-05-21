/**
 * End-to-end test for the wakeup → ChatRuntime injection path.
 *
 * Builds:
 *   - A WakeupRegistry with injected fake timers, configured so that its
 *     `onFire` callback delegates to `runtime.queueWakeupPrompt(prompt)`.
 *   - A ChatRuntime with a stub LLM adapter that records the user-message
 *     content of each turn.
 *
 * Fires a scheduled wakeup; asserts that the runtime now sees the
 * self-prompt as the next user message.
 */

import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';

import { ApprovalBridge } from '@/web/runtime/approval-bridge';
import { SessionEventBus } from '@/web/runtime/event-bus';
import { ChatRuntime } from '@/web/runtime/chat-runtime';
import { ContextManager } from '@/llm/context-manager';
import type { ToolExecutor } from '@/llm/tool-executor';
import type { LLMAdapter } from '@/llm/adapter';
import type { SessionManager } from '@/sessions/session-manager';
import type { Message } from '@/types/global';
import type { WSServerMessage } from '@/web/protocol/messages';
import { WakeupRegistry } from '@/scheduling';

const SESSION_ID = 's-wakeup';

interface FakeHandle {
  readonly id: number;
  readonly cb: () => void;
  cleared: boolean;
}

function makeFakeTimers(): {
  setTimeoutFn: (cb: () => void) => unknown;
  clearTimeoutFn: (h: unknown) => void;
  fireAll: () => void;
  count: () => number;
} {
  const handles: FakeHandle[] = [];
  let next = 1;
  return {
    setTimeoutFn(cb): unknown {
      const h: FakeHandle = { id: next, cb, cleared: false };
      next += 1;
      handles.push(h);
      return h;
    },
    clearTimeoutFn(handle): void {
      if (
        handle !== null &&
        typeof handle === 'object' &&
        'id' in (handle as Record<string, unknown>)
      ) {
        (handle as FakeHandle).cleared = true;
      }
    },
    fireAll(): void {
      for (const h of [...handles]) {
        if (!h.cleared) h.cb();
      }
    },
    count(): number {
      return handles.filter((h) => !h.cleared).length;
    },
  };
}

function makeStubLLM(captured: Message[][]): {
  streamChat: LLMAdapter['streamChat'];
} {
  return {
    streamChat: (async (opts) => {
      captured.push(opts.messages.slice());
      // Single turn — no tool calls, brief reply, then done.
      opts.onChunk?.('reply');
      opts.onDone?.({ finishReason: 'stop' });
    }) as LLMAdapter['streamChat'],
  };
}

function makeStubSessionManager(): SessionManager {
  return {
    addMessage: () => undefined,
    getMessages: () => [],
    getAllMessages: () => [],
    getTodos: () => [],
    setTodos: () => undefined,
    getSession: () => null,
    updateSummary: () => undefined,
  } as unknown as SessionManager;
}

function makeRuntime(opts: {
  llmCaptured: Message[][];
  events: WSServerMessage[];
}): ChatRuntime {
  const eventBus = new SessionEventBus();
  eventBus.subscribe(SESSION_ID, (m) => opts.events.push(m));
  const cm = new ContextManager();

  const toolExecutor = {
    execute: async () => ({ success: true, output: '' }),
  } as unknown as ToolExecutor;

  return new ChatRuntime({
    sessionId: SESSION_ID,
    tools: [],
    buildSystemMessage: () => ({
      id: 'sys',
      role: 'system',
      content: 'sys',
      createdAt: 0,
    }),
    maxContextTokens: 100_000,
    maxRecentMessages: 0,
    llm: makeStubLLM(opts.llmCaptured),
    toolExecutor,
    contextManager: cm,
    sessionManager: makeStubSessionManager(),
    eventBus,
    approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
    projectRoot: os.tmpdir(),
  });
}

describe('Wakeup → ChatRuntime injection', () => {
  test('fired wakeup triggers ChatRuntime.queueWakeupPrompt → user message', async () => {
    const llmCaptured: Message[][] = [];
    const events: WSServerMessage[] = [];
    const runtime = makeRuntime({ llmCaptured, events });

    const timers = makeFakeTimers();
    // The registry's onFire calls into runtime.queueWakeupPrompt which is
    // promise-returning; we collect the promise so the test can await
    // delivery before asserting.
    const pending: Promise<unknown>[] = [];
    const registry = new WakeupRegistry(
      (sid, prompt) => {
        if (sid !== SESSION_ID) return;
        pending.push(runtime.queueWakeupPrompt(prompt));
      },
      {
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      },
    );

    registry.schedule(SESSION_ID, {
      delayMs: 120_000,
      prompt: 'self: check the build',
      reason: 'long build',
    });

    timers.fireAll();
    await Promise.all(pending);

    // The runtime should have invoked streamChat exactly once with the
    // self-prompt as the most recent user message.
    expect(llmCaptured).toHaveLength(1);
    const messages = llmCaptured[0] ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    expect(lastUser?.content).toBe('self: check the build');

    // The runtime should also have emitted a `message_committed` frame
    // for the synthetic user message.
    const userCommit = events.find(
      (e) =>
        e.type === 'message_committed' && e.message.role === 'user',
    );
    expect(userCommit).toBeDefined();

    registry.dispose();
  });

  test('wakeup with mismatched sessionId does not inject into runtime', async () => {
    const llmCaptured: Message[][] = [];
    const events: WSServerMessage[] = [];
    const runtime = makeRuntime({ llmCaptured, events });

    const timers = makeFakeTimers();
    const pending: Promise<unknown>[] = [];
    const registry = new WakeupRegistry(
      (sid, prompt) => {
        if (sid !== SESSION_ID) return;
        pending.push(runtime.queueWakeupPrompt(prompt));
      },
      {
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
      },
    );

    registry.schedule('other-session', {
      delayMs: 120_000,
      prompt: 'should not arrive',
      reason: 'mismatched',
    });

    timers.fireAll();
    await Promise.all(pending);

    expect(llmCaptured).toHaveLength(0);
    expect(events).toHaveLength(0);

    registry.dispose();
  });
});
