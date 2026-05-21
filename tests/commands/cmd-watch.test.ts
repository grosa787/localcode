/**
 * /watch command — covers the happy paths (list, tail, stop) plus the
 * unknown-id branches. The monitor is injected so we never spawn real
 * children.
 */

import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { createWatchCommand } from '@/commands/cmd-watch';
import { ProcessMonitor } from '@/process-monitor';
import type { AppConfig, CommandContext } from '@/types/global';

function fakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: () => boolean;
  catch: () => unknown;
  then: (fn: () => void) => unknown;
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
  child.pid = 12345;
  child.kill = (): boolean => true;
  child.catch = (): unknown => Promise.resolve();
  child.then = (fn: () => void): unknown => { queueMicrotask(fn); return Promise.resolve(); };
  return child;
}

function makeCtx(printSink: string[]): CommandContext {
  return {
    projectRoot: '/tmp/proj',
    sessionId: null,
    config: {} as AppConfig,
    print: (text: string): void => {
      printSink.push(text);
    },
    setScreen: (): void => {},
  };
}

describe('/watch (no args)', () => {
  test('prints usage', async () => {
    const monitor = new ProcessMonitor();
    const cmd = createWatchCommand({ projectRoot: '/tmp/proj', monitor });
    const sink: string[] = [];
    await cmd.execute('', makeCtx(sink));
    expect(sink.some((l) => l.toLowerCase().startsWith('usage:'))).toBe(true);
  });
});

describe('/watch <cmd>', () => {
  test('happy path — registers a watch and prints the id', async () => {
    const monitor = new ProcessMonitor({
      spawn: () => fakeChild() as unknown as ReturnType<typeof Object>,
    });
    const cmd = createWatchCommand({ projectRoot: '/tmp/proj', monitor });
    const sink: string[] = [];
    await cmd.execute('bun test --watch', makeCtx(sink));
    expect(monitor.size()).toBe(1);
    const joined = sink.join('\n');
    expect(joined).toMatch(/Watching pm_/);
    expect(joined).toContain('bun test --watch');
  });
});

describe('/watch list', () => {
  test('reports empty list when nothing is watched', async () => {
    const monitor = new ProcessMonitor();
    const cmd = createWatchCommand({ projectRoot: '/tmp/proj', monitor });
    const sink: string[] = [];
    await cmd.execute('list', makeCtx(sink));
    expect(sink.some((l) => l.toLowerCase().includes('no processes'))).toBe(true);
  });

  test('lists active watches when present', async () => {
    const monitor = new ProcessMonitor({
      spawn: () => fakeChild() as unknown as ReturnType<typeof Object>,
    });
    monitor.watch({ command: 'bun test', label: 'bun test' });
    monitor.watch({ command: 'vite', label: 'vite' });
    const cmd = createWatchCommand({ projectRoot: '/tmp/proj', monitor });
    const sink: string[] = [];
    await cmd.execute('list', makeCtx(sink));
    const joined = sink.join('\n');
    expect(joined).toContain('Watched processes (2)');
    expect(joined).toContain('bun test');
    expect(joined).toContain('vite');
  });
});

describe('/watch tail', () => {
  test('reports unknown id', async () => {
    const monitor = new ProcessMonitor();
    const cmd = createWatchCommand({ projectRoot: '/tmp/proj', monitor });
    const sink: string[] = [];
    await cmd.execute('tail pm_nope', makeCtx(sink));
    expect(sink.some((l) => l.includes('Unknown watch id'))).toBe(true);
  });

  test('prints recent output when known', async () => {
    const monitor = new ProcessMonitor({
      spawn: () => fakeChild() as unknown as ReturnType<typeof Object>,
    });
    const { id } = monitor.watch({ command: 'echo hi', label: 'echo' });
    // Manually feed the ring buffer via the same path the wire would.
    const rec = (
      monitor as unknown as {
        records: Map<string, { stdout: { append: (s: string, cb: (l: string) => void) => void } }>;
      }
    ).records.get(id);
    rec?.stdout.append('captured line\n', () => {});
    const cmd = createWatchCommand({ projectRoot: '/tmp/proj', monitor });
    const sink: string[] = [];
    await cmd.execute(`tail ${id}`, makeCtx(sink));
    const joined = sink.join('\n');
    expect(joined).toContain('[stdout]');
    expect(joined).toContain('captured line');
  });
});

describe('/watch stop', () => {
  test('reports unknown id', async () => {
    const monitor = new ProcessMonitor();
    const cmd = createWatchCommand({ projectRoot: '/tmp/proj', monitor });
    const sink: string[] = [];
    await cmd.execute('stop pm_nope', makeCtx(sink));
    expect(sink.some((l) => l.includes('Unknown watch id'))).toBe(true);
  });

  test('sends SIGTERM for live watch', async () => {
    const monitor = new ProcessMonitor({
      spawn: () => fakeChild() as unknown as ReturnType<typeof Object>,
    });
    const { id } = monitor.watch({ command: 'sh -c true', label: 'x' });
    const cmd = createWatchCommand({ projectRoot: '/tmp/proj', monitor });
    const sink: string[] = [];
    await cmd.execute(`stop ${id}`, makeCtx(sink));
    const joined = sink.join('\n');
    expect(joined).toMatch(/SIGTERM|not alive/);
  });
});
