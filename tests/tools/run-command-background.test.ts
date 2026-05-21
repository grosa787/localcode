/**
 * Tests for `run_command` in background mode (B3).
 *
 * Uses real `execa` subprocesses but only short-lived ones (echo, sleep
 * 0.05, exit 1). Combined with an isolated `BackgroundTaskRegistry` so
 * we don't leak across the suite.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeCommand } from '@/tools/run-command';
import { BackgroundTaskRegistry } from '@/tools/background-tasks';
import { monitorTask } from '@/tools/monitor';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-runbg-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Helper — wait until the registry reports the task in a terminal status. */
async function waitForTerminal(
  reg: BackgroundTaskRegistry,
  taskId: string,
  budgetMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const snap = reg.get(taskId);
    if (snap !== null && snap.status !== 'running') return;
    await reg.waitForChange(taskId, 200);
  }
}

describe('run_command runInBackground', () => {
  test('returns a taskId immediately and the task runs in background', async () => {
    const reg = new BackgroundTaskRegistry();
    const res = await executeCommand(
      { command: 'echo hello-bg', runInBackground: true },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
        backgroundTasks: reg,
      },
    );
    expect(res.success).toBe(true);
    const match = res.output.match(/taskId="(bg_[a-f0-9]+)"/);
    expect(match).not.toBeNull();
    const taskId = match?.[1] ?? '';
    expect(taskId).toMatch(/^bg_/);

    // Eventually the task transitions to completed.
    await waitForTerminal(reg, taskId);
    const monitorRes = await monitorTask(
      { taskId },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
        backgroundTasks: reg,
      },
    );
    expect(monitorRes.success).toBe(true);
    expect(monitorRes.output).toMatch(/status=completed/);
    expect(monitorRes.output).toContain('hello-bg');
  });

  test('failing background command reports failed status', async () => {
    const reg = new BackgroundTaskRegistry();
    const res = await executeCommand(
      { command: 'sh -c "exit 7"', runInBackground: true },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
        backgroundTasks: reg,
      },
    );
    expect(res.success).toBe(true);
    const match = res.output.match(/taskId="(bg_[a-f0-9]+)"/);
    const taskId = match?.[1] ?? '';
    await waitForTerminal(reg, taskId);
    const monitorRes = await monitorTask(
      { taskId },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
        backgroundTasks: reg,
      },
    );
    expect(monitorRes.success).toBe(true);
    expect(monitorRes.output).toMatch(/status=failed/);
    expect(monitorRes.output).toMatch(/exitCode=7/);
  });

  test('monitor wait observes output appearing mid-run', async () => {
    const reg = new BackgroundTaskRegistry();
    const res = await executeCommand(
      {
        // Print one chunk, sleep, print another, then exit. Sleeping
        // gives `monitor` something to actually wait on.
        command: 'sh -c "echo first; sleep 0.05; echo second"',
        runInBackground: true,
      },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
        backgroundTasks: reg,
      },
    );
    const match = res.output.match(/taskId="(bg_[a-f0-9]+)"/);
    const taskId = match?.[1] ?? '';

    // First monitor with wait blocks until at least one chunk lands.
    const first = await monitorTask(
      { taskId, wait: 1000 },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
        backgroundTasks: reg,
      },
    );
    expect(first.success).toBe(true);
    expect(first.output).toContain('first');

    // Wait until terminal and check the rest landed.
    await waitForTerminal(reg, taskId);
    const final = await monitorTask(
      { taskId },
      {
        projectRoot: tmpRoot,
        dangerouslyAllowAll: false,
        backgroundTasks: reg,
      },
    );
    expect(final.output).toContain('second');
    expect(final.output).toMatch(/status=completed/);
  });
});
