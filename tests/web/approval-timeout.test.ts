/**
 * Approval-timeout regression — when the ApprovalBridge timeout fires
 * (no UI ever resolves the prompt), the executor's approval gate
 * receives an `ApprovalTimeoutError`, the tool result is a structured
 * failure, and the runtime continues to accept the next user message.
 */
import { describe, expect, test } from 'bun:test';

import { ApprovalBridge } from '@/web/runtime/approval-bridge';
import { SessionEventBus } from '@/web/runtime/event-bus';
import { ChatRuntime } from '@/web/runtime/chat-runtime';
import { ContextManager } from '@/llm/context-manager';
import { ToolExecutor } from '@/llm/tool-executor';
import type { SessionManager } from '@/sessions/session-manager';
import type { LLMAdapter } from '@/llm/adapter';
import type { WSServerMessage } from '@/web/protocol/messages';

describe('ChatRuntime — approval timeout releases the stream lock', () => {
  test('approval that times out yields tool failure, not a wedged runtime', async () => {
    const sessionId = 's-approval-timeout';
    const eventBus = new SessionEventBus();
    const events: WSServerMessage[] = [];
    eventBus.subscribe(sessionId, (m) => events.push(m));
    const approvalBridge = new ApprovalBridge({ timeoutMs: 25 });

    let turn = 0;
    const llm: { streamChat: LLMAdapter['streamChat'] } = {
      streamChat: (async (callOpts) => {
        turn += 1;
        if (turn === 1) {
          // First turn: emit a run_command tool call that requires approval.
          callOpts.onToolCalls?.([
            {
              id: 'tc-timeout',
              name: 'run_command',
              arguments: { command: 'echo hi' },
            },
          ]);
          callOpts.onDone?.({ finishReason: 'tool_calls' });
        } else {
          // Second turn: model "recovers" with a final answer.
          callOpts.onChunk?.('recovered');
          callOpts.onDone?.({ finishReason: 'stop' });
        }
      }) as LLMAdapter['streamChat'],
    };

    // Real ToolExecutor with a run_command handler that should never
    // execute (the approval times out before reaching it).
    let handlerWasCalled = false;
    const toolExecutor = new ToolExecutor({
      handlers: {
        run_command: async () => {
          handlerWasCalled = true;
          return { success: true, output: 'never' };
        },
      },
      approvalCallback: async (toolName, args) => {
        // Route to the bridge — nobody will resolve it, so this throws
        // ApprovalTimeoutError after `timeoutMs`.
        const resolution = await approvalBridge.request(
          'tc-timeout',
          toolName,
          args,
          null,
          sessionId,
        );
        return resolution.approved;
      },
    });

    const runtime = new ChatRuntime({
      sessionId,
      tools: [],
      buildSystemMessage: () => ({
        id: 'sys',
        role: 'system',
        content: 'sys',
        createdAt: 0,
      }),
      maxContextTokens: 100_000,
      maxRecentMessages: 0,
      llm,
      toolExecutor,
      contextManager: new ContextManager(),
      sessionManager: {
        addMessage: () => undefined,
        getMessages: () => [],
        getTodos: () => [],
        getSession: () => null,
      } as unknown as SessionManager,
      eventBus,
      approvalBridge,
    });

    await runtime.sendUserMessage('please run a command', 'r1');

    // Handler never ran — approval timed out first.
    expect(handlerWasCalled).toBe(false);
    // The stream lock is released, so the user can send again.
    expect(runtime.streaming).toBe(false);
    // The runtime emitted a tool_result with the approval-timeout error.
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults.length).toBe(1);
    if (toolResults[0]?.type === 'tool_result') {
      expect(toolResults[0].ok).toBe(false);
      expect(toolResults[0].error?.toLowerCase()).toContain('approval');
    }
    // A terminal `done` arrived so the client spinner clears.
    expect(events.filter((e) => e.type === 'done').length).toBe(1);

    // Second send: must work normally.
    events.length = 0;
    await runtime.sendUserMessage('try again', 'r2');
    expect(runtime.streaming).toBe(false);
    expect(events.filter((e) => e.type === 'done').length).toBe(1);
  });
});
