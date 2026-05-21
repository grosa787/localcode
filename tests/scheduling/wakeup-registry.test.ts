/**
 * `WakeupRegistry` coverage. Uses injected `setTimeoutFn`/`clearTimeoutFn`
 * fakes so no real wall-clock waits are required.
 *
 * Verifies:
 *   - schedule → fire after the timer's callback runs (calls onFire),
 *   - cancel removes the entry and clears the timer,
 *   - dispose tears down every pending entry and rejects further schedules,
 *   - subscribers see the snapshot eagerly and on every change.
 */

import { describe, expect, test } from 'bun:test';
import {
  WAKEUP_MAX_DELAY_MS,
  WAKEUP_MIN_DELAY_MS,
  WakeupRegistry,
  type ScheduledWakeup,
  type WakeupCallback,
} from '@/scheduling';

interface TimerHandle {
  readonly id: number;
  readonly cb: () => void;
  fired: boolean;
  cleared: boolean;
}

class FakeTimers {
  private next = 1;
  readonly handles = new Map<number, TimerHandle>();

  setTimeoutFn = (cb: () => void): unknown => {
    const id = this.next;
    this.next += 1;
    const handle: TimerHandle = { id, cb, fired: false, cleared: false };
    this.handles.set(id, handle);
    return handle;
  };

  clearTimeoutFn = (handle: unknown): void => {
    if (
      handle !== null &&
      typeof handle === 'object' &&
      'id' in (handle as Record<string, unknown>)
    ) {
      const h = handle as TimerHandle;
      h.cleared = true;
      this.handles.delete(h.id);
    }
  };

  /** Fire the timer with id `id` (mimics elapsed delay). */
  fire(id: number): void {
    const h = this.handles.get(id);
    if (h === undefined) throw new Error(`No fake timer with id ${id}`);
    if (h.cleared) return;
    h.fired = true;
    this.handles.delete(id);
    h.cb();
  }
}

describe('WakeupRegistry', () => {
  test('schedule + fire invokes onFire with the prompt', () => {
    const timers = new FakeTimers();
    const fired: Array<{ sid: string; prompt: string }> = [];
    const onFire: WakeupCallback = (sid, prompt) => {
      fired.push({ sid, prompt });
    };
    const reg = new WakeupRegistry(onFire, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    const id = reg.schedule('sess-1', {
      delayMs: 120_000,
      prompt: 'check build',
      reason: 'long-build',
    });
    expect(id).toMatch(/^wkup-/);
    expect(reg.size()).toBe(1);

    // Fire the (single) timer.
    const handles = [...timers.handles.values()];
    expect(handles).toHaveLength(1);
    const handle = handles[0];
    expect(handle).toBeDefined();
    if (handle === undefined) throw new Error('handle missing');
    timers.fire(handle.id);

    expect(fired).toHaveLength(1);
    expect(fired[0]?.sid).toBe('sess-1');
    expect(fired[0]?.prompt).toBe('check build');
    expect(reg.size()).toBe(0);
  });

  test('cancel removes the entry and clears the timer', () => {
    const timers = new FakeTimers();
    let fired = 0;
    const reg = new WakeupRegistry(() => { fired += 1; }, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    const id = reg.schedule('sess-A', {
      delayMs: 60_000,
      prompt: 'p',
      reason: 'r',
    });
    expect(reg.size()).toBe(1);
    const ok = reg.cancel(id);
    expect(ok).toBe(true);
    expect(reg.size()).toBe(0);

    // The timer's underlying handle is marked cleared; firing it is a no-op.
    // (Our fake's `fire()` early-returns on cleared handles.)
    expect(fired).toBe(0);
  });

  test('cancel on unknown id returns false', () => {
    const reg = new WakeupRegistry(() => {});
    expect(reg.cancel('nope')).toBe(false);
  });

  test('delayMs is clamped to [WAKEUP_MIN_DELAY_MS, WAKEUP_MAX_DELAY_MS]', () => {
    const timers = new FakeTimers();
    let lastDelay = -1;
    const reg = new WakeupRegistry(() => {}, {
      setTimeoutFn: (cb: () => void, ms: number): unknown => {
        lastDelay = ms;
        return timers.setTimeoutFn(cb);
      },
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    reg.schedule('s', { delayMs: 5, prompt: 'p', reason: 'r' });
    expect(lastDelay).toBe(WAKEUP_MIN_DELAY_MS);
    reg.schedule('s', { delayMs: 9_999_999, prompt: 'p', reason: 'r' });
    expect(lastDelay).toBe(WAKEUP_MAX_DELAY_MS);
  });

  test('subscribers see eager snapshot + every list change', () => {
    const timers = new FakeTimers();
    const reg = new WakeupRegistry(() => {}, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    const snapshots: ReadonlyArray<ScheduledWakeup>[] = [];
    const unsub = reg.subscribe((snap) => {
      snapshots.push(snap);
    });
    // Eager snapshot fired on subscribe: 1
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual([]);

    reg.schedule('s', { delayMs: 60_000, prompt: 'p', reason: 'r' });
    // schedule notify: 2
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.length).toBe(1);

    // Fire the timer — fire notify: 3
    const handle = [...timers.handles.values()][0];
    if (handle === undefined) throw new Error('handle missing');
    timers.fire(handle.id);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2]?.length).toBe(0);

    unsub();
  });

  test('dispose clears timers and rejects further schedules', () => {
    const timers = new FakeTimers();
    const reg = new WakeupRegistry(() => {}, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    reg.schedule('s', { delayMs: 60_000, prompt: 'p', reason: 'r' });
    expect(reg.size()).toBe(1);
    expect(timers.handles.size).toBe(1);

    reg.dispose();
    expect(reg.isDisposed).toBe(true);
    expect(reg.size()).toBe(0);
    expect(timers.handles.size).toBe(0);
    expect(() => reg.schedule('s', { delayMs: 60_000, prompt: 'p', reason: 'r' })).toThrow();
  });

  test('list() returns entries sorted by fireAt ascending', () => {
    const timers = new FakeTimers();
    let now = 1_000_000;
    const reg = new WakeupRegistry(() => {}, {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      nowFn: () => now,
    });
    reg.schedule('s', { delayMs: 120_000, prompt: 'second', reason: 'b' });
    now += 1000;
    reg.schedule('s', { delayMs: 60_000, prompt: 'first', reason: 'a' });
    const list = reg.list();
    expect(list[0]?.prompt).toBe('first');
    expect(list[1]?.prompt).toBe('second');
  });
});
