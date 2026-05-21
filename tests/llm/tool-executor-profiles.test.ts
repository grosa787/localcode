/**
 * ToolExecutor — profile matrix tests.
 *
 * Each profile × each representative tool from the four buckets:
 *   - read_file           (read-only, always auto)
 *   - write_file          (APPROVAL_REQUIRED, edit tool)
 *   - edit_file           (NOT in APPROVAL_REQUIRED, edit tool — uses
 *                         two-phase preview/commit; profile-wise it is
 *                         still classified as an edit tool)
 *   - run_command         (APPROVAL_REQUIRED, command tool)
 *   - git_commit          (APPROVAL_REQUIRED, command tool)
 *   - browser_evaluate    (APPROVAL_REQUIRED_TOOLS_EXTRA, command tool)
 *
 * Verifies block / auto / prompt outcomes per profile, plus the
 * backwards-compat `dangerouslyAllowAll: true` shortcut.
 */

import { describe, expect, test } from 'bun:test';

import { ToolExecutor } from '@/llm/tool-executor';
import type { PermissionProfile, ToolResult } from '@/types/global';
import type { ToolHandlerMap } from '@/types/message';

function makeHandlers(): ToolHandlerMap {
  const ok = (out: string) => async () =>
    ({ success: true, output: out }) satisfies ToolResult;
  return {
    read_file: ok('READ_OK'),
    write_file: ok('WRITE_OK'),
    edit_file: ok('EDIT_OK'),
    run_command: ok('CMD_OK'),
    git_commit: ok('COMMIT_OK'),
    browser_evaluate: ok('EVAL_OK'),
  };
}

interface Outcome {
  result: ToolResult;
  approvalCalls: number;
}

async function exec(
  profile: PermissionProfile,
  name: string,
  args: Record<string, unknown>,
  approvalAnswer: boolean = true,
): Promise<Outcome> {
  let approvalCalls = 0;
  const executor = new ToolExecutor({
    handlers: makeHandlers(),
    profile,
    approvalCallback: async () => {
      approvalCalls += 1;
      return approvalAnswer;
    },
  });
  const result = await executor.execute({ id: 't1', name, arguments: args });
  return { result, approvalCalls };
}

describe('ToolExecutor — profile: default', () => {
  test('read_file runs without approval', async () => {
    const { result, approvalCalls } = await exec('default', 'read_file', {
      path: 'a',
    });
    expect(result.success).toBe(true);
    expect(approvalCalls).toBe(0);
  });

  test('write_file prompts for approval', async () => {
    const { result, approvalCalls } = await exec('default', 'write_file', {
      path: 'a',
      content: 'b',
    });
    expect(result.success).toBe(true);
    expect(approvalCalls).toBe(1);
  });

  test('edit_file runs without approval (two-phase preview/commit)', async () => {
    // `edit_file` is NOT in APPROVAL_REQUIRED_TOOLS — the diff
    // confirmation in the UI serves as the implicit approval.
    const { approvalCalls } = await exec('default', 'edit_file', { path: 'a' });
    expect(approvalCalls).toBe(0);
  });

  test('run_command prompts for approval', async () => {
    const { result, approvalCalls } = await exec('default', 'run_command', {
      command: 'ls',
    });
    expect(result.success).toBe(true);
    expect(approvalCalls).toBe(1);
  });

  test('git_commit prompts for approval', async () => {
    const { approvalCalls } = await exec('default', 'git_commit', {
      message: 'msg',
    });
    expect(approvalCalls).toBe(1);
  });

  test('browser_evaluate prompts for approval', async () => {
    const { approvalCalls } = await exec('default', 'browser_evaluate', {
      script: 'alert(1)',
    });
    expect(approvalCalls).toBe(1);
  });
});

describe('ToolExecutor — profile: acceptEdits', () => {
  test('write_file auto-approved', async () => {
    const { result, approvalCalls } = await exec('acceptEdits', 'write_file', {
      path: 'a',
      content: 'b',
    });
    expect(result.success).toBe(true);
    expect(approvalCalls).toBe(0);
  });

  test('edit_file auto-approved (already two-phase, but still bucketed as edit)', async () => {
    const { approvalCalls } = await exec('acceptEdits', 'edit_file', {
      path: 'a',
    });
    expect(approvalCalls).toBe(0);
  });

  test('run_command STILL prompts', async () => {
    const { approvalCalls } = await exec('acceptEdits', 'run_command', {
      command: 'ls',
    });
    expect(approvalCalls).toBe(1);
  });

  test('git_commit STILL prompts', async () => {
    const { approvalCalls } = await exec('acceptEdits', 'git_commit', {
      message: 'msg',
    });
    expect(approvalCalls).toBe(1);
  });

  test('browser_evaluate STILL prompts', async () => {
    const { approvalCalls } = await exec('acceptEdits', 'browser_evaluate', {
      script: 'x',
    });
    expect(approvalCalls).toBe(1);
  });
});

describe('ToolExecutor — profile: plan (Plan Mode)', () => {
  test('read_file still runs (read-only)', async () => {
    const { result, approvalCalls } = await exec('plan', 'read_file', {
      path: 'a',
    });
    expect(result.success).toBe(true);
    expect(approvalCalls).toBe(0);
  });

  test('write_file BLOCKED with structured error', async () => {
    const { result, approvalCalls } = await exec('plan', 'write_file', {
      path: 'a',
      content: 'b',
    });
    expect(result.success).toBe(false);
    expect(approvalCalls).toBe(0);
    expect(result.output).toBe('');
    expect(result.error).toContain('Plan mode active');
    expect(result.error).toContain('/profile default');
  });

  test('edit_file BLOCKED', async () => {
    const { result } = await exec('plan', 'edit_file', { path: 'a' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Plan mode active');
  });

  test('run_command BLOCKED', async () => {
    const { result } = await exec('plan', 'run_command', { command: 'ls' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Plan mode active');
  });

  test('git_commit BLOCKED', async () => {
    const { result } = await exec('plan', 'git_commit', { message: 'm' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Plan mode active');
  });

  test('browser_evaluate BLOCKED', async () => {
    const { result } = await exec('plan', 'browser_evaluate', { script: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Plan mode active');
  });

  test('plan ignores autoApproveTools whitelist for edit tools', async () => {
    let approvalCalls = 0;
    const executor = new ToolExecutor({
      handlers: makeHandlers(),
      profile: 'plan',
      autoApproveTools: ['write_file'],
      approvalCallback: async () => {
        approvalCalls += 1;
        return true;
      },
    });
    const result = await executor.execute({
      id: 't',
      name: 'write_file',
      arguments: { path: 'a', content: 'b' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Plan mode active');
    expect(approvalCalls).toBe(0);
  });
});

describe('ToolExecutor — profile: dontAsk', () => {
  test('write_file auto-approved', async () => {
    const { approvalCalls } = await exec('dontAsk', 'write_file', {
      path: 'a',
      content: 'b',
    });
    expect(approvalCalls).toBe(0);
  });

  test('run_command auto-approved', async () => {
    const { approvalCalls } = await exec('dontAsk', 'run_command', {
      command: 'ls',
    });
    expect(approvalCalls).toBe(0);
  });

  test('git_commit auto-approved', async () => {
    const { approvalCalls } = await exec('dontAsk', 'git_commit', {
      message: 'm',
    });
    expect(approvalCalls).toBe(0);
  });

  test('browser_evaluate auto-approved', async () => {
    const { approvalCalls } = await exec('dontAsk', 'browser_evaluate', {
      script: 'x',
    });
    expect(approvalCalls).toBe(0);
  });
});

describe('ToolExecutor — profile: bypassPermissions', () => {
  test('write_file auto-approved (same executor semantics as dontAsk)', async () => {
    const { approvalCalls } = await exec(
      'bypassPermissions',
      'write_file',
      { path: 'a', content: 'b' },
    );
    expect(approvalCalls).toBe(0);
  });

  test('run_command auto-approved', async () => {
    const { approvalCalls } = await exec(
      'bypassPermissions',
      'run_command',
      { command: 'ls' },
    );
    expect(approvalCalls).toBe(0);
  });
});

describe('ToolExecutor — backwards compat: dangerouslyAllowAll', () => {
  test('overrides every profile, including plan', async () => {
    let approvalCalls = 0;
    const executor = new ToolExecutor({
      handlers: makeHandlers(),
      profile: 'plan',
      dangerouslyAllowAll: true,
      approvalCallback: async () => {
        approvalCalls += 1;
        return false;
      },
    });
    const result = await executor.execute({
      id: 'x',
      name: 'write_file',
      arguments: { path: 'a', content: 'b' },
    });
    // `dangerouslyAllowAll: true` short-circuits BEFORE the plan-mode
    // block fires — same legacy contract as before. Existing tests
    // that pass the flag must keep passing.
    expect(result.success).toBe(true);
    expect(approvalCalls).toBe(0);
  });

  test('dangerouslyAllowAll: true without `profile` still works (legacy default)', async () => {
    let approvalCalls = 0;
    const executor = new ToolExecutor({
      handlers: makeHandlers(),
      dangerouslyAllowAll: true,
      approvalCallback: async () => {
        approvalCalls += 1;
        return false;
      },
    });
    const r1 = await executor.execute({
      id: 'a',
      name: 'write_file',
      arguments: { path: 'a', content: 'b' },
    });
    const r2 = await executor.execute({
      id: 'b',
      name: 'run_command',
      arguments: { command: 'ls' },
    });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(approvalCalls).toBe(0);
  });
});

describe('ToolExecutor.resolveApprovalPolicy', () => {
  test('returns "block" for edit/command tools under plan', () => {
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      profile: 'plan',
    });
    expect(exec.resolveApprovalPolicy('write_file')).toBe('block');
    expect(exec.resolveApprovalPolicy('edit_file')).toBe('block');
    expect(exec.resolveApprovalPolicy('run_command')).toBe('block');
    expect(exec.resolveApprovalPolicy('git_commit')).toBe('block');
    expect(exec.resolveApprovalPolicy('browser_evaluate')).toBe('block');
    // Read-only tools still run.
    expect(exec.resolveApprovalPolicy('read_file')).toBe('auto');
  });

  test('returns "auto" for everything under dontAsk', () => {
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      profile: 'dontAsk',
    });
    expect(exec.resolveApprovalPolicy('write_file')).toBe('auto');
    expect(exec.resolveApprovalPolicy('run_command')).toBe('auto');
    expect(exec.resolveApprovalPolicy('git_commit')).toBe('auto');
  });

  test('autoApproveTools allow-list short-circuits under default', () => {
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      profile: 'default',
      autoApproveTools: ['write_file'],
    });
    expect(exec.resolveApprovalPolicy('write_file')).toBe('auto');
    expect(exec.resolveApprovalPolicy('run_command')).toBe('prompt');
  });

  test('requiresApproval mirrors resolveApprovalPolicy === "prompt"', () => {
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      profile: 'default',
    });
    expect(exec.requiresApproval('write_file')).toBe(true);
    expect(exec.requiresApproval('read_file')).toBe(false);
    // Plan-mode "block" is NOT a prompt — make sure requiresApproval is false.
    const planExec = new ToolExecutor({
      handlers: makeHandlers(),
      profile: 'plan',
    });
    expect(planExec.requiresApproval('write_file')).toBe(false);
  });
});
