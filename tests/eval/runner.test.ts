/**
 * Runner tests — drive `runTask` / `runSuite` with a DETERMINISTIC fake
 * adapter so no network is touched. The fake's `streamChat` plays back a
 * scripted sequence of turns: each turn may emit visible text, tool
 * calls, and a usage payload. The real `ToolExecutor` (default factory)
 * runs the tool calls against the scaffolded tmp repo, so we exercise the
 * full scaffold → loop → tool-execute → success-check pipeline.
 */

import { describe, expect, test } from 'bun:test';

import { runTask, runSuite } from '@/eval/runner';
import type { EvalAdapter } from '@/eval/runner';
import type { GoldenTask } from '@/eval/types';
import type { StreamChatParams } from '@/types/message';
import type { ToolCall } from '@/types/global';

/** One scripted turn the fake adapter plays back. */
interface ScriptedTurn {
  readonly text?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: { promptTokens: number; completionTokens: number };
  readonly error?: string;
}

/**
 * Build a fake adapter that plays `turns` back across successive
 * `streamChat` calls. When the script runs out, every further call ends
 * the conversation with an empty text turn (no tool calls) so the loop
 * terminates rather than spinning.
 */
function scriptedAdapter(turns: readonly ScriptedTurn[]): {
  adapter: EvalAdapter;
  callCount: () => number;
} {
  let i = 0;
  const adapter: EvalAdapter = {
    streamChat: async (params: StreamChatParams): Promise<void> => {
      const turn = turns[i] ?? { text: 'done', toolCalls: [] };
      i += 1;
      if (turn.text !== undefined && params.onChunk) {
        params.onChunk(turn.text);
      }
      if (
        turn.toolCalls !== undefined &&
        turn.toolCalls.length > 0 &&
        params.onToolCalls
      ) {
        params.onToolCalls([...turn.toolCalls]);
      }
      if (params.onDone) {
        params.onDone({
          finishReason: turn.error !== undefined ? 'error' : 'stop',
          ...(turn.error !== undefined ? { error: turn.error } : {}),
          usage: turn.usage ?? { promptTokens: 0, completionTokens: 0 },
        });
      }
    },
  };
  return { adapter, callCount: () => i };
}

function writeFileCall(id: string, filePath: string, content: string): ToolCall {
  return { id, name: 'write_file', arguments: { path: filePath, content } };
}

/** A trivial passing task: write a file containing a marker. */
const FILE_TASK: GoldenTask = {
  id: 'eval-test-filecontains',
  title: 'write marker into out.txt',
  tags: ['test'],
  scaffold: { files: { 'seed.txt': 'seed\n' } },
  prompt: 'Write out.txt containing the word MARKER.',
  success: { kind: 'fileContains', path: 'out.txt', needle: 'MARKER' },
  maxTurns: 5,
};

/** A command-check task: write a node script that exits 0. */
const COMMAND_TASK: GoldenTask = {
  id: 'eval-test-command',
  title: 'write a node script that prints ok',
  tags: ['test'],
  scaffold: { files: {} },
  prompt: 'Write run.js that prints ok.',
  success: { kind: 'command', cmd: 'node run.js', expectExit: 0 },
  maxTurns: 5,
};

describe('runTask', () => {
  test('scaffolds, runs the loop, executes tools, and passes a fileContains check', async () => {
    const { adapter, callCount } = scriptedAdapter([
      {
        text: 'Creating the file. <DONE>',
        toolCalls: [writeFileCall('c1', 'out.txt', 'has MARKER inside\n')],
        usage: { promptTokens: 100, completionTokens: 20 },
      },
    ]);

    const result = await runTask(FILE_TASK, {
      adapter,
      model: 'test-model',
      backend: 'lmstudio',
    });

    expect(result.taskId).toBe('eval-test-filecontains');
    expect(result.passed).toBe(true);
    expect(result.turns).toBe(1);
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(20);
    // Local backend → no cost.
    expect(result.costUsd).toBe(0);
    expect(result.error).toBeUndefined();
    // Exactly one streamChat call (the <DONE> turn terminated the loop).
    expect(callCount()).toBe(1);
  });

  test('runs a command success check (node run.js exits 0)', async () => {
    const script = "console.log('ok');\n";
    const { adapter } = scriptedAdapter([
      {
        text: 'Writing the script. <DONE>',
        toolCalls: [writeFileCall('c1', 'run.js', script)],
        usage: { promptTokens: 50, completionTokens: 10 },
      },
    ]);

    const result = await runTask(COMMAND_TASK, {
      adapter,
      model: 'test-model',
      backend: 'lmstudio',
    });

    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('fails when the agent never produces the required file', async () => {
    // Agent emits <DONE> immediately with NO tool calls → file is missing.
    const { adapter } = scriptedAdapter([
      { text: 'Nothing to do. <DONE>', toolCalls: [] },
    ]);

    const result = await runTask(FILE_TASK, {
      adapter,
      model: 'test-model',
      backend: 'lmstudio',
    });

    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.turns).toBe(1);
  });

  test('records a stream error as a failed task', async () => {
    const { adapter } = scriptedAdapter([
      { text: '', error: 'backend exploded' },
    ]);

    const result = await runTask(FILE_TASK, {
      adapter,
      model: 'test-model',
      backend: 'lmstudio',
    });

    expect(result.passed).toBe(false);
    expect(result.error).toContain('backend exploded');
  });

  test('hits the maxTurns cap when the agent loops without finishing', async () => {
    // Every turn emits a (no-op) read tool call and never <DONE>, so the
    // loop runs until maxTurns. Use a tiny cap for speed.
    const cappedTask: GoldenTask = { ...FILE_TASK, maxTurns: 3 };
    const loopingTurn: ScriptedTurn = {
      text: 'still working',
      toolCalls: [
        { id: 'r1', name: 'read_file', arguments: { path: 'seed.txt' } },
      ],
      usage: { promptTokens: 10, completionTokens: 5 },
    };
    const { adapter, callCount } = scriptedAdapter([
      loopingTurn,
      loopingTurn,
      loopingTurn,
    ]);

    const result = await runTask(cappedTask, {
      adapter,
      model: 'test-model',
      backend: 'lmstudio',
    });

    expect(result.passed).toBe(false);
    expect(result.turns).toBe(3);
    expect(callCount()).toBe(3);
    expect(result.error).toContain('maxTurns');
  });

  test('executes tool calls BEFORE honouring <DONE> on the same turn', async () => {
    // The write_file and <DONE> arrive in the SAME turn. The file must
    // still be written (regression guard mirroring runner-factory FIX5).
    const { adapter } = scriptedAdapter([
      {
        text: 'Done writing. <DONE>',
        toolCalls: [writeFileCall('c1', 'out.txt', 'MARKER here\n')],
      },
    ]);

    const result = await runTask(FILE_TASK, {
      adapter,
      model: 'test-model',
      backend: 'lmstudio',
    });

    expect(result.passed).toBe(true);
  });

  test('accumulates tokens across multiple turns', async () => {
    const { adapter } = scriptedAdapter([
      {
        text: 'reading',
        toolCalls: [
          { id: 'r1', name: 'read_file', arguments: { path: 'seed.txt' } },
        ],
        usage: { promptTokens: 30, completionTokens: 5 },
      },
      {
        text: 'writing now <DONE>',
        toolCalls: [writeFileCall('c1', 'out.txt', 'MARKER\n')],
        usage: { promptTokens: 40, completionTokens: 8 },
      },
    ]);

    const result = await runTask(FILE_TASK, {
      adapter,
      model: 'test-model',
      backend: 'lmstudio',
    });

    expect(result.passed).toBe(true);
    expect(result.turns).toBe(2);
    expect(result.tokensIn).toBe(70);
    expect(result.tokensOut).toBe(13);
  });
});

describe('runSuite', () => {
  test('aggregates a mix of pass and fail into an EvalReport', async () => {
    // Two tasks: first passes (writes the file), second fails (no-op).
    const passTask: GoldenTask = { ...FILE_TASK, id: 'suite-pass' };
    const failTask: GoldenTask = { ...FILE_TASK, id: 'suite-fail' };

    let call = 0;
    const adapter: EvalAdapter = {
      streamChat: async (params: StreamChatParams): Promise<void> => {
        call += 1;
        // First streamChat (first task) writes the file + <DONE>.
        // Second streamChat (second task) does nothing + <DONE>.
        if (call === 1) {
          params.onChunk?.('writing <DONE>');
          params.onToolCalls?.([
            writeFileCall('c1', 'out.txt', 'MARKER\n'),
          ]);
        } else {
          params.onChunk?.('nothing <DONE>');
        }
        params.onDone?.({
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 2 },
        });
      },
    };

    const completed: string[] = [];
    const report = await runSuite([passTask, failTask], {
      adapter,
      model: 'test-model',
      backend: 'lmstudio',
      onTaskComplete: (r) => completed.push(r.taskId),
    });

    expect(report.model).toBe('test-model');
    expect(report.backend).toBe('lmstudio');
    expect(report.results.length).toBe(2);
    expect(report.results[0]?.passed).toBe(true);
    expect(report.results[1]?.passed).toBe(false);
    expect(report.passRate).toBe(0.5);
    expect(report.totalTokensIn).toBe(20);
    expect(report.totalTokensOut).toBe(4);
    expect(completed).toEqual(['suite-pass', 'suite-fail']);
  });
});
