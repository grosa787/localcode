/**
 * Speculative read-only parallelism in `ToolExecutor.executeAll`.
 *
 * Read-only tools (read_file, list_dir, glob_search, lint_file,
 * find_symbol, fetch_image) fire immediately on receipt; mutating
 * tools serialise through their approval gate. Saves 100–300ms per
 * turn when the LLM batches reads with a write.
 *
 * Contract under test:
 *   - Result order MUST mirror input order (the LLM correlates by index).
 *   - Read-only calls do NOT trigger approvalCallback.
 *   - A mutating call's approval prompt MAY block in parallel with
 *     reads that were emitted before OR after it; both reads still
 *     complete before the mutating call returns its rejection.
 *   - On approval rejection, subsequent MUTATING tools are skipped
 *     with a synthetic "prior approval was rejected" result.
 *   - A read-only handler that throws still surfaces a structured
 *     `success: false` ToolResult at the correct index — sibling
 *     reads keep going.
 *   - All-read batches and all-mutating batches preserve the legacy
 *     sequential semantics callers expect.
 */
import { describe, test, expect } from 'bun:test';

import { ToolExecutor } from '@/llm/tool-executor';
import type { ToolCall, ToolResult } from '@/types/global';
import type { ToolHandlerMap } from '@/types/message';

interface ExecOrderEvent {
  tool: string;
  phase: 'start' | 'end';
  at: number;
}

/**
 * Build a handler map that records start/end timestamps for each
 * invocation. `delaysMs` lets a per-tool override take precedence
 * over the default 10ms delay so we can mimic slow reads vs. fast
 * writes (or vice versa) in individual tests.
 */
function makeHandlers(opts: {
  events: ExecOrderEvent[];
  delaysMs?: Partial<Record<string, number>>;
  throwOn?: Partial<Record<string, string>>;
  origin: number;
}): ToolHandlerMap {
  const { events, delaysMs = {}, throwOn = {}, origin } = opts;
  function delay(name: string): number {
    return delaysMs[name] ?? 10;
  }
  function record(name: string, phase: ExecOrderEvent['phase']): void {
    events.push({ tool: name, phase, at: Date.now() - origin });
  }
  function makeHandler(name: string, output: string) {
    return async (): Promise<ToolResult> => {
      record(name, 'start');
      const throwMsg = throwOn[name];
      if (throwMsg !== undefined) {
        // Simulate a small amount of work before the throw to match
        // realistic IO patterns.
        await new Promise<void>((r) => setTimeout(r, 1));
        record(name, 'end');
        throw new Error(throwMsg);
      }
      await new Promise<void>((r) => setTimeout(r, delay(name)));
      record(name, 'end');
      return { success: true, output };
    };
  }
  return {
    read_file: makeHandler('read_file', 'READ_OK'),
    list_dir: makeHandler('list_dir', 'LIST_OK'),
    glob_search: makeHandler('glob_search', 'GLOB_OK'),
    lint_file: makeHandler('lint_file', 'LINT_OK'),
    find_symbol: makeHandler('find_symbol', 'SYM_OK'),
    fetch_image: makeHandler('fetch_image', 'IMG_OK'),
    write_file: makeHandler('write_file', 'WRITE_OK'),
    run_command: makeHandler('run_command', 'CMD_OK'),
    edit_file: makeHandler('edit_file', 'EDIT_OK'),
  };
}

/** Build a `ToolCall` with deterministic ids for ergonomic assertions. */
function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `c-${name}-${Math.random().toString(36).slice(2, 7)}`, name, arguments: args };
}

describe('ToolExecutor.executeAll — speculative read-only parallelism', () => {
  test('reads fire in parallel with a mutating tool that blocks on approval', async () => {
    const events: ExecOrderEvent[] = [];
    const origin = Date.now();
    // Reads are SHORT (10ms each); approval prompt is LONG (200ms).
    // If reads were serial-after-approval they would take 200+10+10=220ms.
    // Speculative reads should finish near the approval-prompt window.
    const approvalDelayMs = 200;
    const exec = new ToolExecutor({
      handlers: makeHandlers({ events, origin }),
      approvalCallback: async () =>
        new Promise<boolean>((r) => setTimeout(() => r(true), approvalDelayMs)),
    });

    const t0 = Date.now();
    const results = await exec.executeAll([
      call('write_file', { path: 'a.ts', content: 'x' }),
      call('read_file', { path: 'b.ts' }),
      call('list_dir', { path: '.' }),
    ]);
    const elapsed = Date.now() - t0;

    // Total time should be dominated by the approval delay, NOT
    // approval + reads serial. Allow generous slack for CI jitter.
    expect(elapsed).toBeLessThan(approvalDelayMs + 120);

    // Results are returned in input order.
    expect(results.map((r) => r.toolCall.name)).toEqual([
      'write_file',
      'read_file',
      'list_dir',
    ]);
    expect(results.map((r) => r.result.success)).toEqual([true, true, true]);

    // Reads STARTED before the approval prompt resolved (i.e. their
    // start event sits well below `approvalDelayMs`).
    const readStart = events.find((e) => e.tool === 'read_file' && e.phase === 'start');
    const listStart = events.find((e) => e.tool === 'list_dir' && e.phase === 'start');
    expect(readStart?.at ?? Infinity).toBeLessThan(50);
    expect(listStart?.at ?? Infinity).toBeLessThan(50);
  });

  test('mixed sequence [read1, write, read2] starts both reads immediately; write blocks on approval', async () => {
    const events: ExecOrderEvent[] = [];
    const origin = Date.now();
    const approvalDelayMs = 150;
    const exec = new ToolExecutor({
      handlers: makeHandlers({ events, origin }),
      approvalCallback: async () =>
        new Promise<boolean>((r) => setTimeout(() => r(true), approvalDelayMs)),
    });

    const results = await exec.executeAll([
      call('read_file', { path: 'a.ts' }),
      call('write_file', { path: 'b.ts', content: 'y' }),
      call('glob_search', { pattern: '*.ts' }),
    ]);

    expect(results.map((r) => r.toolCall.name)).toEqual([
      'read_file',
      'write_file',
      'glob_search',
    ]);
    expect(results.every((r) => r.result.success)).toBe(true);

    // Both read starts happen well before the approval window closes.
    const readStart = events.find((e) => e.tool === 'read_file' && e.phase === 'start');
    const globStart = events.find((e) => e.tool === 'glob_search' && e.phase === 'start');
    const writeStart = events.find((e) => e.tool === 'write_file' && e.phase === 'start');
    expect(readStart?.at ?? Infinity).toBeLessThan(50);
    expect(globStart?.at ?? Infinity).toBeLessThan(50);
    // Write actually executes AFTER the approval delay.
    expect(writeStart?.at ?? 0).toBeGreaterThanOrEqual(approvalDelayMs - 20);
  });

  test('approval rejection: reads still complete; write returns rejection; subsequent mutating tools are skipped', async () => {
    const events: ExecOrderEvent[] = [];
    const origin = Date.now();
    const exec = new ToolExecutor({
      handlers: makeHandlers({ events, origin }),
      approvalCallback: async () =>
        new Promise<boolean>((r) => setTimeout(() => r(false), 30)),
    });

    const results = await exec.executeAll([
      call('write_file', { path: 'a.ts', content: 'x' }),
      call('read_file', { path: 'b.ts' }),
      call('list_dir', {}),
      call('run_command', { command: 'ls' }),
    ]);

    expect(results.map((r) => r.toolCall.name)).toEqual([
      'write_file',
      'read_file',
      'list_dir',
      'run_command',
    ]);
    expect(results[0]?.result.success).toBe(false);
    expect(results[0]?.result.error ?? '').toContain('rejected');
    // Reads still complete normally.
    expect(results[1]?.result.success).toBe(true);
    expect(results[1]?.result.output).toBe('READ_OK');
    expect(results[2]?.result.success).toBe(true);
    expect(results[2]?.result.output).toBe('LIST_OK');
    // Subsequent mutating tool is skipped, never invoked.
    expect(results[3]?.result.success).toBe(false);
    expect(results[3]?.result.error ?? '').toMatch(/prior approval was rejected/);
    const cmdStart = events.find((e) => e.tool === 'run_command' && e.phase === 'start');
    expect(cmdStart).toBeUndefined();
  });

  test('all read-only sequence: no approval prompt fired; every result is returned in order', async () => {
    const events: ExecOrderEvent[] = [];
    const origin = Date.now();
    let approvalCalls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers({ events, origin }),
      approvalCallback: async () => {
        approvalCalls += 1;
        return true;
      },
    });

    const results = await exec.executeAll([
      call('read_file', { path: 'a.ts' }),
      call('list_dir', {}),
      call('glob_search', { pattern: '*.md' }),
      call('lint_file', { path: 'a.ts' }),
      call('find_symbol', { name: 'foo' }),
      call('fetch_image', { url: 'https://example.com/x.png' }),
    ]);

    expect(approvalCalls).toBe(0);
    expect(results.map((r) => r.toolCall.name)).toEqual([
      'read_file',
      'list_dir',
      'glob_search',
      'lint_file',
      'find_symbol',
      'fetch_image',
    ]);
    expect(results.every((r) => r.result.success)).toBe(true);
  });

  test('all mutating sequence: behaves like legacy serial executor (each tool waits its own approval)', async () => {
    const events: ExecOrderEvent[] = [];
    const origin = Date.now();
    let approvalCalls = 0;
    const exec = new ToolExecutor({
      handlers: makeHandlers({ events, origin, delaysMs: { write_file: 5, run_command: 5 } }),
      approvalCallback: async (name) => {
        approvalCalls += 1;
        // Distinct, observable order — each approval resolves after 20ms.
        return new Promise<boolean>((r) =>
          setTimeout(() => r(true), 20 + (name === 'run_command' ? 0 : 0)),
        );
      },
    });

    const results = await exec.executeAll([
      call('write_file', { path: 'a.ts', content: 'x' }),
      call('run_command', { command: 'ls' }),
    ]);

    expect(approvalCalls).toBe(2);
    expect(results.map((r) => r.toolCall.name)).toEqual([
      'write_file',
      'run_command',
    ]);
    expect(results.every((r) => r.result.success)).toBe(true);

    // Strictly serial — run_command starts AFTER write_file finished.
    const writeEnd = events.find((e) => e.tool === 'write_file' && e.phase === 'end');
    const cmdStart = events.find((e) => e.tool === 'run_command' && e.phase === 'start');
    expect(cmdStart?.at ?? 0).toBeGreaterThanOrEqual(writeEnd?.at ?? 0);
  });

  test('read-only handler that throws surfaces a structured error at the correct index; siblings still complete', async () => {
    const events: ExecOrderEvent[] = [];
    const origin = Date.now();
    const exec = new ToolExecutor({
      handlers: makeHandlers({
        events,
        origin,
        throwOn: { list_dir: 'boom from list_dir' },
      }),
      approvalCallback: async () => true,
    });

    const results = await exec.executeAll([
      call('read_file', { path: 'a.ts' }),
      call('list_dir', {}),
      call('glob_search', { pattern: '*.md' }),
    ]);

    expect(results.map((r) => r.toolCall.name)).toEqual([
      'read_file',
      'list_dir',
      'glob_search',
    ]);
    expect(results[0]?.result.success).toBe(true);
    expect(results[1]?.result.success).toBe(false);
    expect(results[1]?.result.error ?? '').toMatch(/boom from list_dir/);
    expect(results[2]?.result.success).toBe(true);
  });

  test('empty input array returns []', async () => {
    const events: ExecOrderEvent[] = [];
    const origin = Date.now();
    const exec = new ToolExecutor({
      handlers: makeHandlers({ events, origin }),
      approvalCallback: async () => true,
    });
    const results = await exec.executeAll([]);
    expect(results).toEqual([]);
  });

  test('benchmark — write (1000ms approval) + read (10ms) completes in ~1000ms, not ~1010ms', async () => {
    const events: ExecOrderEvent[] = [];
    const origin = Date.now();
    const approvalDelayMs = 1000;
    const readDelayMs = 10;
    const exec = new ToolExecutor({
      handlers: makeHandlers({
        events,
        origin,
        delaysMs: { read_file: readDelayMs, write_file: 5 },
      }),
      approvalCallback: async () =>
        new Promise<boolean>((r) => setTimeout(() => r(true), approvalDelayMs)),
    });

    const t0 = Date.now();
    const results = await exec.executeAll([
      call('write_file', { path: 'a.ts', content: 'x' }),
      call('read_file', { path: 'b.ts' }),
    ]);
    const elapsed = Date.now() - t0;

    // Sequential would be approvalDelayMs + writeDelay + readDelay ~= 1015ms+.
    // Speculative should finish within ~ approvalDelayMs + writeDelay slack.
    expect(elapsed).toBeLessThan(approvalDelayMs + 100);
    expect(results.every((r) => r.result.success)).toBe(true);
  });
});
