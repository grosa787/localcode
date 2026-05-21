/**
 * R2 additions to ToolExecutor — per-tool auto-approval via
 * `autoApproveTools` option (driven by `/permissions`).
 */
import { describe, test, expect } from 'bun:test';
import { ToolExecutor } from '@/llm/tool-executor';
import type { ToolResult } from '@/types/global';
import type { ToolHandlerMap } from '@/types/message';

function makeHandlers(): ToolHandlerMap {
  const handlers: ToolHandlerMap = {
    read_file: async () =>
      ({ success: true, output: 'READ_OK' }) satisfies ToolResult,
    write_file: async () =>
      ({ success: true, output: 'WRITE_OK' }) satisfies ToolResult,
    run_command: async () =>
      ({ success: true, output: 'CMD_OK' }) satisfies ToolResult,
    list_dir: async () =>
      ({ success: true, output: 'LIST_OK' }) satisfies ToolResult,
    glob_search: async () =>
      ({ success: true, output: 'GLOB_OK' }) satisfies ToolResult,
    edit_file: async () =>
      ({ success: true, output: 'EDIT_OK' }) satisfies ToolResult,
    fetch_image: async () =>
      ({ success: true, output: 'FETCH_OK' }) satisfies ToolResult,
  };
  return handlers;
}

describe('ToolExecutor — autoApproveTools', () => {
  test('bypasses approvalCallback for a tool in autoApproveTools', async () => {
    let approvalCalls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => {
        approvalCalls += 1;
        return false; // would reject if called
      },
      autoApproveTools: ['write_file'],
    });

    const result = await exec.execute({
      id: 'c1',
      name: 'write_file',
      arguments: { path: 'x.ts', content: 'y' },
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe('WRITE_OK');
    expect(approvalCalls).toBe(0);
  });

  test('tools NOT in autoApproveTools still go through approval', async () => {
    let approvalCalls = 0;
    let seenTool = '';
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async (name) => {
        approvalCalls += 1;
        seenTool = name;
        return true;
      },
      autoApproveTools: ['write_file'], // run_command NOT in list
    });

    const result = await exec.execute({
      id: 'c2',
      name: 'run_command',
      arguments: { command: 'ls' },
    });
    expect(result.success).toBe(true);
    expect(approvalCalls).toBe(1);
    expect(seenTool).toBe('run_command');
  });

  test('approval rejection still wins when tool is not pre-approved', async () => {
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => false,
      autoApproveTools: ['write_file'],
    });
    const result = await exec.execute({
      id: 'c3',
      name: 'run_command',
      arguments: { command: 'rm -rf /' },
    });
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('rejected');
  });

  test('empty autoApproveTools preserves approval for every destructive tool', async () => {
    let calls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => {
        calls += 1;
        return true;
      },
      autoApproveTools: [],
    });
    await exec.execute({
      id: 'c4',
      name: 'write_file',
      arguments: { path: 'a', content: 'b' },
    });
    await exec.execute({
      id: 'c5',
      name: 'run_command',
      arguments: { command: 'ls' },
    });
    expect(calls).toBe(2);
  });

  test('read_file is always auto-approved (never hits callback even without listing)', async () => {
    let calls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => {
        calls += 1;
        return false;
      },
      autoApproveTools: [],
    });
    const res = await exec.execute({
      id: 'c6',
      name: 'read_file',
      arguments: { path: 'a' },
    });
    expect(res.success).toBe(true);
    expect(calls).toBe(0);
  });
});

describe('ToolExecutor — dangerouslyAllowAll', () => {
  test('overrides everything: approval, autoApprove, per-tool rules', async () => {
    let calls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => {
        calls += 1;
        return false;
      },
      autoApproveTools: [],
      dangerouslyAllowAll: true,
    });
    const r1 = await exec.execute({
      id: 'a1',
      name: 'write_file',
      arguments: { path: 'x', content: 'y' },
    });
    const r2 = await exec.execute({
      id: 'a2',
      name: 'run_command',
      arguments: { command: 'rm -rf' },
    });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(calls).toBe(0);
  });
});

describe('ToolExecutor.requiresApproval', () => {
  test('returns false for read-only tools regardless of settings', () => {
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      autoApproveTools: [],
    });
    expect(exec.requiresApproval('read_file')).toBe(false);
    expect(exec.requiresApproval('list_dir')).toBe(false);
    expect(exec.requiresApproval('glob_search')).toBe(false);
  });

  test('returns true for write_file / run_command by default', () => {
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      autoApproveTools: [],
    });
    expect(exec.requiresApproval('write_file')).toBe(true);
    expect(exec.requiresApproval('run_command')).toBe(true);
  });

  test('returns false after granting via autoApproveTools', () => {
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      autoApproveTools: ['write_file'],
    });
    expect(exec.requiresApproval('write_file')).toBe(false);
    // run_command still gated
    expect(exec.requiresApproval('run_command')).toBe(true);
  });

  test('dangerouslyAllowAll disables approval for every tool', () => {
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      dangerouslyAllowAll: true,
    });
    expect(exec.requiresApproval('write_file')).toBe(false);
    expect(exec.requiresApproval('run_command')).toBe(false);
    expect(exec.requiresApproval('read_file')).toBe(false);
  });
});
