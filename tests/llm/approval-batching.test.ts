/**
 * Wave 5A (TA team) — approval batching for `[A]` (turn-scoped) and
 * `[S]` (session-scoped) buttons in `<ApprovalPrompt>`.
 *
 *   - `[A]` (approveAllInTurn) → every subsequent matching tool call
 *     this turn auto-approves. Reset by `resetTurnAutoApprove()` which
 *     the runtime calls at the start of every new user message.
 *   - `[S]` (approveForSession) → only meaningful for `run_command`.
 *     The exact command string is added to a process-scoped allow-list
 *     so future identical invocations auto-approve. NOT reset between
 *     turns; persists for the lifetime of the executor.
 *
 * The richer return shape goes through `toApprovalDecision` which
 * narrows either a `boolean` or an `ApprovalDecision` object. We
 * exercise both shapes to lock the contract.
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
    edit_file: async () =>
      ({ success: true, output: 'EDIT_OK' }) satisfies ToolResult,
  };
  return handlers;
}

describe('ToolExecutor — turn-scoped batch approval ([A] button)', () => {
  test('approveAllInTurn=true admits subsequent identical tool calls without re-prompt', async () => {
    let approvalCalls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => {
        approvalCalls += 1;
        // Simulate the `[A]` button — approve + flag the turn.
        return { approved: true, approveAllInTurn: true };
      },
    });

    const r1 = await exec.execute({
      id: '1',
      name: 'write_file',
      arguments: { path: 'a.ts', content: 'a' },
    });
    const r2 = await exec.execute({
      id: '2',
      name: 'write_file',
      arguments: { path: 'b.ts', content: 'b' },
    });
    const r3 = await exec.execute({
      id: '3',
      name: 'write_file',
      arguments: { path: 'c.ts', content: 'c' },
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);
    // The callback was invoked exactly once — first call asks, the
    // batch flag handles the next two.
    expect(approvalCalls).toBe(1);
    // Confirm the turn-scoped set actually carries write_file.
    expect(exec.getTurnAutoApprove().has('write_file')).toBe(true);
  });

  test('resetTurnAutoApprove clears the per-turn batch set between turns', async () => {
    let approvalCalls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => {
        approvalCalls += 1;
        return { approved: true, approveAllInTurn: true };
      },
    });

    await exec.execute({
      id: '1',
      name: 'write_file',
      arguments: { path: 'a.ts', content: 'a' },
    });
    expect(exec.getTurnAutoApprove().has('write_file')).toBe(true);

    // Simulate the runtime invoking resetTurnAutoApprove() at the
    // start of the next user message.
    exec.resetTurnAutoApprove();
    expect(exec.getTurnAutoApprove().size).toBe(0);

    // Next turn's first write_file call must prompt again.
    await exec.execute({
      id: '2',
      name: 'write_file',
      arguments: { path: 'b.ts', content: 'b' },
    });
    expect(approvalCalls).toBe(2);
  });

  test('approveAllInTurn does NOT cross tool boundaries', async () => {
    let writeCalls = 0;
    let runCalls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async (name) => {
        if (name === 'write_file') writeCalls += 1;
        if (name === 'run_command') runCalls += 1;
        return { approved: true, approveAllInTurn: true };
      },
    });

    // write_file is batch-approved.
    await exec.execute({
      id: '1',
      name: 'write_file',
      arguments: { path: 'a.ts', content: 'a' },
    });
    await exec.execute({
      id: '2',
      name: 'write_file',
      arguments: { path: 'b.ts', content: 'b' },
    });
    expect(writeCalls).toBe(1);

    // run_command is a DIFFERENT tool — must prompt again.
    await exec.execute({
      id: '3',
      name: 'run_command',
      arguments: { command: 'ls' },
    });
    expect(runCalls).toBe(1);
  });
});

describe('ToolExecutor — session-scoped command allow-list ([S] button)', () => {
  test('approveForSession persists across turns for the exact command string', async () => {
    let approvalCalls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => {
        approvalCalls += 1;
        return { approved: true, approveForSession: true };
      },
    });

    // First call — prompts, then adds the command to the allow-list.
    await exec.execute({
      id: '1',
      name: 'run_command',
      arguments: { command: 'pnpm test' },
    });
    expect(approvalCalls).toBe(1);
    expect(exec.getAutoApproveCommands().has('pnpm test')).toBe(true);

    // Reset the turn — `[S]` decisions MUST survive the reset (this
    // is the load-bearing difference vs `[A]`).
    exec.resetTurnAutoApprove();

    // Second turn, identical command — no re-prompt.
    await exec.execute({
      id: '2',
      name: 'run_command',
      arguments: { command: 'pnpm test' },
    });
    expect(approvalCalls).toBe(1);
  });

  test('approveForSession does not auto-approve a different command', async () => {
    let approvalCalls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => {
        approvalCalls += 1;
        return { approved: true, approveForSession: true };
      },
    });

    await exec.execute({
      id: '1',
      name: 'run_command',
      arguments: { command: 'pnpm test' },
    });
    expect(approvalCalls).toBe(1);

    // Different command — exact-match allow-list does not cover this.
    await exec.execute({
      id: '2',
      name: 'run_command',
      arguments: { command: 'rm -rf node_modules' },
    });
    expect(approvalCalls).toBe(2);
  });

  test('approveForSession is ignored for tools other than run_command', async () => {
    let approvalCalls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => {
        approvalCalls += 1;
        return { approved: true, approveForSession: true };
      },
    });

    // write_file approvals do NOT populate the session command set
    // (the executor only extracts a command for run_command).
    await exec.execute({
      id: '1',
      name: 'write_file',
      arguments: { path: 'a.ts', content: 'a' },
    });
    expect(exec.getAutoApproveCommands().size).toBe(0);

    // Without a session-scoped match, the second write_file MUST still
    // prompt (no turn-scope flag was set either).
    await exec.execute({
      id: '2',
      name: 'write_file',
      arguments: { path: 'b.ts', content: 'b' },
    });
    expect(approvalCalls).toBe(2);
  });
});

describe('ToolExecutor — boolean callback shape stays backwards-compatible', () => {
  test('legacy boolean true approves without any batching flag set', async () => {
    let approvalCalls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => {
        approvalCalls += 1;
        return true;
      },
    });

    await exec.execute({
      id: '1',
      name: 'write_file',
      arguments: { path: 'a.ts', content: 'a' },
    });
    await exec.execute({
      id: '2',
      name: 'write_file',
      arguments: { path: 'b.ts', content: 'b' },
    });
    expect(approvalCalls).toBe(2);
    expect(exec.getTurnAutoApprove().size).toBe(0);
    expect(exec.getAutoApproveCommands().size).toBe(0);
  });

  test('legacy boolean false still rejects (no batching path)', async () => {
    const exec = new ToolExecutor({
      handlers: makeHandlers(),
      approvalCallback: async () => false,
    });
    const r = await exec.execute({
      id: '1',
      name: 'write_file',
      arguments: { path: 'a.ts', content: 'a' },
    });
    expect(r.success).toBe(false);
    expect(r.error ?? '').toContain('rejected');
  });
});
