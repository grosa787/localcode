/**
 * Error-recovery regression tests for the web ChatRuntime.
 *
 * Verifies that after various mid-turn failures:
 *   - the conversation stays alive (next sendUserMessage works),
 *   - the client always sees a terminal `done` frame so its spinner
 *     clears,
 *   - the streaming lock is released even when an inner throw bubbles.
 */
import { describe, expect, test } from 'bun:test';

import { ApprovalBridge } from '@/web/runtime/approval-bridge';
import { SessionEventBus } from '@/web/runtime/event-bus';
import { ChatRuntime } from '@/web/runtime/chat-runtime';
import { ContextManager } from '@/llm/context-manager';
import { ToolExecutor } from '@/llm/tool-executor';
import type { LLMAdapter } from '@/llm/adapter';
import type { SessionManager } from '@/sessions/session-manager';
import type { WSServerMessage } from '@/web/protocol/messages';
import type { ToolCall } from '@/types/global';

function makeSessionManagerFake(): SessionManager {
  return {
    addMessage: () => undefined,
    getMessages: () => [],
    getTodos: () => [],
    getSession: () => null,
  } as unknown as SessionManager;
}

interface BuildOpts {
  llm: { streamChat: LLMAdapter['streamChat'] };
  toolExecutor: ToolExecutor;
  sessionId?: string;
}

function buildRuntime(opts: BuildOpts, events: WSServerMessage[]): ChatRuntime {
  const eventBus = new SessionEventBus();
  const sid = opts.sessionId ?? 's-recovery';
  eventBus.subscribe(sid, (m) => events.push(m));
  return new ChatRuntime({
    sessionId: sid,
    tools: [],
    buildSystemMessage: () => ({
      id: 'sys',
      role: 'system',
      content: 'sys',
      createdAt: 0,
    }),
    maxContextTokens: 100_000,
    maxRecentMessages: 0,
    llm: opts.llm,
    toolExecutor: opts.toolExecutor,
    contextManager: new ContextManager(),
    sessionManager: makeSessionManagerFake(),
    eventBus,
    approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
  });
}

describe('ChatRuntime — error recovery', () => {
  test('tool handler throwing mid-turn does not wedge the runtime', async () => {
    let turn = 0;
    const llm: { streamChat: LLMAdapter['streamChat'] } = {
      streamChat: (async (callOpts) => {
        turn += 1;
        if (turn === 1) {
          // First turn: emit a tool call so the loop dispatches it.
          callOpts.onToolCalls?.([
            {
              id: 'tc-1',
              name: 'broken_tool',
              arguments: {},
            },
          ]);
          callOpts.onDone?.({ finishReason: 'tool_calls' });
        } else {
          // Second turn: post-tool, give a final reply so the loop ends.
          callOpts.onChunk?.('done');
          callOpts.onDone?.({ finishReason: 'stop' });
        }
      }) as LLMAdapter['streamChat'],
    };
    const toolExecutor = {
      execute: async (_call: ToolCall) => {
        throw new Error('synthetic throw from tool dispatch');
      },
    } as unknown as ToolExecutor;

    const events: WSServerMessage[] = [];
    const runtime = buildRuntime({ llm, toolExecutor }, events);

    await runtime.sendUserMessage('first', 'req-1');

    // Lock released.
    expect(runtime.streaming).toBe(false);
    // Final `done` frame emitted (no error — the synthetic tool failure
    // becomes a tool_result and the loop continues to the next turn).
    const doneFrames = events.filter((e) => e.type === 'done');
    expect(doneFrames.length).toBe(1);
    // Tool_result must carry the synthesised error.
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults.length).toBe(1);
    if (toolResults[0]?.type === 'tool_result') {
      expect(toolResults[0].ok).toBe(false);
      expect(toolResults[0].error).toContain('synthetic throw');
    }

    // After the failure, the user must be able to send another message.
    events.length = 0;
    turn = 0;
    await runtime.sendUserMessage('second', 'req-2');
    const newDone = events.filter((e) => e.type === 'done');
    expect(newDone.length).toBe(1);
    expect(runtime.streaming).toBe(false);
  });

  test('adapter throwing emits done with error and unlocks runtime', async () => {
    const llm: { streamChat: LLMAdapter['streamChat'] } = {
      streamChat: (async () => {
        throw new Error('adapter blew up');
      }) as LLMAdapter['streamChat'],
    };
    const toolExecutor = {
      execute: async () => ({ success: true, output: '' }),
    } as unknown as ToolExecutor;

    const events: WSServerMessage[] = [];
    const runtime = buildRuntime({ llm, toolExecutor }, events);

    await runtime.sendUserMessage('hello', 'req-1');
    expect(runtime.streaming).toBe(false);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.error).toContain('adapter blew up');
    }
  });
});
