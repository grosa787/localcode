/**
 * ToolExecutor — architecture-rule PreToolUse integration.
 *
 * Covers:
 *   - Violation triggers approval gate (override of acceptEdits-equivalent
 *     auto-approve).
 *   - Synthetic warning is emitted via onAutoCheckResult.
 *   - When the approval callback rejects, the tool call fails.
 *   - When no arch.toml is present, the executor's hot path is unchanged.
 *   - Clean files still bypass the prompt.
 */
import { describe, test, expect } from 'bun:test';
import { ToolExecutor } from '@/llm/tool-executor';
import type { Message } from '@/types/global';
import type { ToolHandlerMap } from '@/types/message';
import type { ArchConfig } from '@/architecture';

function makeHandlers(): {
  handlers: ToolHandlerMap;
  writeCalls: Array<Record<string, unknown>>;
} {
  const writeCalls: Array<Record<string, unknown>> = [];
  const handlers: ToolHandlerMap = {
    write_file: async (args) => {
      writeCalls.push(args);
      return { success: true, output: 'WRITTEN' };
    },
    edit_file: async (args) => {
      writeCalls.push(args);
      return { success: true, output: 'EDITED' };
    },
    read_file: async () => ({ success: true, output: '' }),
    run_command: async () => ({ success: true, output: '' }),
    list_dir: async () => ({ success: true, output: '' }),
    glob_search: async () => ({ success: true, output: '' }),
    lint_file: async () => ({ success: true, output: 'No issues found.' }),
  };
  return { handlers, writeCalls };
}

/** Pre-built arch config that forbids src/llm from being imported by src/ui. */
const ARCH_CONFIG: ArchConfig = {
  rule: [
    {
      id: 'ui-no-llm',
      match: 'src/ui/**/*.ts',
      forbid: ['src/llm/**', '@/llm/**'],
    },
  ],
  global: {
    ignoreImports: ['^bun:.*', '^node:.*'],
  },
};

describe('ToolExecutor — arch PreToolUse', () => {
  test('write_file producing a forbidden import triggers approval gate + synthetic warning', async () => {
    const { handlers, writeCalls } = makeHandlers();
    const events: Message[] = [];
    const approvalCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const exec = new ToolExecutor({
      handlers,
      autoLintAfterWrite: false,
      // dontAsk profile = even auto-approval — but arch override should
      // STILL force the approval prompt.
      profile: 'dontAsk',
      onAutoCheckResult: (m) => events.push(m),
      approvalCallback: async (name, args) => {
        approvalCalls.push({ name, args });
        return true;
      },
      projectRoot: '/tmp/arch-test',
    });
    exec.setArchConfig(ARCH_CONFIG);

    const result = await exec.execute({
      id: 'c1',
      name: 'write_file',
      arguments: {
        path: 'src/ui/main.ts',
        content: `import { x } from '@/llm/adapter';`,
      },
    });

    expect(result.success).toBe(true);
    // Approval gate fired despite the dontAsk profile.
    expect(approvalCalls.length).toBe(1);
    // Synthetic warning emitted.
    expect(events.length).toBe(1);
    expect(events[0]?.content).toContain('Architecture violation');
    expect(events[0]?.content).toContain('ui-no-llm');
    expect(events[0]?.toolName).toBe('arch_rules');
    expect(writeCalls.length).toBe(1);
  });

  test('rejecting the arch approval prompt fails the tool call', async () => {
    const { handlers, writeCalls } = makeHandlers();
    const exec = new ToolExecutor({
      handlers,
      autoLintAfterWrite: false,
      profile: 'dontAsk',
      approvalCallback: async () => false,
      projectRoot: '/tmp/arch-test',
    });
    exec.setArchConfig(ARCH_CONFIG);

    const result = await exec.execute({
      id: 'c2',
      name: 'write_file',
      arguments: {
        path: 'src/ui/main.ts',
        content: `import { x } from '@/llm/adapter';`,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('architecture violation');
    expect(writeCalls.length).toBe(0);
  });

  test('clean file bypasses the gate', async () => {
    const { handlers, writeCalls } = makeHandlers();
    const events: Message[] = [];
    const approvalCalls: Array<{ name: string }> = [];
    const exec = new ToolExecutor({
      handlers,
      autoLintAfterWrite: false,
      profile: 'dontAsk',
      onAutoCheckResult: (m) => events.push(m),
      approvalCallback: async (name) => {
        approvalCalls.push({ name });
        return true;
      },
      projectRoot: '/tmp/arch-test',
    });
    exec.setArchConfig(ARCH_CONFIG);

    const result = await exec.execute({
      id: 'c3',
      name: 'write_file',
      arguments: {
        path: 'src/ui/main.ts',
        content: `export const ok = 1;`,
      },
    });

    expect(result.success).toBe(true);
    expect(approvalCalls.length).toBe(0);
    expect(events.length).toBe(0);
    expect(writeCalls.length).toBe(1);
  });

  test('non-arch-checked tool (run_command) is unaffected', async () => {
    const { handlers } = makeHandlers();
    const approvalCalls: Array<{ name: string }> = [];
    const exec = new ToolExecutor({
      handlers,
      autoLintAfterWrite: false,
      profile: 'dontAsk',
      approvalCallback: async (name) => {
        approvalCalls.push({ name });
        return true;
      },
      projectRoot: '/tmp/arch-test',
    });
    exec.setArchConfig(ARCH_CONFIG);
    const result = await exec.execute({
      id: 'c4',
      name: 'run_command',
      arguments: { command: 'echo hi' },
    });
    expect(result.success).toBe(true);
    expect(approvalCalls.length).toBe(0);
  });

  test('no arch config → zero-overhead pass-through', async () => {
    const { handlers, writeCalls } = makeHandlers();
    const approvalCalls: Array<{ name: string }> = [];
    const exec = new ToolExecutor({
      handlers,
      autoLintAfterWrite: false,
      profile: 'dontAsk',
      approvalCallback: async (name) => {
        approvalCalls.push({ name });
        return true;
      },
      projectRoot: '/tmp/arch-test-no-config',
    });
    exec.setArchConfig(null);
    const result = await exec.execute({
      id: 'c5',
      name: 'write_file',
      arguments: {
        path: 'src/ui/main.ts',
        content: `import { x } from '@/llm/adapter';`,
      },
    });
    expect(result.success).toBe(true);
    expect(approvalCalls.length).toBe(0);
    expect(writeCalls.length).toBe(1);
  });

  test('unmatched file (no rule.match hits) is unaffected', async () => {
    const { handlers, writeCalls } = makeHandlers();
    const approvalCalls: Array<{ name: string }> = [];
    const exec = new ToolExecutor({
      handlers,
      autoLintAfterWrite: false,
      profile: 'dontAsk',
      approvalCallback: async (name) => {
        approvalCalls.push({ name });
        return true;
      },
      projectRoot: '/tmp/arch-test',
    });
    exec.setArchConfig(ARCH_CONFIG);
    const result = await exec.execute({
      id: 'c6',
      name: 'write_file',
      arguments: {
        path: 'src/tools/reader.ts',
        content: `import { x } from '@/llm/adapter';`,
      },
    });
    expect(result.success).toBe(true);
    expect(approvalCalls.length).toBe(0);
    expect(writeCalls.length).toBe(1);
  });

  test('non-source extension (.md) is unaffected', async () => {
    const { handlers, writeCalls } = makeHandlers();
    const approvalCalls: Array<{ name: string }> = [];
    const exec = new ToolExecutor({
      handlers,
      autoLintAfterWrite: false,
      profile: 'dontAsk',
      approvalCallback: async (name) => {
        approvalCalls.push({ name });
        return true;
      },
      projectRoot: '/tmp/arch-test',
    });
    exec.setArchConfig(ARCH_CONFIG);
    const result = await exec.execute({
      id: 'c7',
      name: 'write_file',
      arguments: {
        path: 'src/ui/notes.md',
        content: `import { x } from '@/llm/adapter';`,
      },
    });
    expect(result.success).toBe(true);
    expect(approvalCalls.length).toBe(0);
    expect(writeCalls.length).toBe(1);
  });
});
