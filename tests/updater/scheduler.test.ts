/**
 * Coverage for `scheduleBackgroundCheck`. Uses injected setTimeoutFn /
 * clearTimeoutFn fakes so the test never waits on the real clock.
 * Verifies:
 *
 *   - `start()` arms the initial timer.
 *   - Firing the timer invokes onTick + arms the next one.
 *   - `stop()` clears any pending timer and ignores further fires.
 *   - `checkNow()` runs immediately without waiting for the timer.
 *   - An onTick that throws does not stop the chain.
 */

import { describe, expect, test } from 'bun:test';
import { scheduleBackgroundCheck } from '@/updater/scheduler';

interface FakeHandle {
  id: number;
  cb: () => void;
  cleared: boolean;
}

class FakeTimers {
  private next = 1;
  readonly handles = new Map<number, FakeHandle>();
  setTimeoutFn = (cb: () => void): unknown => {
    const id = this.next;
    this.next += 1;
    const h: FakeHandle = { id, cb, cleared: false };
    this.handles.set(id, h);
    return h;
  };
  clearTimeoutFn = (h: unknown): void => {
    if (h !== null && typeof h === 'object' && 'id' in (h as Record<string, unknown>)) {
      const handle = h as FakeHandle;
      handle.cleared = true;
      this.handles.delete(handle.id);
    }
  };
  fire(id: number): void {
    const h = this.handles.get(id);
    if (h === undefined) throw new Error(`no timer ${id}`);
    this.handles.delete(id);
    h.cb();
  }
}

describe('scheduleBackgroundCheck — basic timer chain', () => {
  test('start arms the initial timer', () => {
    const timers = new FakeTimers();
    const handle = scheduleBackgroundCheck({
      initialDelayMs: 5_000,
      intervalMs: 60_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onTick: async () => {
        /* no-op */
      },
    });
    handle.start();
    expect(timers.handles.size).toBe(1);
  });

  test('firing the timer invokes onTick and re-arms', async () => {
    const timers = new FakeTimers();
    let ticks = 0;
    const handle = scheduleBackgroundCheck({
      initialDelayMs: 5_000,
      intervalMs: 60_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onTick: async () => {
        ticks += 1;
      },
    });
    handle.start();
    // The first handle id is 1 — fire it.
    timers.fire(1);
    // tick is async; wait a turn.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ticks).toBe(1);
    expect(timers.handles.size).toBe(1); // next timer armed
  });

  test('stop cancels pending timer', () => {
    const timers = new FakeTimers();
    const handle = scheduleBackgroundCheck({
      initialDelayMs: 5_000,
      intervalMs: 60_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onTick: async () => {},
    });
    handle.start();
    expect(timers.handles.size).toBe(1);
    handle.stop();
    expect(timers.handles.size).toBe(0);
    expect(handle.running).toBe(false);
  });

  test('throwing onTick does not break the chain', async () => {
    const timers = new FakeTimers();
    let ticks = 0;
    const handle = scheduleBackgroundCheck({
      initialDelayMs: 5_000,
      intervalMs: 60_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onTick: async () => {
        ticks += 1;
        if (ticks === 1) throw new Error('boom');
      },
    });
    handle.start();
    timers.fire(1);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ticks).toBe(1);
    expect(timers.handles.size).toBe(1);
    timers.fire(2);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(ticks).toBe(2);
  });
});

describe('scheduleBackgroundCheck — checkNow', () => {
  test('runs onTick immediately', async () => {
    const timers = new FakeTimers();
    let ticks = 0;
    const handle = scheduleBackgroundCheck({
      initialDelayMs: 60_000,
      intervalMs: 60_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onTick: async () => {
        ticks += 1;
      },
    });
    handle.start();
    await handle.checkNow();
    expect(ticks).toBe(1);
  });
});
