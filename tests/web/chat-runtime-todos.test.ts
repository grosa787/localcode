/**
 * Tests that ChatRuntime emits a `todos_updated` WS frame immediately after
 * a successful `todo_write` tool call completes.
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
import type { Todo } from '@/sessions/session-manager';
import type { ToolCall } from '@/types/global';

// ---------- Helpers ----------

const SESSION_ID = 's-todos';

function makeTodos(): Todo[] {
  return [
    { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
    { content: 'Deploy', status: 'in_progress', activeForm: 'Deploying' },
  ];
}

function makeFakeLLM(toolCalls: ToolCall[]): { streamChat: LLMAdapter['streamChat'] } {
  let turn = 0;
  return {
    streamChat: (async (opts) => {
      if (turn === 0) {
        // First turn: emit tool calls
        if (toolCalls.length > 0) {
          opts.onToolCalls?.(toolCalls);
        }
        opts.onDone?.({ finishReason: 'tool_calls' });
      } else {
        // Second turn: just finish
        opts.onChunk?.('done');
        opts.onDone?.({ finishReason: 'stop' });
      }
      turn += 1;
    }) as LLMAdapter['streamChat'],
  };
}

function makeRuntime(opts: {
  events: WSServerMessage[];
  sessionManager: SessionManager;
  toolCalls?: ToolCall[];
}): ChatRuntime {
  const toolCalls = opts.toolCalls ?? [];
  const eventBus = new SessionEventBus();
  eventBus.subscribe(SESSION_ID, (m) => opts.events.push(m));
  const cm = new ContextManager();

  // Fake ToolExecutor that simulates a successful todo_write result
  const toolExecutor = {
    execute: async (call: ToolCall) => {
      if (call.name === 'todo_write') {
        // Simulate the real tool: persist via sessionManager
        const todos = makeTodos();
        opts.sessionManager.setTodos(SESSION_ID, todos);
        return { success: true, output: '2 todos updated' };
      }
      return { success: true, output: '' };
    },
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
    llm: makeFakeLLM(toolCalls),
    toolExecutor,
    contextManager: cm,
    sessionManager: opts.sessionManager,
    eventBus,
    approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
    projectRoot: os.tmpdir(),
  });
}

// ---------- Tests ----------

describe('ChatRuntime — todo_write tool integration', () => {
  test('emits todos_updated frame after successful todo_write', async () => {
    const storedTodos: Todo[] = [];
    const sessionManager = {
      addMessage: () => undefined,
      getMessages: () => [],
      getSession: () => null,
      setTodos(_sid: string, todos: readonly Todo[]) {
        storedTodos.length = 0;
        storedTodos.push(...todos);
      },
      getTodos(_sid: string): Todo[] {
        return [...storedTodos];
      },
    } as unknown as SessionManager;

    const events: WSServerMessage[] = [];
    const toolCallId = 'tc-1';
    const runtime = makeRuntime({
      events,
      sessionManager,
      toolCalls: [
        {
          id: toolCallId,
          name: 'todo_write',
          arguments: {
            todos: makeTodos(),
          },
        },
      ],
    });

    await runtime.sendUserMessage('do some work', 'req-1');

    const todosUpdatedFrames = events.filter((e) => e.type === 'todos_updated');
    expect(todosUpdatedFrames).toHaveLength(1);

    const frame = todosUpdatedFrames[0];
    if (frame === undefined || frame.type !== 'todos_updated') {
      throw new Error('Expected todos_updated frame');
    }
    expect(frame.sessionId).toBe(SESSION_ID);
    expect(frame.todos).toHaveLength(2);
    const firstTodo = frame.todos[0];
    expect(firstTodo?.content).toBe('Write tests');
  });

  test('does NOT emit todos_updated for non-todo_write tool calls', async () => {
    const sessionManager = {
      addMessage: () => undefined,
      getMessages: () => [],
      getSession: () => null,
      setTodos: () => undefined,
      getTodos: () => [],
    } as unknown as SessionManager;

    const events: WSServerMessage[] = [];
    const runtime = makeRuntime({
      events,
      sessionManager,
      toolCalls: [
        {
          id: 'tc-2',
          name: 'read_file',
          arguments: { path: 'foo.ts' },
        },
      ],
    });

    await runtime.sendUserMessage('read a file', 'req-2');

    const todosUpdatedFrames = events.filter((e) => e.type === 'todos_updated');
    expect(todosUpdatedFrames).toHaveLength(0);
  });
});
