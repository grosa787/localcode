/**
 * /diagnose — runs the diagnoser against watched processes and emits a
 * synthetic system message per signal. Tests inject a fresh monitor +
 * capture every `ctx.print` line + the synthetic message callback.
 */

import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { createDiagnoseCommand } from '@/commands/cmd-diagnose';
import { ProcessMonitor } from '@/process-monitor';
import type { AppConfig, CommandContext, Message } from '@/types/global';

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
  child.pid = 11111;
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

describe('/diagnose (no processes)', () => {
  test('reports the empty state', async () => {
    const monitor = new ProcessMonitor();
    const cmd = createDiagnoseCommand({ monitor });
    const sink: string[] = [];
    await cmd.execute('', makeCtx(sink));
    expect(sink.some((l) => l.toLowerCase().includes('no processes'))).toBe(true);
  });
});

describe('/diagnose <unknown id>', () => {
  test('prints the unknown-id explanation', async () => {
    const monitor = new ProcessMonitor();
    const cmd = createDiagnoseCommand({ monitor });
    const sink: string[] = [];
    await cmd.execute('pm_nope', makeCtx(sink));
    expect(sink.some((l) => l.includes('Unknown watch id'))).toBe(true);
  });
});

describe('/diagnose (happy path)', () => {
  test('emits a synthetic system message for the most recent failure', async () => {
    let fc: ReturnType<typeof fakeChild> | undefined;
    const monitor = new ProcessMonitor({
      spawn: () => {
        fc = fakeChild();
        return fc as unknown as ReturnType<typeof Object>;
      },
    });
    const { id } = monitor.watch({ command: 'bunx tsc', label: 'tsc' });
    fc!.stderr.emit(
      'data',
      "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n",
    );
    await new Promise<void>((r) => queueMicrotask(r));
    const captured: Message[] = [];
    const cmd = createDiagnoseCommand({
      monitor,
      injectSyntheticMessage: (m) => captured.push(m),
    });
    const sink: string[] = [];
    await cmd.execute(id, makeCtx(sink));
    const joined = sink.join('\n');
    expect(joined).toContain('reported');
    expect(joined).toContain('TS2322');
    expect(captured.length).toBe(1);
    expect(captured[0]?.role).toBe('system');
    expect(captured[0]?.content).toContain('TS2322');
  });

  test('reports per-process no-signal when nothing matched', async () => {
    const monitor = new ProcessMonitor({
      spawn: () => fakeChild() as unknown as ReturnType<typeof Object>,
    });
    monitor.watch({ command: 'echo hello', label: 'echo' });
    const cmd = createDiagnoseCommand({ monitor });
    const sink: string[] = [];
    await cmd.execute('', makeCtx(sink));
    expect(sink.some((l) => l.includes('no diagnostic signal'))).toBe(true);
  });
});
