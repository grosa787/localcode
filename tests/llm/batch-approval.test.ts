/**
 * BATCH-APPROVAL-SECTION (Wave 10D) — unified batch-approval flow.
 *
 * When the LLM emits N or more mutating tool calls in a single
 * `executeAll` invocation AND a `batchApprovalCallback` is configured,
 * the executor surfaces ONE batch modal upfront instead of firing the
 * per-call approval prompt N times sequentially. The callback returns
 * a `Map<toolCallId, 'approved' | 'rejected'>`; the executor commits
 * approved items in original order and short-circuits rejected items
 * with a "User rejected ..." ToolResult.
 *
 * Test surface:
 *   - 5 mutating calls (≥ threshold) → 1 batch dialog fired
 *   - 2 mutating calls (< threshold) → sequential per-call approvals
 *   - approve subset → only approved commit; rejected return failure
 *   - reject all → none commit
 *   - empty decision map (Esc / cancel) → all rejected
 *   - threshold config respected (1 → triggers on a single mutator;
 *     99 → effectively never triggers)
 */

import { describe, test, expect } from 'bun:test';
import { ToolExecutor } from '@/llm/tool-executor';
import type { ToolCall, ToolResult } from '@/types/global';
import type {
  BatchApprovalCallback,
  BatchApprovalDecision,
  ToolHandlerMap,
} from '@/types/message';

function makeHandlers(committed: string[]): ToolHandlerMap {
  return {
    write_file: async (args) => {
      const p = typeof args['path'] === 'string' ? args['path'] : '?';
      committed.push(`write:${p}`);
      return { success: true, output: `WROTE ${p}` } satisfies ToolResult;
    },
    edit_file: async (args) => {
      const p = typeof args['path'] === 'string' ? args['path'] : '?';
      committed.push(`edit:${p}`);
      return { success: true, output: `EDITED ${p}` } satisfies ToolResult;
    },
    run_command: async (args) => {
      const c = typeof args['command'] === 'string' ? args['command'] : '?';
      committed.push(`cmd:${c}`);
      return { success: true, output: `RAN ${c}` } satisfies ToolResult;
    },
    read_file: async (args) => {
      const p = typeof args['path'] === 'string' ? args['path'] : '?';
      committed.push(`read:${p}`);
      return { success: true, output: `READ ${p}` } satisfies ToolResult;
    },
  };
}

function mkCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

describe('ToolExecutor — batch-approval flow', () => {
  test('5 mutating calls (≥ threshold) fire ONE batch dialog, not 5 prompts', async () => {
    const committed: string[] = [];
    let batchCalls = 0;
    let perCallCalls = 0;

    const batchCb: BatchApprovalCallback = async ({ items }) => {
      batchCalls += 1;
      // Approve every item — they should all commit.
      const map = new Map<string, BatchApprovalDecision>();
      for (const it of items) map.set(it.toolCallId, 'approved');
      return map;
    };

    const exec = new ToolExecutor({
      handlers: makeHandlers(committed),
      approvalCallback: async () => {
        perCallCalls += 1;
        return true;
      },
      batchApprovalCallback: batchCb,
      batchApprovalThreshold: 3,
    });

    const calls: ToolCall[] = [
      mkCall('c1', 'write_file', { path: 'a.ts', content: 'a' }),
      mkCall('c2', 'write_file', { path: 'b.ts', content: 'b' }),
      mkCall('c3', 'write_file', { path: 'c.ts', content: 'c' }),
      mkCall('c4', 'write_file', { path: 'd.ts', content: 'd' }),
      mkCall('c5', 'write_file', { path: 'e.ts', content: 'e' }),
    ];
    const results = await exec.executeAll(calls);

    expect(batchCalls).toBe(1);
    expect(perCallCalls).toBe(0);
    expect(results.length).toBe(5);
    expect(results.every((r) => r.result.success)).toBe(true);
    expect(committed.length).toBe(5);
    // Order preserved.
    expect(committed).toEqual([
      'write:a.ts',
      'write:b.ts',
      'write:c.ts',
      'write:d.ts',
      'write:e.ts',
    ]);
  });

  test('2 mutating calls (< threshold) fall back to sequential per-call approval', async () => {
    const committed: string[] = [];
    let batchCalls = 0;
    let perCallCalls = 0;

    const exec = new ToolExecutor({
      handlers: makeHandlers(committed),
      approvalCallback: async () => {
        perCallCalls += 1;
        return true;
      },
      batchApprovalCallback: async ({ items }) => {
        batchCalls += 1;
        const map = new Map<string, BatchApprovalDecision>();
        for (const it of items) map.set(it.toolCallId, 'approved');
        return map;
      },
      batchApprovalThreshold: 3,
    });

    const calls: ToolCall[] = [
      mkCall('c1', 'write_file', { path: 'a.ts', content: 'a' }),
      mkCall('c2', 'write_file', { path: 'b.ts', content: 'b' }),
    ];
    const results = await exec.executeAll(calls);

    expect(batchCalls).toBe(0);
    expect(perCallCalls).toBe(2);
    expect(results.every((r) => r.result.success)).toBe(true);
    expect(committed).toEqual(['write:a.ts', 'write:b.ts']);
  });

  test('approve subset: only approved items commit; rejected return failure', async () => {
    const committed: string[] = [];

    const exec = new ToolExecutor({
      handlers: makeHandlers(committed),
      approvalCallback: async () => true,
      batchApprovalCallback: async ({ items }) => {
        // Approve items 0 and 2; reject 1, 3; omit 4 (treated as rejected).
        const map = new Map<string, BatchApprovalDecision>();
        const arr = items;
        if (arr[0] !== undefined) map.set(arr[0].toolCallId, 'approved');
        if (arr[1] !== undefined) map.set(arr[1].toolCallId, 'rejected');
        if (arr[2] !== undefined) map.set(arr[2].toolCallId, 'approved');
        if (arr[3] !== undefined) map.set(arr[3].toolCallId, 'rejected');
        // arr[4] omitted on purpose
        return map;
      },
      batchApprovalThreshold: 3,
    });

    const calls: ToolCall[] = [
      mkCall('c1', 'write_file', { path: 'a.ts', content: 'a' }),
      mkCall('c2', 'write_file', { path: 'b.ts', content: 'b' }),
      mkCall('c3', 'write_file', { path: 'c.ts', content: 'c' }),
      mkCall('c4', 'write_file', { path: 'd.ts', content: 'd' }),
      mkCall('c5', 'write_file', { path: 'e.ts', content: 'e' }),
    ];
    const results = await exec.executeAll(calls);

    expect(results.length).toBe(5);
    // c1 approved → committed.
    expect(results[0]?.result.success).toBe(true);
    // c2 rejected → not committed.
    expect(results[1]?.result.success).toBe(false);
    expect(results[1]?.result.error).toContain('User rejected');
    // c3 approved → committed.
    expect(results[2]?.result.success).toBe(true);
    // c4 rejected → not committed.
    expect(results[3]?.result.success).toBe(false);
    // c5 omitted from decision map → treated as rejected.
    expect(results[4]?.result.success).toBe(false);
    expect(results[4]?.result.error).toContain('User rejected');

    expect(committed).toEqual(['write:a.ts', 'write:c.ts']);
  });

  test('reject all: none commit', async () => {
    const committed: string[] = [];

    const exec = new ToolExecutor({
      handlers: makeHandlers(committed),
      approvalCallback: async () => true,
      batchApprovalCallback: async ({ items }) => {
        const map = new Map<string, BatchApprovalDecision>();
        for (const it of items) map.set(it.toolCallId, 'rejected');
        return map;
      },
      batchApprovalThreshold: 3,
    });

    const calls: ToolCall[] = [
      mkCall('c1', 'write_file', { path: 'a.ts', content: 'a' }),
      mkCall('c2', 'write_file', { path: 'b.ts', content: 'b' }),
      mkCall('c3', 'write_file', { path: 'c.ts', content: 'c' }),
    ];
    const results = await exec.executeAll(calls);

    expect(results.length).toBe(3);
    expect(results.every((r) => !r.result.success)).toBe(true);
    expect(committed.length).toBe(0);
  });

  test('Esc / empty decision map: all items rejected (uncommitted = rejected)', async () => {
    const committed: string[] = [];

    const exec = new ToolExecutor({
      handlers: makeHandlers(committed),
      approvalCallback: async () => true,
      // Simulate the dialog being dismissed with Esc — empty Map returned.
      batchApprovalCallback: async () => new Map(),
      batchApprovalThreshold: 3,
    });

    const calls: ToolCall[] = [
      mkCall('c1', 'write_file', { path: 'a.ts', content: 'a' }),
      mkCall('c2', 'write_file', { path: 'b.ts', content: 'b' }),
      mkCall('c3', 'write_file', { path: 'c.ts', content: 'c' }),
    ];
    const results = await exec.executeAll(calls);

    expect(results.length).toBe(3);
    expect(results.every((r) => !r.result.success)).toBe(true);
    expect(results.every((r) => (r.result.error ?? '').includes('User rejected'))).toBe(
      true,
    );
    expect(committed.length).toBe(0);
  });

  test('threshold config respected: 1 triggers on a single mutator', async () => {
    const committed: string[] = [];
    let batchCalls = 0;

    const exec = new ToolExecutor({
      handlers: makeHandlers(committed),
      approvalCallback: async () => true,
      batchApprovalCallback: async ({ items }) => {
        batchCalls += 1;
        const map = new Map<string, BatchApprovalDecision>();
        for (const it of items) map.set(it.toolCallId, 'approved');
        return map;
      },
      batchApprovalThreshold: 1,
    });

    const calls: ToolCall[] = [
      mkCall('c1', 'write_file', { path: 'solo.ts', content: 'x' }),
    ];
    const results = await exec.executeAll(calls);

    expect(batchCalls).toBe(1);
    expect(results[0]?.result.success).toBe(true);
    expect(committed).toEqual(['write:solo.ts']);
  });

  test('threshold config respected: 99 effectively disables the batch flow', async () => {
    const committed: string[] = [];
    let batchCalls = 0;
    let perCallCalls = 0;

    const exec = new ToolExecutor({
      handlers: makeHandlers(committed),
      approvalCallback: async () => {
        perCallCalls += 1;
        return true;
      },
      batchApprovalCallback: async ({ items }) => {
        batchCalls += 1;
        const map = new Map<string, BatchApprovalDecision>();
        for (const it of items) map.set(it.toolCallId, 'approved');
        return map;
      },
      batchApprovalThreshold: 99,
    });

    // 5 mutators — still below 99.
    const calls: ToolCall[] = [
      mkCall('c1', 'write_file', { path: 'a.ts', content: 'a' }),
      mkCall('c2', 'write_file', { path: 'b.ts', content: 'b' }),
      mkCall('c3', 'write_file', { path: 'c.ts', content: 'c' }),
      mkCall('c4', 'write_file', { path: 'd.ts', content: 'd' }),
      mkCall('c5', 'write_file', { path: 'e.ts', content: 'e' }),
    ];
    const results = await exec.executeAll(calls);

    expect(batchCalls).toBe(0);
    expect(perCallCalls).toBe(5);
    expect(results.every((r) => r.result.success)).toBe(true);
  });

  test('no batchApprovalCallback configured: fall back to per-call (back-compat)', async () => {
    const committed: string[] = [];
    let perCallCalls = 0;

    const exec = new ToolExecutor({
      handlers: makeHandlers(committed),
      approvalCallback: async () => {
        perCallCalls += 1;
        return true;
      },
      // No batchApprovalCallback — behaviour must match the pre-batch
      // serial flow.
      batchApprovalThreshold: 3,
    });

    const calls: ToolCall[] = [
      mkCall('c1', 'write_file', { path: 'a.ts', content: 'a' }),
      mkCall('c2', 'write_file', { path: 'b.ts', content: 'b' }),
      mkCall('c3', 'write_file', { path: 'c.ts', content: 'c' }),
    ];
    const results = await exec.executeAll(calls);

    expect(perCallCalls).toBe(3);
    expect(results.every((r) => r.result.success)).toBe(true);
  });

  test('read-only calls in a mostly-mutating batch are unaffected (no batch prompt for reads)', async () => {
    const committed: string[] = [];
    let batchCalls = 0;
    const seenInBatch: string[] = [];

    const exec = new ToolExecutor({
      handlers: makeHandlers(committed),
      approvalCallback: async () => true,
      batchApprovalCallback: async ({ items }) => {
        batchCalls += 1;
        for (const it of items) seenInBatch.push(it.toolName);
        const map = new Map<string, BatchApprovalDecision>();
        for (const it of items) map.set(it.toolCallId, 'approved');
        return map;
      },
      batchApprovalThreshold: 3,
    });

    const calls: ToolCall[] = [
      mkCall('r1', 'read_file', { path: 'README.md' }),
      mkCall('c1', 'write_file', { path: 'a.ts', content: 'a' }),
      mkCall('c2', 'write_file', { path: 'b.ts', content: 'b' }),
      mkCall('c3', 'write_file', { path: 'c.ts', content: 'c' }),
    ];
    const results = await exec.executeAll(calls);

    expect(batchCalls).toBe(1);
    // Only the three mutators were surfaced in the batch dialog.
    expect(seenInBatch).toEqual(['write_file', 'write_file', 'write_file']);
    // Every result succeeded — read commits, three writes commit.
    expect(results.length).toBe(4);
    expect(results.every((r) => r.result.success)).toBe(true);
    // Read ran AND writes ran in declared order.
    expect(committed).toContain('read:README.md');
    expect(committed.filter((c) => c.startsWith('write:'))).toEqual([
      'write:a.ts',
      'write:b.ts',
      'write:c.ts',
    ]);
  });
});
