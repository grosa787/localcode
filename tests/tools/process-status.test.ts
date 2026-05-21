/**
 * `process_status` tool — verifies the handler envelope shape and the
 * id-filter branches. Tests inject a fresh ProcessMonitor via the
 * augmented context so the singleton never sees a watch.
 */

import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import {
  processStatus,
  type ProcessStatusContext,
} from '@/tools/process-status';
import { ProcessMonitor } from '@/process-monitor';

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
  child.pid = 22222;
  child.kill = (): boolean => true;
  child.catch = (): unknown => Promise.resolve();
  child.then = (fn: () => void): unknown => { queueMicrotask(fn); return Promise.resolve(); };
  return child;
}

function makeCtx(monitor: ProcessMonitor): ProcessStatusContext {
  return {
    projectRoot: '/tmp/proj',
    dangerouslyAllowAll: false,
    processMonitor: monitor,
  };
}

describe('process_status (no args)', () => {
  test('reports the empty registry', async () => {
    const monitor = new ProcessMonitor();
    const res = await processStatus({}, makeCtx(monitor));
    expect(res.success).toBe(true);
    expect(res.output).toContain('processes=0');
    expect(res.output).toContain('no processes');
  });

  test('lists every watched process when no id is supplied', async () => {
    const monitor = new ProcessMonitor({
      spawn: () => fakeChild() as unknown as ReturnType<typeof Object>,
    });
    monitor.watch({ command: 'bun test', label: 'bun-test' });
    monitor.watch({ command: 'vite dev', label: 'vite-dev' });
    const res = await processStatus({}, makeCtx(monitor));
    expect(res.success).toBe(true);
    expect(res.output).toContain('processes=2');
    expect(res.output).toContain('bun-test');
    expect(res.output).toContain('vite-dev');
  });
});

describe('process_status with id', () => {
  test('narrows to the requested process', async () => {
    const monitor = new ProcessMonitor({
      spawn: () => fakeChild() as unknown as ReturnType<typeof Object>,
    });
    const { id: a } = monitor.watch({ command: 'echo a', label: 'a' });
    monitor.watch({ command: 'echo b', label: 'b' });
    const res = await processStatus({ id: a }, makeCtx(monitor));
    expect(res.success).toBe(true);
    expect(res.output).toContain('processes=1');
    expect(res.output).toContain('label="a"');
    expect(res.output).not.toContain('label="b"');
  });

  test('returns success:false on unknown id', async () => {
    const monitor = new ProcessMonitor();
    const res = await processStatus({ id: 'pm_missing' }, makeCtx(monitor));
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unknown watch id');
  });
});

describe('process_status arg validation', () => {
  test('rejects an empty-string id', async () => {
    const monitor = new ProcessMonitor();
    const res = await processStatus({ id: '' }, makeCtx(monitor));
    expect(res.success).toBe(false);
    expect(res.error?.toLowerCase()).toContain('invalid');
  });
});
