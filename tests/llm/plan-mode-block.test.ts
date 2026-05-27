/**
 * Plan-mode block contract — exercises the PLAN-MODE-BLOCK-SECTION in
 * `src/llm/tool-executor.ts`.
 *
 * The companion suite `tests/llm/tool-executor-profiles.test.ts`
 * already covers the wider profile matrix. This file focuses on the
 * specific guarantees the Plan-Mode UX depends on, which form the
 * contract between the executor and `<PlanModeBlockedBadge />`:
 *
 *   1. Blocked tools NEVER invoke their handler — no filesystem / shell
 *      side-effects can occur even if the handler is buggy or async.
 *   2. Blocked tools NEVER invoke the approval callback — no UX prompt
 *      flashes through the surface that would otherwise compete with
 *      the banner.
 *   3. The error payload is `{ success: false, output: '', error: ... }`
 *      with a string that names Plan Mode AND the slash command to
 *      exit. The TUI badge and the model both pattern-match on the
 *      "Plan mode active" prefix; do not regress it.
 *   4. Read-only tools (`read_file`, `list_dir`, `glob_search`,
 *      `lint_file`, `find_symbol`, `fetch_image`) keep running so the
 *      model can investigate before drafting its plan.
 *   5. `dangerouslyAllowAll: true` overrides Plan Mode — legacy escape
 *      hatch contract.
 */

import { describe, expect, test } from 'bun:test';

import { ToolExecutor } from '@/llm/tool-executor';
import type { ToolResult } from '@/types/global';
import type { ToolHandlerMap } from '@/types/message';

interface HandlerSpy {
  readonly handlers: ToolHandlerMap;
  /** Mutable counter; bumped each time any handler is invoked. */
  readonly callCounts: Record<string, number>;
}

/**
 * Build handlers that count their invocations so the test can assert
 * "handler was NEVER called" without relying on side-effects. Each
 * handler resolves to `success: true` so an unexpected invocation
 * would otherwise produce a passing-shaped ToolResult and silently
 * hide the regression.
 */
function makeSpyHandlers(): HandlerSpy {
  const callCounts: Record<string, number> = {};
  const make = (name: string, out: string) => async (): Promise<ToolResult> => {
    callCounts[name] = (callCounts[name] ?? 0) + 1;
    return { success: true, output: out };
  };
  const handlers: ToolHandlerMap = {
    read_file: make('read_file', 'READ_OK'),
    write_file: make('write_file', 'WRITE_OK'),
    edit_file: make('edit_file', 'EDIT_OK'),
    multi_edit: make('multi_edit', 'MULTI_OK'),
    run_command: make('run_command', 'CMD_OK'),
    git_commit: make('git_commit', 'COMMIT_OK'),
    browser_evaluate: make('browser_evaluate', 'EVAL_OK'),
    list_dir: make('list_dir', 'LIST_OK'),
    glob_search: make('glob_search', 'GLOB_OK'),
  };
  return { handlers, callCounts };
}

interface PlanExecHarness {
  readonly callCounts: Record<string, number>;
  readonly approvalCalls: { count: number };
  readonly exec: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
}

function makePlanHarness(): PlanExecHarness {
  const spy = makeSpyHandlers();
  const approvalCalls = { count: 0 };
  const executor = new ToolExecutor({
    handlers: spy.handlers,
    profile: 'plan',
    approvalCallback: async () => {
      approvalCalls.count += 1;
      return true;
    },
  });
  return {
    callCounts: spy.callCounts,
    approvalCalls,
    exec: (name, args) =>
      executor.execute({ id: `t-${name}`, name, arguments: args }),
  };
}

describe('PLAN-MODE-BLOCK-SECTION — handler isolation', () => {
  test('write_file is blocked before the handler runs', async () => {
    const h = makePlanHarness();
    const result = await h.exec('write_file', { path: 'a.ts', content: 'x' });
    expect(result.success).toBe(false);
    expect(h.callCounts['write_file']).toBeUndefined();
    expect(h.approvalCalls.count).toBe(0);
  });

  test('edit_file is blocked before the handler runs', async () => {
    const h = makePlanHarness();
    const result = await h.exec('edit_file', {
      path: 'a.ts',
      find_text: 'a',
      replace_text: 'b',
    });
    expect(result.success).toBe(false);
    expect(h.callCounts['edit_file']).toBeUndefined();
    expect(h.approvalCalls.count).toBe(0);
  });

  test('multi_edit is blocked before the handler runs', async () => {
    const h = makePlanHarness();
    const result = await h.exec('multi_edit', { path: 'a.ts', edits: [] });
    expect(result.success).toBe(false);
    expect(h.callCounts['multi_edit']).toBeUndefined();
  });

  test('run_command is blocked before the handler runs', async () => {
    const h = makePlanHarness();
    const result = await h.exec('run_command', { command: 'rm -rf /' });
    expect(result.success).toBe(false);
    expect(h.callCounts['run_command']).toBeUndefined();
    expect(h.approvalCalls.count).toBe(0);
  });

  test('git_commit is blocked before the handler runs', async () => {
    const h = makePlanHarness();
    const result = await h.exec('git_commit', { message: 'whatever' });
    expect(result.success).toBe(false);
    expect(h.callCounts['git_commit']).toBeUndefined();
  });

  test('browser_evaluate is blocked before the handler runs', async () => {
    const h = makePlanHarness();
    const result = await h.exec('browser_evaluate', { script: 'alert(1)' });
    expect(result.success).toBe(false);
    expect(h.callCounts['browser_evaluate']).toBeUndefined();
  });
});

describe('PLAN-MODE-BLOCK-SECTION — error payload shape', () => {
  test('blocked tool returns { success:false, output:"", error: "Plan mode active …" }', async () => {
    const h = makePlanHarness();
    const result = await h.exec('write_file', { path: 'a.ts', content: 'x' });
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
    // The exact prefix is part of the contract — both the model and
    // the `<PlanModeBlockedBadge />` consumer pattern-match it.
    expect(result.error).toBeDefined();
    expect(result.error ?? '').toContain('Plan mode active');
    // Must point the user at a recovery action.
    expect(result.error ?? '').toContain('/profile default');
  });

  test('error wording is identical across blocked tools', async () => {
    const h = makePlanHarness();
    const a = await h.exec('write_file', { path: 'a.ts', content: 'x' });
    const b = await h.exec('run_command', { command: 'ls' });
    const c = await h.exec('git_commit', { message: 'm' });
    expect(a.error).toBe(b.error);
    expect(b.error).toBe(c.error);
  });
});

describe('PLAN-MODE-BLOCK-SECTION — read-only escape', () => {
  test('read_file still runs (profile=plan)', async () => {
    const h = makePlanHarness();
    const result = await h.exec('read_file', { path: 'a.ts' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('READ_OK');
    expect(h.callCounts['read_file']).toBe(1);
    expect(h.approvalCalls.count).toBe(0);
  });

  test('list_dir still runs', async () => {
    const h = makePlanHarness();
    const result = await h.exec('list_dir', { path: '.' });
    expect(result.success).toBe(true);
    expect(h.callCounts['list_dir']).toBe(1);
  });

  test('glob_search still runs', async () => {
    const h = makePlanHarness();
    const result = await h.exec('glob_search', { pattern: '**/*.ts' });
    expect(result.success).toBe(true);
    expect(h.callCounts['glob_search']).toBe(1);
  });
});

describe('PLAN-MODE-BLOCK-SECTION — dangerouslyAllowAll escape hatch', () => {
  test('dangerouslyAllowAll: true overrides the plan-mode block', async () => {
    const spy = makeSpyHandlers();
    const executor = new ToolExecutor({
      handlers: spy.handlers,
      profile: 'plan',
      dangerouslyAllowAll: true,
    });
    const result = await executor.execute({
      id: 'a',
      name: 'write_file',
      arguments: { path: 'a.ts', content: 'x' },
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe('WRITE_OK');
    expect(spy.callCounts['write_file']).toBe(1);
  });

  test('autoApproveTools allow-list does NOT defeat plan-mode', async () => {
    // The block decision (`resolveApprovalPolicy` rule 2) runs before
    // the per-tool allow-list (rule 3). A user who whitelisted
    // `write_file` separately must still be blocked while plan is on.
    const spy = makeSpyHandlers();
    const executor = new ToolExecutor({
      handlers: spy.handlers,
      profile: 'plan',
      autoApproveTools: ['write_file'],
    });
    const result = await executor.execute({
      id: 'a',
      name: 'write_file',
      arguments: { path: 'a.ts', content: 'x' },
    });
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('Plan mode active');
    expect(spy.callCounts['write_file']).toBeUndefined();
  });
});

describe('PLAN-MODE-BLOCK-SECTION — resolveApprovalPolicy classification', () => {
  test('returns "block" for every edit/command tool under plan', () => {
    const exec = new ToolExecutor({
      handlers: makeSpyHandlers().handlers,
      profile: 'plan',
    });
    expect(exec.resolveApprovalPolicy('write_file')).toBe('block');
    expect(exec.resolveApprovalPolicy('edit_file')).toBe('block');
    expect(exec.resolveApprovalPolicy('multi_edit')).toBe('block');
    expect(exec.resolveApprovalPolicy('run_command')).toBe('block');
    expect(exec.resolveApprovalPolicy('git_commit')).toBe('block');
    expect(exec.resolveApprovalPolicy('browser_evaluate')).toBe('block');
  });

  test('returns "auto" for read-only tools under plan', () => {
    const exec = new ToolExecutor({
      handlers: makeSpyHandlers().handlers,
      profile: 'plan',
    });
    expect(exec.resolveApprovalPolicy('read_file')).toBe('auto');
    expect(exec.resolveApprovalPolicy('list_dir')).toBe('auto');
    expect(exec.resolveApprovalPolicy('glob_search')).toBe('auto');
  });

  test('requiresApproval reports false for blocked tools (block ≠ prompt)', () => {
    // Defense-in-depth — a UI that called requiresApproval() to decide
    // whether to render an ApprovalPrompt must NOT show one for a
    // plan-blocked tool; it should render the PlanModeBlockedBadge
    // instead. Mirrors the same assertion in
    // tool-executor-profiles.test.ts but kept here as a self-contained
    // contract surface for the section.
    const exec = new ToolExecutor({
      handlers: makeSpyHandlers().handlers,
      profile: 'plan',
    });
    expect(exec.requiresApproval('write_file')).toBe(false);
    expect(exec.requiresApproval('run_command')).toBe(false);
  });
});
