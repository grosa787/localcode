/**
 * Diagnostic throttle — verifies that the registry suppresses
 * duplicate signatures emitted within the configured window
 * (default 30 s). Tests inject a fake spawn + a controllable `now`
 * so the throttle window is deterministic.
 */

import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { ProcessMonitor } from '@/process-monitor';
import type { DiagnosticSignal } from '@/process-monitor';

function makeFakeChild(): {
  readonly child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: () => boolean; catch: () => unknown; then: (fn: () => void) => unknown };
  emit: { stderr: (chunk: string) => void; stdout: (chunk: string) => void; exit: (code: number | null, signal: NodeJS.Signals | null) => void };
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: () => boolean;
    catch: () => unknown;
    then: (fn: () => void) => unknown;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 7777;
  child.kill = (): boolean => true;
  child.catch = (): unknown => Promise.resolve();
  child.then = (fn: () => void): unknown => { queueMicrotask(fn); return Promise.resolve(); };
  return {
    child,
    emit: {
      stdout(chunk: string): void { stdout.emit('data', chunk); },
      stderr(chunk: string): void { stderr.emit('data', chunk); },
      exit(code, signal): void { child.emit('exit', code, signal); },
    },
  };
}

const TS_LINE = "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";

describe('diagnostic throttle', () => {
  test('same signature within 30 s emits once', async () => {
    let now = 1_000_000;
    let f: ReturnType<typeof makeFakeChild> | undefined;
    const monitor = new ProcessMonitor({
      spawn: () => {
        f = makeFakeChild();
        return f.child as unknown as ReturnType<typeof Object>;
      },
      now: () => now,
    });
    const signals: DiagnosticSignal[] = [];
    monitor.on('diagnostic', (s: DiagnosticSignal) => signals.push(s));
    monitor.watch({ command: 'sh -c true', label: 'tsc' });
    f!.emit.stderr(TS_LINE);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(signals.length).toBe(1);

    // Same signature emitted again well within the 30 s window.
    now += 1_000;
    f!.emit.stderr(TS_LINE);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(signals.length).toBe(1);

    now += 15_000;
    f!.emit.stderr(TS_LINE);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(signals.length).toBe(1);
  });

  test('same signature past the window re-emits', async () => {
    let now = 1_000_000;
    let f: ReturnType<typeof makeFakeChild> | undefined;
    const monitor = new ProcessMonitor({
      spawn: () => {
        f = makeFakeChild();
        return f.child as unknown as ReturnType<typeof Object>;
      },
      now: () => now,
      // Tight 5 s window so the test moves fast.
      throttleMs: 5_000,
    });
    const signals: DiagnosticSignal[] = [];
    monitor.on('diagnostic', (s: DiagnosticSignal) => signals.push(s));
    monitor.watch({ command: 'sh -c true', label: 'tsc' });
    f!.emit.stderr(TS_LINE);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(signals.length).toBe(1);

    now += 6_000;
    f!.emit.stderr(TS_LINE);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(signals.length).toBe(2);
  });

  test('different signatures are not throttled against each other', async () => {
    let f: ReturnType<typeof makeFakeChild> | undefined;
    const monitor = new ProcessMonitor({
      spawn: () => {
        f = makeFakeChild();
        return f.child as unknown as ReturnType<typeof Object>;
      },
    });
    const signals: DiagnosticSignal[] = [];
    monitor.on('diagnostic', (s: DiagnosticSignal) => signals.push(s));
    monitor.watch({ command: 'sh -c true', label: 'tsc' });
    f!.emit.stderr(TS_LINE);
    await new Promise<void>((r) => queueMicrotask(r));
    f!.emit.stderr("src/bar.ts(20,1): error TS6133: 'x' is declared but never used.\n");
    await new Promise<void>((r) => queueMicrotask(r));
    expect(signals.length).toBe(2);
  });

  test('diagnoseNow bypasses the throttle gate', async () => {
    let f: ReturnType<typeof makeFakeChild> | undefined;
    const monitor = new ProcessMonitor({
      spawn: () => {
        f = makeFakeChild();
        return f.child as unknown as ReturnType<typeof Object>;
      },
    });
    const signals: DiagnosticSignal[] = [];
    monitor.on('diagnostic', (s: DiagnosticSignal) => signals.push(s));
    const { id } = monitor.watch({ command: 'sh -c true', label: 'tsc' });
    f!.emit.stderr(TS_LINE);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(signals.length).toBe(1);
    // Explicit /diagnose call should still produce a fresh emission even
    // though the signature was just emitted.
    const manual = monitor.diagnoseNow(id);
    expect(manual).not.toBeNull();
    expect(signals.length).toBe(2);
  });
});
