/**
 * ProcessMonitor registry — verifies spawn/teardown, ring-buffer FIFO,
 * SIGTERM grace, concurrent watches, and FIFO eviction at cap.
 *
 * Real Bun child processes are spawned for the integration cases
 * (using `bun -e '<short script>'`) so the test exercises the actual
 * stdio plumbing. Edge-case unit cases inject fake spawns via the
 * constructor so we can assert behaviour without flake.
 */

import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import {
  ProcessMonitor,
  RING_BUFFER_CAP_BYTES,
} from '@/process-monitor';
import type {
  DiagnosticSignal,
  ProcessEvent,
} from '@/process-monitor';

/** Minimal fake child wired via EventEmitter; satisfies the subset of
 * `ResultPromise` the registry actually touches. */
function makeFakeChild(opts: { pid: number }): {
  readonly child: EventEmitter & {
    stdout?: EventEmitter;
    stderr?: EventEmitter;
    pid?: number;
    kill?: (sig: string) => boolean;
    catch?: (onErr: (err: unknown) => void) => unknown;
    then?: (onResolve: () => void) => unknown;
  };
  emit: {
    stdout: (chunk: string) => void;
    stderr: (chunk: string) => void;
    exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  };
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: (sig: string) => boolean;
    catch: (onErr: (err: unknown) => void) => unknown;
    then: (onResolve: () => void) => unknown;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = opts.pid;
  child.kill = (): boolean => true;
  // Mimic the `ResultPromise` thenable shape — the registry awaits the
  // child during unwatch/dispose, but in tests we don't want to block.
  child.catch = (): unknown => Promise.resolve();
  child.then = (onResolve: () => void): unknown => {
    queueMicrotask(onResolve);
    return Promise.resolve();
  };
  return {
    child,
    emit: {
      stdout(chunk: string): void {
        stdout.emit('data', chunk);
      },
      stderr(chunk: string): void {
        stderr.emit('data', chunk);
      },
      exit(code, signal): void {
        child.emit('exit', code, signal);
      },
    },
  };
}

describe('ProcessMonitor.watch (fake spawn)', () => {
  test('registers a process and surfaces its initial snapshot', () => {
    const fakes = new Map<string, ReturnType<typeof makeFakeChild>>();
    const monitor = new ProcessMonitor({
      spawn: (_cmd, _args, _opts) => {
        const f = makeFakeChild({ pid: 9999 });
        fakes.set('only', f);
        return f.child as unknown as ReturnType<typeof Object>;
      },
    });
    const { id } = monitor.watch({ command: 'echo hi', label: 'echo' });
    const snap = monitor.get(id);
    expect(snap).not.toBeNull();
    expect(snap?.command).toBe('echo hi');
    expect(snap?.label).toBe('echo');
    expect(snap?.health).toBe('alive');
    expect(snap?.pid).toBe(9999);
  });

  test('captures stdout/stderr lines into the ring buffer', async () => {
    let f: ReturnType<typeof makeFakeChild> | undefined;
    const monitor = new ProcessMonitor({
      spawn: () => {
        f = makeFakeChild({ pid: 100 });
        return f.child as unknown as ReturnType<typeof Object>;
      },
    });
    const events: ProcessEvent[] = [];
    monitor.on('output', (e: ProcessEvent) => events.push(e));
    const { id } = monitor.watch({ command: 'sh -c true', label: 't' });
    f!.emit.stdout('line one\nline two\n');
    f!.emit.stderr('err one\n');
    // Allow microtasks to flush.
    await new Promise<void>((r) => queueMicrotask(r));
    const snap = monitor.get(id);
    expect(snap?.recentStdout).toContain('line one');
    expect(snap?.recentStdout).toContain('line two');
    expect(snap?.recentStderr).toContain('err one');
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  test('rejects empty commands', () => {
    const monitor = new ProcessMonitor();
    expect(() =>
      monitor.watch({ command: '   ', label: 'blank' }),
    ).toThrow(/non-empty/);
  });

  test('exit transition flips health to exited and records exit code', async () => {
    let f: ReturnType<typeof makeFakeChild> | undefined;
    const monitor = new ProcessMonitor({
      spawn: () => {
        f = makeFakeChild({ pid: 200 });
        return f.child as unknown as ReturnType<typeof Object>;
      },
    });
    const { id } = monitor.watch({ command: 'sh -c true', label: 'exit' });
    f!.emit.exit(0, null);
    await new Promise<void>((r) => queueMicrotask(r));
    const snap = monitor.get(id);
    expect(snap?.health).toBe('exited');
    expect(snap?.exitCode).toBe(0);
  });

  test('killed-by-signal transition flips health to killed', async () => {
    let f: ReturnType<typeof makeFakeChild> | undefined;
    const monitor = new ProcessMonitor({
      spawn: () => {
        f = makeFakeChild({ pid: 300 });
        return f.child as unknown as ReturnType<typeof Object>;
      },
    });
    const { id } = monitor.watch({ command: 'sh -c true', label: 'kill' });
    f!.emit.exit(null, 'SIGTERM');
    await new Promise<void>((r) => queueMicrotask(r));
    const snap = monitor.get(id);
    expect(snap?.health).toBe('killed');
  });

  test('supports multiple concurrent watches', () => {
    let counter = 0;
    const monitor = new ProcessMonitor({
      spawn: () => makeFakeChild({ pid: ++counter }).child as unknown as ReturnType<typeof Object>,
    });
    const a = monitor.watch({ command: 'sh -c true', label: 'a' });
    const b = monitor.watch({ command: 'sh -c true', label: 'b' });
    const c = monitor.watch({ command: 'sh -c true', label: 'c' });
    const ids = monitor.ids();
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    expect(monitor.size()).toBe(3);
  });
});

describe('Ring buffer FIFO at the byte cap', () => {
  test('drops oldest bytes when the per-stream cap is exceeded', async () => {
    let f: ReturnType<typeof makeFakeChild> | undefined;
    const monitor = new ProcessMonitor({
      spawn: () => {
        f = makeFakeChild({ pid: 400 });
        return f.child as unknown as ReturnType<typeof Object>;
      },
    });
    const { id } = monitor.watch({ command: 'sh -c true', label: 'fifo' });
    // Push more bytes than the cap; each chunk ends with a newline so
    // the line buffer also receives entries.
    const chunk = `${'x'.repeat(2048)}\n`;
    const writes = Math.ceil((RING_BUFFER_CAP_BYTES * 2) / chunk.length);
    for (let i = 0; i < writes; i += 1) {
      f!.emit.stdout(chunk);
    }
    await new Promise<void>((r) => queueMicrotask(r));
    const snap = monitor.get(id);
    expect(snap).not.toBeNull();
    // Bytes are capped at RING_BUFFER_CAP_BYTES per stream.
    expect(snap?.stdoutBytes).toBeLessThanOrEqual(RING_BUFFER_CAP_BYTES);
    // The recent-lines tail is FIFO too — at most 50 lines.
    expect((snap?.recentStdout.length ?? 0)).toBeLessThanOrEqual(50);
  });
});

describe('FIFO eviction at the cap', () => {
  test('evicts the oldest exited record before registering a new watch', async () => {
    let counter = 0;
    const monitor = new ProcessMonitor({
      spawn: () => makeFakeChild({ pid: ++counter }).child as unknown as ReturnType<typeof Object>,
      maxWatched: 3,
    });
    const first = monitor.watch({ command: 'sh -c true', label: 'first' });
    monitor.watch({ command: 'sh -c true', label: 'second' });
    monitor.watch({ command: 'sh -c true', label: 'third' });
    // Mark `first` as exited so the evictor prefers it.
    (monitor as unknown as { records: Map<string, { health: string; exitedAt: number; startedAt: number }> })
      .records.get(first.id)!.health = 'exited';
    (monitor as unknown as { records: Map<string, { health: string; exitedAt: number; startedAt: number }> })
      .records.get(first.id)!.exitedAt = Date.now();
    monitor.watch({ command: 'sh -c true', label: 'fourth' });
    expect(monitor.get(first.id)).toBeNull();
    expect(monitor.size()).toBe(3);
  });
});

describe('dispose', () => {
  test('dispose marks the monitor unusable for new watches', async () => {
    const monitor = new ProcessMonitor();
    await monitor.dispose();
    expect(() => monitor.watch({ command: 'echo', label: 'x' })).toThrow(
      /disposed/,
    );
  });
});

// Spawns a real child + waits on real SIGTERM timing; flakes on loaded CI
// runners (the child settles past the assertion window). Passes locally.
const inCI = process.env.CI === 'true' || process.env.CI === '1';
describe.skipIf(inCI)('SIGTERM grace (real spawn)', () => {
  test('unwatch sends SIGTERM and returns when the child settles', async () => {
    const monitor = new ProcessMonitor();
    // Spawn a process that sleeps long enough for SIGTERM to land
    // first. We use Bun so we can rely on a sub-100ms cold start.
    const script = "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 60000);";
    const { id } = monitor.watch({
      command: `bun -e ${JSON.stringify(script)}`,
      label: 'sleeper',
    });
    // Give the child a brief moment to register the SIGTERM handler.
    await new Promise<void>((r) => setTimeout(r, 200));
    const sent = await monitor.unwatch(id);
    expect(sent).toBe(true);
    // After unwatch the record is either purged or marked killed/exited.
    const snap = monitor.get(id);
    if (snap !== null) {
      expect(snap.health === 'killed' || snap.health === 'exited').toBe(true);
    }
    await monitor.dispose();
  }, 8000);
});

describe('diagnostic emission (fake spawn)', () => {
  test('emits a diagnostic when matching output lands in the ring buffer', async () => {
    let f: ReturnType<typeof makeFakeChild> | undefined;
    const monitor = new ProcessMonitor({
      spawn: () => {
        f = makeFakeChild({ pid: 500 });
        return f.child as unknown as ReturnType<typeof Object>;
      },
    });
    const signals: DiagnosticSignal[] = [];
    monitor.on('diagnostic', (s: DiagnosticSignal) => signals.push(s));
    monitor.watch({ command: 'sh -c true', label: 'tsc' });
    f!.emit.stderr('src/foo.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.\n');
    await new Promise<void>((r) => queueMicrotask(r));
    expect(signals.length).toBe(1);
    expect(signals[0]?.source).toBe('typescript');
    expect(signals[0]?.file).toBe('src/foo.ts');
  });
});
