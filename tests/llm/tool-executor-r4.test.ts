/**
 * R4 additions to ToolExecutor — auto-lint post-commit hook (FIX #27).
 *
 * Covered behaviour:
 *   - Auto-lint hook fires after a successful `write_file` commit on a
 *     lintable extension (.ts).
 *   - Hook does NOT fire for ignored extensions (.md).
 *   - `autoLintAfterWrite: false` disables the hook.
 *   - `setPostCommitHook(customHook)` replaces the default hook.
 *   - `onAutoCheckResult` receives a synthetic `tool`-role Message.
 *   - The original ToolResult returned to `execute()` is unchanged
 *     (i.e. additive, not a replacement).
 */
import { describe, test, expect } from 'bun:test';
import { ToolExecutor } from '@/llm/tool-executor';
import type { Message, ToolResult } from '@/types/global';
import type { ToolHandlerMap, PostCommitHook } from '@/types/message';

function makeHandlersWithLint(
  lintImpl?: (args: Record<string, unknown>) => Promise<ToolResult>,
): {
  handlers: ToolHandlerMap;
  lintCalls: Array<Record<string, unknown>>;
  writeCalls: Array<Record<string, unknown>>;
} {
  const lintCalls: Array<Record<string, unknown>> = [];
  const writeCalls: Array<Record<string, unknown>> = [];
  const handlers: ToolHandlerMap = {
    read_file: async () => ({ success: true, output: 'READ' }),
    write_file: async (args) => {
      writeCalls.push(args);
      return { success: true, output: 'WRITTEN' };
    },
    edit_file: async (args) => {
      writeCalls.push(args);
      return { success: true, output: 'EDITED' };
    },
    run_command: async () => ({ success: true, output: 'RAN' }),
    list_dir: async () => ({ success: true, output: '' }),
    glob_search: async () => ({ success: true, output: '' }),
    fetch_image: async () => ({ success: true, output: '' }),
    lint_file:
      lintImpl ??
      (async (args: Record<string, unknown>) => {
        lintCalls.push(args);
        return { success: true, output: 'No issues found.' };
      }),
  };
  return { handlers, lintCalls, writeCalls };
}

describe('ToolExecutor — auto-lint post-commit hook', () => {
  test('fires lint_file after a successful write_file with .ts extension', async () => {
    const { handlers, lintCalls } = makeHandlersWithLint();
    const synthetics: Message[] = [];

    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });

    const result = await exec.execute({
      id: 'c1',
      name: 'write_file',
      arguments: { path: 'src/example.ts', content: 'export {}' },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('WRITTEN');
    // The lint handler must have been called with the same path.
    expect(lintCalls.length).toBe(1);
    expect(lintCalls[0]?.['path']).toBe('src/example.ts');
    // A synthetic Message must have been delivered.
    expect(synthetics.length).toBe(1);
    const msg = synthetics[0]!;
    expect(msg.role).toBe('tool');
    expect(msg.toolName).toBe('lint_file');
    expect(typeof msg.id).toBe('string');
    expect(msg.id.length > 0).toBe(true);
  });

  test('also fires after a successful edit_file commit', async () => {
    const { handlers, lintCalls } = makeHandlersWithLint();
    const synthetics: Message[] = [];

    const exec = new ToolExecutor({
      handlers,
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });

    await exec.execute({
      id: 'c2',
      name: 'edit_file',
      arguments: {
        path: 'src/file.tsx',
        find_text: 'a',
        replace_text: 'b',
      },
    });

    expect(lintCalls.length).toBe(1);
    expect(synthetics.length).toBe(1);
  });

  test('does NOT fire for ignored extensions like .md', async () => {
    const { handlers, lintCalls } = makeHandlersWithLint();
    const synthetics: Message[] = [];

    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });

    const result = await exec.execute({
      id: 'c3',
      name: 'write_file',
      arguments: { path: 'README.md', content: '# hi' },
    });

    expect(result.success).toBe(true);
    expect(lintCalls.length).toBe(0);
    expect(synthetics.length).toBe(0);
  });

  test('does NOT fire for files without an extension', async () => {
    const { handlers, lintCalls } = makeHandlersWithLint();
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });
    await exec.execute({
      id: 'c-no-ext',
      name: 'write_file',
      arguments: { path: 'Makefile', content: 'all:\n\techo hi' },
    });
    expect(lintCalls.length).toBe(0);
    expect(synthetics.length).toBe(0);
  });

  test('does NOT fire when write_file fails (success: false)', async () => {
    const { handlers, lintCalls } = makeHandlersWithLint();
    const synthetics: Message[] = [];
    handlers['write_file'] = async () => ({
      success: false,
      output: '',
      error: 'permission denied',
    });

    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });

    const result = await exec.execute({
      id: 'c4',
      name: 'write_file',
      arguments: { path: 'a.ts', content: 'x' },
    });

    expect(result.success).toBe(false);
    expect(lintCalls.length).toBe(0);
    expect(synthetics.length).toBe(0);
  });

  test('does NOT fire for non-mutating tools (read_file, run_command)', async () => {
    const { handlers, lintCalls } = makeHandlersWithLint();
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['run_command'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });
    await exec.execute({
      id: 'c5a',
      name: 'read_file',
      arguments: { path: 'a.ts' },
    });
    await exec.execute({
      id: 'c5b',
      name: 'run_command',
      arguments: { command: 'ls' },
    });
    expect(lintCalls.length).toBe(0);
    expect(synthetics.length).toBe(0);
  });

  test('autoLintAfterWrite: false disables the hook', async () => {
    const { handlers, lintCalls } = makeHandlersWithLint();
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: false,
      onAutoCheckResult: (m) => synthetics.push(m),
    });
    await exec.execute({
      id: 'c6',
      name: 'write_file',
      arguments: { path: 'src/x.ts', content: 'x' },
    });
    expect(lintCalls.length).toBe(0);
    expect(synthetics.length).toBe(0);
  });

  test('default hook produces a synthetic tool-role Message with content', async () => {
    const { handlers } = makeHandlersWithLint(async () => ({
      success: true,
      output: 'No issues found.',
    }));
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });
    await exec.execute({
      id: 'c7',
      name: 'write_file',
      arguments: { path: 'src/foo.ts', content: 'x' },
    });
    expect(synthetics.length).toBe(1);
    const m = synthetics[0]!;
    expect(m.role).toBe('tool');
    expect(m.toolName).toBe('lint_file');
    expect(typeof m.content).toBe('string');
    // The "no issues" path embeds the path in the content.
    expect(m.content).toContain('src/foo.ts');
  });

  test('issue-bearing lint output yields a "please fix" hint', async () => {
    const { handlers } = makeHandlersWithLint(async () => ({
      success: true,
      output: 'Found 1 diagnostic:\n  ERROR 3:5 [TS2322] Type mismatch',
    }));
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });
    await exec.execute({
      id: 'c-issues',
      name: 'write_file',
      arguments: { path: 'src/bad.ts', content: 'x' },
    });
    expect(synthetics.length).toBe(1);
    const m = synthetics[0]!;
    expect(m.content).toContain('Post-edit check');
    expect(m.content).toContain('please fix');
    expect(m.content).toContain('Found 1 diagnostic');
  });

  test('original ToolResult is unchanged regardless of lint outcome', async () => {
    const { handlers } = makeHandlersWithLint(async () => ({
      success: true,
      output: 'Found 5 diagnostics:\n  ERROR ...',
    }));
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
    });
    const r = await exec.execute({
      id: 'c-orig',
      name: 'write_file',
      arguments: { path: 'src/p.ts', content: 'x' },
    });
    expect(r.success).toBe(true);
    expect(r.output).toBe('WRITTEN');
    // No bleed of lint diagnostics into the primary output.
    expect(r.output.includes('Found')).toBe(false);
  });

  test('skipping lint output (no linter installed) does not include "please fix" hint', async () => {
    const { handlers } = makeHandlersWithLint(async () => ({
      success: true,
      output: 'Linter for ts/tsx/js/jsx not installed (bunx); skipping check.',
    }));
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });
    await exec.execute({
      id: 'c-skip',
      name: 'write_file',
      arguments: { path: 'src/skip.ts', content: 'x' },
    });
    expect(synthetics.length).toBe(1);
    expect(synthetics[0]!.content).not.toContain('please fix');
  });

  test('hook failure (lint handler throws) does not crash execute()', async () => {
    const { handlers } = makeHandlersWithLint(async () => {
      throw new Error('linter exploded');
    });
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });
    const r = await exec.execute({
      id: 'c-throw',
      name: 'write_file',
      arguments: { path: 'src/t.ts', content: 'x' },
    });
    // Original tool succeeded; auto-check just emitted nothing.
    expect(r.success).toBe(true);
    expect(synthetics.length).toBe(0);
  });

  test('default hook returns null when no lint_file handler is registered', async () => {
    // Build handlers WITHOUT lint_file
    const { handlers } = makeHandlersWithLint();
    delete (handlers as Record<string, unknown>)['lint_file'];
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });
    await exec.execute({
      id: 'c-no-lint',
      name: 'write_file',
      arguments: { path: 'src/no.ts', content: 'x' },
    });
    // No lint_file → hook returns null → no synthetic message
    expect(synthetics.length).toBe(0);
  });
});

describe('ToolExecutor — setPostCommitHook', () => {
  test('replacing the hook bypasses the default auto-lint behaviour', async () => {
    const { handlers, lintCalls } = makeHandlersWithLint();
    const customCalls: Array<{
      toolName: string;
      args: Record<string, unknown>;
    }> = [];
    const synthetics: Message[] = [];

    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });

    const customHook: PostCommitHook = async (toolName, args) => {
      customCalls.push({ toolName, args });
      return {
        success: true,
        output: 'CUSTOM_HOOK_OUTPUT',
      };
    };
    exec.setPostCommitHook(customHook);

    await exec.execute({
      id: 'c-custom',
      name: 'write_file',
      arguments: { path: 'src/c.ts', content: 'x' },
    });

    // Custom hook fires; default lint does NOT.
    expect(customCalls.length).toBe(1);
    expect(customCalls[0]?.toolName).toBe('write_file');
    expect(lintCalls.length).toBe(0);
    // The custom hook returned a non-null ToolResult, so a synthetic
    // message was emitted.
    expect(synthetics.length).toBe(1);
    expect(synthetics[0]!.content).toContain('CUSTOM_HOOK_OUTPUT');
  });

  test('a hook returning null suppresses the synthetic message', async () => {
    const { handlers } = makeHandlersWithLint();
    const synthetics: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => synthetics.push(m),
    });
    exec.setPostCommitHook(async () => null);

    const r = await exec.execute({
      id: 'c-null',
      name: 'write_file',
      arguments: { path: 'src/n.ts', content: 'x' },
    });
    expect(r.success).toBe(true);
    expect(synthetics.length).toBe(0);
  });

  test('a hook that throws does not break the primary tool result', async () => {
    const { handlers } = makeHandlersWithLint();
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
    });
    exec.setPostCommitHook(async () => {
      throw new Error('boom');
    });

    const r = await exec.execute({
      id: 'c-boom',
      name: 'write_file',
      arguments: { path: 'src/x.ts', content: 'x' },
    });
    expect(r.success).toBe(true);
    expect(r.output).toBe('WRITTEN');
  });
});

describe('ToolExecutor — onAutoCheckResult callback', () => {
  test('callback that throws does not affect the primary tool result', async () => {
    const { handlers } = makeHandlersWithLint();
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: () => {
        throw new Error('callback exploded');
      },
    });
    const r = await exec.execute({
      id: 'c-cb-throw',
      name: 'write_file',
      arguments: { path: 'src/y.ts', content: 'x' },
    });
    expect(r.success).toBe(true);
    expect(r.output).toBe('WRITTEN');
  });

  test('synthetic message has a unique id per invocation', async () => {
    const { handlers } = makeHandlersWithLint();
    const collected: Message[] = [];
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['write_file'],
      autoLintAfterWrite: true,
      onAutoCheckResult: (m) => collected.push(m),
    });
    await exec.execute({
      id: 'a',
      name: 'write_file',
      arguments: { path: 'src/a.ts', content: '' },
    });
    await exec.execute({
      id: 'b',
      name: 'write_file',
      arguments: { path: 'src/b.ts', content: '' },
    });
    expect(collected.length).toBe(2);
    expect(collected[0]!.id !== collected[1]!.id).toBe(true);
  });
});
