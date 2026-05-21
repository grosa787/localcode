/**
 * Tests for `BackgroundTaskRegistry` (B3).
 *
 * Covers the lifecycle: register → status flips on exit → dispose kills
 * leftover children. Also exercises the ring-buffer truncation.
 *
 * We use a thin fake of `Subprocess` (EventEmitter + stdout/stderr) so
 * the tests run synchronously and never spawn an actual child. Real-
 * subprocess paths are exercised by `run-command-background.test.ts`.
 */
import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  BackgroundTaskRegistry,
  RING_BUFFER_CAP_BYTES,
} from '@/tools/background-tasks';

/**
 * Minimal `Subprocess`-shaped fake. The registry only reads `stdout`,
 * `stderr`, and listens for `exit` / `error`, so a typed cast is enough
 * to drive every code path under test.
 */
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

describe('BackgroundTaskRegistry', () => {
  test('register returns a taskId, get returns snapshot with running status', () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    // Cast through unknown — the registry's typed Subprocess is
    // structurally compatible with the fake at the field surface we use.
    const taskId = reg.register(child as unknown as never);
    expect(taskId).toMatch(/^bg_/);
    const snap = reg.get(taskId);
    expect(snap?.status).toBe('running');
    expect(snap?.stdout).toBe('');
    expect(snap?.stderr).toBe('');
    expect(snap?.exitCode).toBeNull();
  });

  test('stdout/stderr appended chunks appear in snapshot', () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    const taskId = reg.register(child as unknown as never);
    child.stdout.emit('data', 'hello ');
    child.stdout.emit('data', 'world');
    child.stderr.emit('data', 'warn');
    const snap = reg.get(taskId);
    expect(snap?.stdout).toBe('hello world');
    expect(snap?.stderr).toBe('warn');
  });

  test('exit flips status to completed for code=0, failed for non-zero', () => {
    const reg = new BackgroundTaskRegistry();
    const okChild = makeFakeChild();
    const failChild = makeFakeChild();
    const okId = reg.register(okChild as unknown as never);
    const failId = reg.register(failChild as unknown as never);
    okChild.emit('exit', 0, null);
    failChild.emit('exit', 2, null);
    expect(reg.get(okId)?.status).toBe('completed');
    expect(reg.get(okId)?.exitCode).toBe(0);
    expect(reg.get(failId)?.status).toBe('failed');
    expect(reg.get(failId)?.exitCode).toBe(2);
  });

  test('signal-terminated child reports failed', () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    const taskId = reg.register(child as unknown as never);
    child.emit('exit', null, 'SIGTERM');
    expect(reg.get(taskId)?.status).toBe('failed');
  });

  test('ring buffer truncates oldest bytes once cap exceeded', () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    const taskId = reg.register(child as unknown as never);
    // Push enough to exceed the cap by 100 bytes.
    const overflow = 'A'.repeat(RING_BUFFER_CAP_BYTES);
    child.stdout.emit('data', overflow);
    child.stdout.emit('data', 'B'.repeat(100));
    const snap = reg.get(taskId);
    expect(snap?.stdoutBytes).toBe(RING_BUFFER_CAP_BYTES);
    expect(snap?.stdout).toContain('[...truncated,');
    expect(snap?.stdout.endsWith('BBBBB' + 'B'.repeat(95))).toBe(true);
  });

  test('kill returns true only when running', () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    const taskId = reg.register(child as unknown as never);
    expect(reg.kill(taskId)).toBe(true);
    expect(child.killed).toBe(true);
    child.emit('exit', null, 'SIGTERM');
    // Second kill after terminal status is a no-op.
    expect(reg.kill(taskId)).toBe(false);
  });

  test('waitForChange resolves true on status change, false on timeout', async () => {
    const reg = new BackgroundTaskRegistry();
    const child = makeFakeChild();
    const taskId = reg.register(child as unknown as never);
    // Schedule an exit shortly after the wait starts.
    setTimeout(() => child.emit('exit', 0, null), 10);
    const woke = await reg.waitForChange(taskId, 500);
    expect(woke).toBe(true);

    // Already-terminal task resolves immediately.
    const immediate = await reg.waitForChange(taskId, 1000);
    expect(immediate).toBe(true);

    // Running task with short timeout returns false.
    const child2 = makeFakeChild();
    const tid2 = reg.register(child2 as unknown as never);
    const timedOut = await reg.waitForChange(tid2, 30);
    expect(timedOut).toBe(false);
  });

  test('dispose kills all still-running children and clears the map', async () => {
    const reg = new BackgroundTaskRegistry();
    const stillRunning = makeFakeChild();
    const alreadyDone = makeFakeChild();
    reg.register(stillRunning as unknown as never);
    const doneId = reg.register(alreadyDone as unknown as never);
    alreadyDone.emit('exit', 0, null);
    expect(reg.size()).toBe(2);
    expect(reg.get(doneId)?.status).toBe('completed');
    // Don't await indefinitely — dispose has its own internal grace.
    const disposePromise = reg.dispose();
    // Simulate the still-running child accepting SIGTERM and emitting exit.
    stillRunning.emit('exit', null, 'SIGTERM');
    await disposePromise;
    expect(stillRunning.killed).toBe(true);
    expect(reg.size()).toBe(0);
  });

  test('get returns null for unknown taskId', () => {
    const reg = new BackgroundTaskRegistry();
    expect(reg.get('bg_doesnotexist')).toBeNull();
  });
});
