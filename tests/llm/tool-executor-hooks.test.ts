/**
 * Settings-driven hook integration with ToolExecutor.
 *
 * Covers:
 *   - PreToolUse blocking → tool rejected with hook stderr in error
 *   - PreToolUse non-blocking with non-zero exit → tool proceeds
 *   - PostToolUse blocking → tool result unchanged but synthetic note emitted
 *   - PostToolUse non-blocking → no note
 *   - No hooks (hookBridge undefined) → identical to pre-hook behaviour
 *   - End-to-end smoke: real HookEngine + ToolExecutor with a real
 *     write_file handler and a blocking PreToolUse hook that fails.
 */
import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';

import { ToolExecutor } from '@/llm/tool-executor';
import type { Message, ToolResult } from '@/types/global';
import type { ToolExecutorHookBridge, ToolHandlerMap } from '@/types/message';
import { HookEngine, type HookConfig } from '@/hooks';

function baseHandlers(captured: Array<{ name: string; args: Record<string, unknown> }> = []): ToolHandlerMap {
  return {
    write_file: async (args) => {
      captured.push({ name: 'write_file', args });
      return { success: true, output: 'WRITTEN' };
    },
    edit_file: async (args) => {
      captured.push({ name: 'edit_file', args });
      return { success: true, output: 'EDITED' };
    },
    read_file: async () => ({ success: true, output: 'CONTENT' }),
    run_command: async () => ({ success: true, output: 'RAN' }),
    list_dir: async () => ({ success: true, output: '' }),
    glob_search: async () => ({ success: true, output: '' }),
    lint_file: async () => ({ success: true, output: 'No issues found.' }),
  };
}

function fakeBridge(
  responses: Array<{
    blocked: boolean;
    stderr: string;
    stdout?: string;
    exitCode?: number;
    description?: string;
    command?: string;
  }>,
  forTrigger: 'PreToolUse' | 'PostToolUse' = 'PreToolUse',
): ToolExecutorHookBridge {
  return {
    hasHooksFor: (t): boolean => t === forTrigger,
    run: async () =>
      responses.map((r) => ({
        blocked: r.blocked,
        stderr: r.stderr,
        stdout: r.stdout ?? '',
        exitCode: r.exitCode ?? (r.blocked ? 1 : 0),
        hook: {
          command: r.command ?? 'fake-hook',
          ...(r.description !== undefined ? { description: r.description } : {}),
        },
      })),
  };
}

describe('ToolExecutor — PreToolUse hook integration', () => {
  test('blocking PreToolUse hook rejects the tool call with stderr in error', async () => {
    const captured: Array<{ name: string; args: Record<string, unknown> }> = [];
    const handlers = baseHandlers(captured);
    const events: Message[] = [];
    const executor = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      hookBridge: fakeBridge([
        { blocked: true, stderr: 'prettier: formatting issues' },
      ]),
      onHookEvent: (m) => events.push(m),
    });
    const result = await executor.execute({
      id: 'c1',
      name: 'write_file',
      arguments: { path: 'src/x.ts', content: 'export {}' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('PreToolUse hook blocked write_file');
    expect(result.error).toContain('prettier: formatting issues');
    // Handler must NOT have run.
    expect(captured.length).toBe(0);
    // A synthetic note must have been emitted.
    expect(events.length).toBe(1);
    expect(events[0]?.content).toContain('PreToolUse');
    expect(events[0]?.content).toContain('blocked');
  });

  test('non-blocking failing PreToolUse hook does NOT block the tool', async () => {
    const captured: Array<{ name: string; args: Record<string, unknown> }> = [];
    const handlers = baseHandlers(captured);
    const executor = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      // blocked:false despite exitCode:1 — non-blocking hooks never set blocked
      hookBridge: fakeBridge([{ blocked: false, stderr: 'lint warning' }]),
    });
    const result = await executor.execute({
      id: 'c2',
      name: 'write_file',
      arguments: { path: 'src/x.ts', content: 'export {}' },
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe('WRITTEN');
    expect(captured.length).toBe(1);
  });

  test('successful (non-blocked) PreToolUse hooks let the tool proceed', async () => {
    const captured: Array<{ name: string; args: Record<string, unknown> }> = [];
    const handlers = baseHandlers(captured);
    const executor = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      hookBridge: fakeBridge([{ blocked: false, stderr: '' }]),
    });
    const r = await executor.execute({
      id: 'c3',
      name: 'write_file',
      arguments: { path: 'src/x.ts', content: 'export {}' },
    });
    expect(r.success).toBe(true);
    expect(captured.length).toBe(1);
  });
});

describe('ToolExecutor — PostToolUse hook integration', () => {
  test('PostToolUse non-blocking hook leaves the tool result unchanged', async () => {
    const captured: Array<{ name: string; args: Record<string, unknown> }> = [];
    const handlers = baseHandlers(captured);
    const events: Message[] = [];
    const executor = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      hookBridge: fakeBridge(
        [{ blocked: false, stderr: '' }],
        'PostToolUse',
      ),
      onHookEvent: (m) => events.push(m),
    });
    const r = await executor.execute({
      id: 'c-post-ok',
      name: 'write_file',
      arguments: { path: 'src/x.ts', content: 'x' },
    });
    expect(r.success).toBe(true);
    expect(r.output).toBe('WRITTEN');
    // Non-blocking post-hooks emit no note.
    expect(events.length).toBe(0);
  });

  test('PostToolUse blocking hook does NOT undo the tool but emits a note', async () => {
    const captured: Array<{ name: string; args: Record<string, unknown> }> = [];
    const handlers = baseHandlers(captured);
    const events: Message[] = [];
    const executor = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      hookBridge: fakeBridge(
        [
          {
            blocked: true,
            stderr: 'post-check failed',
            description: 'guard',
          },
        ],
        'PostToolUse',
      ),
      onHookEvent: (m) => events.push(m),
    });
    const r = await executor.execute({
      id: 'c-post-block',
      name: 'write_file',
      arguments: { path: 'src/x.ts', content: 'x' },
    });
    // Tool result is preserved (the action already happened).
    expect(r.success).toBe(true);
    expect(r.output).toBe('WRITTEN');
    expect(captured.length).toBe(1);
    // A note was emitted so the model sees the disapproval.
    expect(events.length).toBe(1);
    expect(events[0]?.content).toContain('PostToolUse');
    expect(events[0]?.content).toContain('post-check failed');
  });
});

describe('ToolExecutor — no hooks configured', () => {
  test('no hookBridge → execute path is identical to before', async () => {
    const captured: Array<{ name: string; args: Record<string, unknown> }> = [];
    const handlers = baseHandlers(captured);
    const executor = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
    });
    const r = await executor.execute({
      id: 'c-nh',
      name: 'write_file',
      arguments: { path: 'src/x.ts', content: 'x' },
    });
    expect(r.success).toBe(true);
    expect(captured.length).toBe(1);
  });

  test('hookBridge present but hasHooksFor returns false → no run() call', async () => {
    const captured: Array<{ name: string; args: Record<string, unknown> }> = [];
    const handlers = baseHandlers(captured);
    let runCalls = 0;
    const bridge: ToolExecutorHookBridge = {
      hasHooksFor: () => false,
      run: async () => {
        runCalls += 1;
        return [];
      },
    };
    const executor = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      hookBridge: bridge,
    });
    const r = await executor.execute({
      id: 'c-fast',
      name: 'write_file',
      arguments: { path: 'a.ts', content: 'x' },
    });
    expect(r.success).toBe(true);
    expect(runCalls).toBe(0);
    expect(captured.length).toBe(1);
  });
});

describe('ToolExecutor — end-to-end with real HookEngine', () => {
  test('blocking PreToolUse engine rejects write_file', async () => {
    const captured: Array<{ name: string; args: Record<string, unknown> }> = [];
    const handlers = baseHandlers(captured);
    const hooks: HookConfig[] = [
      {
        trigger: 'PreToolUse',
        toolPattern: 'write_file',
        // Print stderr + exit non-zero. blocking:true → executor rejects.
        command: "printf 'real-engine-blocked' 1>&2; exit 2",
        blocking: true,
      },
    ];
    const engine = new HookEngine({ hooks });
    const events: Message[] = [];
    const executor = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      hookBridge: engine,
      onHookEvent: (m) => events.push(m),
      projectRoot: os.tmpdir(),
    });
    const r = await executor.execute({
      id: 'c-e2e',
      name: 'write_file',
      arguments: { path: 'src/x.ts', content: 'x' },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('real-engine-blocked');
    // Handler must not have been invoked.
    expect(captured.length).toBe(0);
    // Synthetic note emitted.
    expect(events.length).toBe(1);
  });

  test('toolPattern filters which tools the engine runs against', async () => {
    const captured: Array<{ name: string; args: Record<string, unknown> }> = [];
    const handlers = baseHandlers(captured);
    const hooks: HookConfig[] = [
      // Only matches write_file — read_file should pass through cleanly.
      {
        trigger: 'PreToolUse',
        toolPattern: 'write_file',
        command: 'exit 1',
        blocking: true,
      },
    ];
    const engine = new HookEngine({ hooks });
    const executor = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      hookBridge: engine,
      projectRoot: os.tmpdir(),
    });
    // read_file should not be blocked.
    const readResult: ToolResult = await executor.execute({
      id: 'r1',
      name: 'read_file',
      arguments: { path: 'a.ts' },
    });
    expect(readResult.success).toBe(true);
    // write_file should be blocked.
    const writeResult: ToolResult = await executor.execute({
      id: 'w1',
      name: 'write_file',
      arguments: { path: 'src/x.ts', content: 'x' },
    });
    expect(writeResult.success).toBe(false);
  });
});
