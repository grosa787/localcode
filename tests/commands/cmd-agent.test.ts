import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentCommand,
  type AgentLLM,
  type AgentContextManager,
  type AgentToolExecutor,
  type AgentState,
} from '@/commands/cmd-agent';
import type {
  AppConfig,
  CommandContext,
  Message,
  ToolCall,
  ToolResult,
} from '@/types/global';
import type { StreamChatParams } from '@/types/message';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-agent-${crypto.randomUUID()}`);
  await mkdir(path.join(tmpRoot, '.localcode'), { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeCtx(printed: string[]): CommandContext {
  return {
    projectRoot: tmpRoot,
    sessionId: null,
    config: {} as AppConfig,
    print: (line) => {
      printed.push(line);
    },
    setScreen: () => {},
  };
}

function makeContextManager(): {
  cm: AgentContextManager;
  messages: Message[];
} {
  const messages: Message[] = [];
  const cm: AgentContextManager = {
    getMessages() {
      return messages.slice();
    },
    addMessage(m: Message) {
      messages.push(m);
    },
    buildSystemPrompt() {
      return 'SYS';
    },
  };
  return { cm, messages };
}

function makeToolExecutor(
  outputFn?: (call: ToolCall) => ToolResult,
): AgentToolExecutor {
  return {
    async executeAll(calls) {
      return calls.map((call) => ({
        toolCall: call,
        result:
          outputFn !== undefined
            ? outputFn(call)
            : { success: true, output: 'tool-out' },
      }));
    },
  };
}

function readState(): AgentState {
  const stateFile = path.join(tmpRoot, '.localcode', 'agent-state.json');
  return JSON.parse(readFileSync(stateFile, 'utf8')) as AgentState;
}

describe('createAgentCommand — happy path', () => {
  test('runs to completion when model emits TASK COMPLETE', async () => {
    const printed: string[] = [];
    const { cm, messages } = makeContextManager();
    let turn = 0;
    const llm: AgentLLM = {
      async streamChat(params: StreamChatParams) {
        turn += 1;
        if (turn === 1) {
          params.onToolCalls?.([
            {
              id: 'c1',
              name: 'read_file',
              arguments: { path: 'foo.ts' },
            },
          ]);
          params.onDone?.({
            finishReason: 'tool_calls',
            usage: { promptTokens: 100, completionTokens: 50 },
          });
        } else {
          params.onChunk?.('All done.\nTASK COMPLETE');
          params.onDone?.({
            finishReason: 'stop',
            usage: { promptTokens: 50, completionTokens: 20 },
          });
        }
      },
    };
    const cmd = createAgentCommand({
      llm,
      contextManager: cm,
      toolExecutor: makeToolExecutor(),
      tools: [],
      readLocalcodeMd: () => null,
    });
    await cmd.execute('do something', makeCtx(printed));
    const state = readState();
    expect(state.status).toBe('done');
    expect(state.iterations).toBe(2);
    expect(messages.length).toBeGreaterThan(0);
    // The seeded user message + the assistant turns + tool result.
    expect(messages.some((m) => m.role === 'user' && m.content.includes('do something'))).toBe(true);
    expect(messages.some((m) => m.role === 'tool')).toBe(true);
  });
});

describe('createAgentCommand — safety', () => {
  test('handles llm error by failing fast', async () => {
    const printed: string[] = [];
    const { cm } = makeContextManager();
    const llm: AgentLLM = {
      async streamChat(params: StreamChatParams) {
        params.onDone?.({
          finishReason: 'error',
          error: 'connection refused',
        });
      },
    };
    const cmd = createAgentCommand({
      llm,
      contextManager: cm,
      toolExecutor: makeToolExecutor(),
      tools: [],
      readLocalcodeMd: () => null,
    });
    await cmd.execute('do something', makeCtx(printed));
    const state = readState();
    expect(state.status).toBe('failed');
    expect(printed.join('\n')).toContain('connection refused');
  });

  test('watchdog trips on 5 consecutive identical tool calls + user pause', async () => {
    const printed: string[] = [];
    const { cm } = makeContextManager();
    const sameCall: ToolCall = {
      id: 'c1',
      name: 'read_file',
      arguments: { path: 'foo.ts' },
    };
    const llm: AgentLLM = {
      async streamChat(params: StreamChatParams) {
        // Always emit the same tool call.
        params.onToolCalls?.([{ ...sameCall, id: `c-${Math.random()}` }]);
        params.onDone?.({
          finishReason: 'tool_calls',
          usage: { promptTokens: 10, completionTokens: 5 },
        });
      },
    };
    const cmd = createAgentCommand({
      llm,
      contextManager: cm,
      toolExecutor: makeToolExecutor(),
      tools: [],
      readLocalcodeMd: () => null,
      // Confirm hook says "no" → watchdog pauses the run.
      confirm: async () => false,
    });
    await cmd.execute('loop forever', makeCtx(printed));
    const state = readState();
    expect(state.status).toBe('paused');
    expect(printed.join('\n')).toContain('Watchdog');
  });
});

describe('createAgentCommand — argument parsing', () => {
  test('cancel without prior state prints "no agent run is active"', async () => {
    const printed: string[] = [];
    const { cm } = makeContextManager();
    const cmd = createAgentCommand({
      llm: { async streamChat() {} },
      contextManager: cm,
      toolExecutor: makeToolExecutor(),
      tools: [],
      readLocalcodeMd: () => null,
    });
    await cmd.execute('cancel', makeCtx(printed));
    expect(printed.join('\n')).toContain('No agent run is active');
  });

  test('resume without prior state prints helpful message', async () => {
    const printed: string[] = [];
    const { cm } = makeContextManager();
    const cmd = createAgentCommand({
      llm: { async streamChat() {} },
      contextManager: cm,
      toolExecutor: makeToolExecutor(),
      tools: [],
      readLocalcodeMd: () => null,
    });
    await cmd.execute('resume', makeCtx(printed));
    expect(printed.join('\n')).toContain('No agent state to resume');
  });

  test('empty arg prints usage', async () => {
    const printed: string[] = [];
    const { cm } = makeContextManager();
    const cmd = createAgentCommand({
      llm: { async streamChat() {} },
      contextManager: cm,
      toolExecutor: makeToolExecutor(),
      tools: [],
      readLocalcodeMd: () => null,
    });
    await cmd.execute('', makeCtx(printed));
    expect(printed.join('\n')).toContain('Usage: /agent');
  });

  test('--auto flag is parsed and recorded in state', async () => {
    const printed: string[] = [];
    const { cm } = makeContextManager();
    const llm: AgentLLM = {
      async streamChat(params: StreamChatParams) {
        params.onChunk?.('TASK COMPLETE');
        params.onDone?.({
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1 },
        });
      },
    };
    const cmd = createAgentCommand({
      llm,
      contextManager: cm,
      toolExecutor: makeToolExecutor(),
      tools: [],
      readLocalcodeMd: () => null,
    });
    await cmd.execute('--auto write hello', makeCtx(printed));
    const state = readState();
    expect(state.auto).toBe(true);
    expect(state.task).toBe('write hello');
  });
});

describe('createAgentCommand — execute / resume flow', () => {
  test('execute with no plan saved prints helpful message', async () => {
    const printed: string[] = [];
    const { cm } = makeContextManager();
    const cmd = createAgentCommand({
      llm: { async streamChat() {} },
      contextManager: cm,
      toolExecutor: makeToolExecutor(),
      tools: [],
      readLocalcodeMd: () => null,
    });
    await cmd.execute('execute', makeCtx(printed));
    expect(printed.join('\n')).toContain('No saved plan');
  });

  test('cancel after starting a run flips state to paused', async () => {
    const printed: string[] = [];
    const { cm } = makeContextManager();

    // First run, set state to "running" by writing a state file directly.
    const stateFile = path.join(tmpRoot, '.localcode', 'agent-state.json');
    const fakeState: AgentState = {
      task: 'x',
      startedAt: Date.now(),
      iterations: 1,
      lastTool: null,
      status: 'running',
      tokensUsed: 0,
      lastToolHash: null,
      repeatCount: 0,
      auto: false,
    };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(stateFile, JSON.stringify(fakeState));

    const cmd = createAgentCommand({
      llm: { async streamChat() {} },
      contextManager: cm,
      toolExecutor: makeToolExecutor(),
      tools: [],
      readLocalcodeMd: () => null,
    });
    await cmd.execute('cancel', makeCtx(printed));
    const state = readState();
    expect(state.status).toBe('paused');
    expect(printed.join('\n')).toContain('Agent paused');
  });
});

describe('createAgentCommand — persistence', () => {
  test('writes a state file even on failure', async () => {
    const printed: string[] = [];
    const { cm } = makeContextManager();
    const llm: AgentLLM = {
      async streamChat(params: StreamChatParams) {
        params.onDone?.({
          finishReason: 'error',
          error: 'oops',
        });
      },
    };
    const cmd = createAgentCommand({
      llm,
      contextManager: cm,
      toolExecutor: makeToolExecutor(),
      tools: [],
      readLocalcodeMd: () => null,
    });
    await cmd.execute('do', makeCtx(printed));
    const stateFile = path.join(tmpRoot, '.localcode', 'agent-state.json');
    expect(existsSync(stateFile)).toBe(true);
    const state = readState();
    expect(state.status).toBe('failed');
  });
});
