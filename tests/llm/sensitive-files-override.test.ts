/**
 * Sensitive-files override — ToolExecutor gate tests.
 *
 * Verifies the SENSITIVE-FILES-SECTION integration in `tool-executor.ts`:
 *   - A sensitive path forces the approval prompt even under `dontAsk`.
 *   - A non-sensitive path under `dontAsk` stays on the fast path.
 *   - `default` profile still prompts for sensitive paths (no regression).
 *   - Read-only tools (`read_file`, `list_dir`) are gated when their
 *     target is sensitive — overrides the "read-only is auto" rule.
 *   - The sensitive enrichment fields (`__sensitive`, etc.) flow into
 *     `approvalCallback` args so the UI can render the banner.
 *
 * The sensitive config is injected via `setSensitiveConfig(...)` so the
 * tests don't touch the real `~/.localcode/sensitive-files.toml`.
 */

import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

import { ToolExecutor } from '@/llm/tool-executor';
import type { SensitiveConfig } from '@/security/sensitive-files';
import type { ToolResult } from '@/types/global';
import type { ToolHandlerMap } from '@/types/message';

function makeHandlers(captured: Array<{ name: string; args: Record<string, unknown> }> = []): ToolHandlerMap {
  return {
    read_file: async (args) => {
      captured.push({ name: 'read_file', args });
      return { success: true, output: 'READ' } satisfies ToolResult;
    },
    write_file: async (args) => {
      captured.push({ name: 'write_file', args });
      return { success: true, output: 'WRITTEN' } satisfies ToolResult;
    },
    edit_file: async (args) => {
      captured.push({ name: 'edit_file', args });
      return { success: true, output: 'EDITED' } satisfies ToolResult;
    },
    list_dir: async (args) => {
      captured.push({ name: 'list_dir', args });
      return { success: true, output: 'LISTED' } satisfies ToolResult;
    },
    run_command: async (args) => {
      captured.push({ name: 'run_command', args });
      return { success: true, output: 'RAN' } satisfies ToolResult;
    },
  };
}

/** Build a config that flags `.env` (root, subtree) and `secrets/`. */
function strictConfig(): SensitiveConfig {
  return {
    patterns: [
      { pattern: '**/.env', reason: 'env file', source: 'default' },
      { pattern: '.env', reason: 'env file', source: 'default' },
      { pattern: '**/secrets/**', reason: 'secrets dir', source: 'default' },
    ],
  };
}

function emptyConfig(): SensitiveConfig {
  return { patterns: [] };
}

interface ProbeResult {
  result: ToolResult;
  approvalCalls: number;
  lastApprovalArgs: Record<string, unknown> | null;
}

async function runWith(
  options: {
    profile: 'default' | 'dontAsk' | 'bypassPermissions' | 'acceptEdits';
    config: SensitiveConfig;
    dangerouslyAllowAll?: boolean;
    autoLintAfterWrite?: boolean;
  },
  tool: string,
  args: Record<string, unknown>,
  approvalAnswer = true,
): Promise<ProbeResult> {
  let approvalCalls = 0;
  let lastApprovalArgs: Record<string, unknown> | null = null;
  const captured: Array<{ name: string; args: Record<string, unknown> }> = [];
  const executor = new ToolExecutor({
    handlers: makeHandlers(captured),
    profile: options.profile,
    dangerouslyAllowAll: options.dangerouslyAllowAll ?? false,
    autoLintAfterWrite: options.autoLintAfterWrite ?? false,
    projectRoot: os.tmpdir(),
    approvalCallback: async (_name, callArgs) => {
      approvalCalls += 1;
      lastApprovalArgs = callArgs;
      return approvalAnswer;
    },
  });
  executor.setSensitiveConfig(options.config);
  const result = await executor.execute({ id: 'c1', name: tool, arguments: args });
  return { result, approvalCalls, lastApprovalArgs };
}

describe('Sensitive override — dontAsk profile', () => {
  test('write_file to .env forces approval despite dontAsk', async () => {
    const probe = await runWith(
      { profile: 'dontAsk', config: strictConfig() },
      'write_file',
      { path: path.join(os.tmpdir(), '.env'), content: 'X=1' },
    );
    expect(probe.approvalCalls).toBe(1);
    expect(probe.result.success).toBe(true);
  });

  test('write_file to non-sensitive path under dontAsk skips approval', async () => {
    const probe = await runWith(
      { profile: 'dontAsk', config: strictConfig() },
      'write_file',
      { path: path.join(os.tmpdir(), 'README.md'), content: 'hi' },
    );
    expect(probe.approvalCalls).toBe(0);
    expect(probe.result.success).toBe(true);
  });

  test('approval args carry sensitive enrichment fields', async () => {
    const probe = await runWith(
      { profile: 'dontAsk', config: strictConfig() },
      'write_file',
      { path: path.join(os.tmpdir(), '.env'), content: 'X=1' },
    );
    expect(probe.approvalCalls).toBe(1);
    const args = probe.lastApprovalArgs;
    expect(args).not.toBeNull();
    if (args !== null) {
      expect(typeof args['__sensitive']).toBe('string');
      expect(String(args['__sensitive'])).toContain('Sensitive');
      expect(typeof args['__sensitivePattern']).toBe('string');
      expect(typeof args['__sensitivePath']).toBe('string');
    }
  });
});

describe('Sensitive override — bypassPermissions profile', () => {
  test('write_file to .env still forces approval', async () => {
    const probe = await runWith(
      { profile: 'bypassPermissions', config: strictConfig() },
      'write_file',
      { path: path.join(os.tmpdir(), '.env'), content: 'X=1' },
    );
    expect(probe.approvalCalls).toBe(1);
  });
});

describe('Sensitive override — default profile (no regression)', () => {
  test('write_file to .env prompts via default approval gate', async () => {
    const probe = await runWith(
      { profile: 'default', config: strictConfig() },
      'write_file',
      { path: path.join(os.tmpdir(), '.env'), content: 'X=1' },
    );
    expect(probe.approvalCalls).toBe(1);
    expect(probe.result.success).toBe(true);
  });

  test('write_file to non-sensitive path still prompts in default (approval-required tool)', async () => {
    const probe = await runWith(
      { profile: 'default', config: emptyConfig() },
      'write_file',
      { path: path.join(os.tmpdir(), 'README.md'), content: 'hi' },
    );
    expect(probe.approvalCalls).toBe(1);
  });
});

describe('Sensitive override — read-only tools', () => {
  test('read_file against sensitive path gets gated', async () => {
    const probe = await runWith(
      { profile: 'dontAsk', config: strictConfig() },
      'read_file',
      { path: path.join(os.tmpdir(), '.env') },
    );
    expect(probe.approvalCalls).toBe(1);
    expect(probe.result.success).toBe(true);
  });

  test('read_file against ordinary path stays on the auto path under default', async () => {
    const probe = await runWith(
      { profile: 'default', config: strictConfig() },
      'read_file',
      { path: path.join(os.tmpdir(), 'README.md') },
    );
    expect(probe.approvalCalls).toBe(0);
    expect(probe.result.success).toBe(true);
  });

  test('list_dir of a sensitive subtree gets gated', async () => {
    // Pattern is `**/secrets/**` — at least one segment after
    // `secrets/` is required to match. Target a nested path so the
    // override fires.
    const probe = await runWith(
      { profile: 'dontAsk', config: strictConfig() },
      'list_dir',
      { path: path.join(os.tmpdir(), 'secrets', 'inner') },
    );
    expect(probe.approvalCalls).toBe(1);
  });
});

describe('Sensitive override — dangerouslyAllowAll', () => {
  test('even the global escape hatch does NOT bypass sensitive prompts', async () => {
    const probe = await runWith(
      {
        profile: 'default',
        config: strictConfig(),
        dangerouslyAllowAll: true,
      },
      'write_file',
      { path: path.join(os.tmpdir(), '.env'), content: 'X=1' },
    );
    // The dangerouslyAllowAll escape hatch returns 'auto' at policy
    // resolution, but the sensitive override re-forces 'prompt'.
    expect(probe.approvalCalls).toBe(1);
  });
});

describe('Sensitive override — rejection path', () => {
  test('approval rejection returns a failure with `User rejected ...` error', async () => {
    const probe = await runWith(
      { profile: 'dontAsk', config: strictConfig() },
      'write_file',
      { path: path.join(os.tmpdir(), '.env'), content: 'X=1' },
      false,
    );
    expect(probe.approvalCalls).toBe(1);
    expect(probe.result.success).toBe(false);
    expect(probe.result.error ?? '').toContain('rejected');
  });
});
