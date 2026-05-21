/**
 * Tests for `monitor` tool (B3).
 *
 * Verifies status reporting, wait-with-timeout, and the killTask path.
 * Uses a thin `Subprocess`-shaped fake — same pattern as
 * background-tasks.test.ts — so we never spawn real children.
 */
import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { BackgroundTaskRegistry } from '@/tools/background-tasks';
import { monitorTask } from '@/tools/monitor';

interface FakeChild {
  stdout: EventEmitter;
  stderr: EventEmitter;
  on: EventEmitter['on'];
  emit: EventEmitter['emit'];
  kill: (signal?: NodeJS.Signals | string) => boolean;
  killed: boolean;
  killSignal?: NodeJS.Signals | string;
}

function makeFakeChild(): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const main = new EventEmitter();
  const fake: FakeChild = {
    stdout,
    stderr,
    on: main.on.bind(main),
    emit: main.emit.bind(main),
    killed: false,
    kill(signal): boolean {
      fake.killed = true;
      fake.killSignal = signal;
      return true;
    },
  };
  return fake;
}

const baseCtx = {
  projectRoot: process.cwd(),
  dangerouslyAllowAll: false,
};

describe('monitorTask', () => {
  test('returns running status when task has not exited', async () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    const taskId = reg.register(child as unknown as never);
    child.stdout.emit('data', 'partial output');
    const res = await monitorTask(
      { taskId },
      { ...baseCtx, backgroundTasks: reg },
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/status=running/);
    expect(res.output).toContain('partial output');
  });

  test('returns completed status with exitCode after exit', async () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    const taskId = reg.register(child as unknown as never);
    child.stdout.emit('data', 'done\n');
    child.emit('exit', 0, null);
    const res = await monitorTask(
      { taskId },
      { ...baseCtx, backgroundTasks: reg },
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/status=completed/);
    expect(res.output).toMatch(/exitCode=0/);
    expect(res.output).toContain('done');
  });

  test('wait blocks until the task transitions then resolves with new state', async () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    const taskId = reg.register(child as unknown as never);
    // Schedule a transition shortly after the wait starts.
    setTimeout(() => {
      child.stdout.emit('data', 'late chunk');
      child.emit('exit', 0, null);
    }, 20);
    const res = await monitorTask(
      { taskId, wait: 500 },
      { ...baseCtx, backgroundTasks: reg },
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/status=completed/);
    expect(res.output).toContain('late chunk');
  });

  test('wait returns running status if timeout elapses with no change', async () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    const taskId = reg.register(child as unknown as never);
    const res = await monitorTask(
      { taskId, wait: 30 },
      { ...baseCtx, backgroundTasks: reg },
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/status=running/);
  });

  test('killTask=true sends SIGTERM to a running task', async () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    const taskId = reg.register(child as unknown as never);
    const res = await monitorTask(
      { taskId, killTask: true },
      { ...baseCtx, backgroundTasks: reg },
    );
    expect(res.success).toBe(true);
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe('SIGTERM');
    expect(res.output).toContain('Sent SIGTERM');
  });

  test('killTask=true on an already-terminated task returns "nothing to kill"', async () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    const taskId = reg.register(child as unknown as never);
    child.emit('exit', 0, null);
    const res = await monitorTask(
      { taskId, killTask: true },
      { ...baseCtx, backgroundTasks: reg },
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain('nothing to kill');
  });

  test('unknown taskId surfaces a clear error', async () => {
    const reg = new BackgroundTaskRegistry();
    const res = await monitorTask(
      { taskId: 'bg_unknown' },
      { ...baseCtx, backgroundTasks: reg },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Unknown taskId/);
  });

  test('rejects invalid args via Zod', async () => {
    const reg = new BackgroundTaskRegistry();
    const res = await monitorTask(
      { taskId: '' },
      { ...baseCtx, backgroundTasks: reg },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Invalid args/);
  });

  test('rejects wait outside [0, 30000]', async () => {
    const reg = new BackgroundTaskRegistry();
    const res = await monitorTask(
      { taskId: 'bg_x', wait: 999999 },
      { ...baseCtx, backgroundTasks: reg },
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Invalid args/);
  });
});
