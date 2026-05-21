/**
 * HealthWatchdog regression tests.
 *
 * Exercises:
 *   - stuck runtime (isStreaming=true, no activity > staleAfterMs) gets force-reset,
 *   - active runtime (recent activity) is NOT reset,
 *   - idle runtime (not streaming) is ignored even with zero activity timestamp,
 *   - sweep is idempotent — calling twice on a still-stuck runtime is fine.
 */
import { describe, expect, test } from 'bun:test';

import {
  HealthWatchdog,
  type RuntimePoolLike,
  type WatchableRuntime,
} from '@/web/runtime/health-watchdog';

class FakeRuntime implements WatchableRuntime {
  streaming = true;
  lastActivity = 0;
  resetReasons: string[] = [];
  getLastActivityAt(): number {
    return this.lastActivity;
  }
  forceResetFromWatchdog(reason: string): boolean {
    if (!this.streaming) return false;
    this.streaming = false;
    this.resetReasons.push(reason);
    return true;
  }
}

function fakePool(map: Map<string, FakeRuntime>): RuntimePoolLike {
  return {
    *entries() {
      for (const [sessionId, runtime] of map.entries()) {
        yield { sessionId, runtime };
      }
    },
  };
}

describe('HealthWatchdog', () => {
  test('force-resets a streaming runtime with stale activity', () => {
    const rt = new FakeRuntime();
    rt.lastActivity = 1000; // long ago
    const pool = fakePool(new Map([['s1', rt]]));
    let nowVal = 1000 + 10 * 60 * 1000; // 10 minutes later
    const watchdog = new HealthWatchdog(pool, {
      staleAfterMs: 5 * 60 * 1000,
      now: () => nowVal,
    });
    const reset = watchdog.sweep();
    expect(reset).toEqual(['s1']);
    expect(rt.streaming).toBe(false);
    expect(rt.resetReasons.length).toBe(1);
    expect(rt.resetReasons[0]).toContain('no activity');

    // Second sweep — runtime is no longer streaming, so it's a no-op.
    nowVal += 1000;
    expect(watchdog.sweep()).toEqual([]);
  });

  test('does NOT reset a runtime with recent activity', () => {
    const rt = new FakeRuntime();
    rt.lastActivity = 1000;
    const pool = fakePool(new Map([['s1', rt]]));
    const watchdog = new HealthWatchdog(pool, {
      staleAfterMs: 5 * 60 * 1000,
      now: () => 1000 + 60 * 1000, // 1 minute later
    });
    expect(watchdog.sweep()).toEqual([]);
    expect(rt.streaming).toBe(true);
  });

  test('ignores idle (non-streaming) runtimes', () => {
    const rt = new FakeRuntime();
    rt.streaming = false;
    rt.lastActivity = 0;
    const pool = fakePool(new Map([['s1', rt]]));
    const watchdog = new HealthWatchdog(pool, {
      staleAfterMs: 1,
      now: () => Date.now() + 999_999,
    });
    expect(watchdog.sweep()).toEqual([]);
  });

  test('skips runtimes with zero activity timestamp (just-spawned guard)', () => {
    // Some runtimes seed lastActivity = 0 momentarily between
    // construction and first chunk. Watchdog must not nuke them.
    const rt = new FakeRuntime();
    rt.streaming = true;
    rt.lastActivity = 0;
    const pool = fakePool(new Map([['s1', rt]]));
    const watchdog = new HealthWatchdog(pool, {
      staleAfterMs: 1,
      now: () => 999_999,
    });
    expect(watchdog.sweep()).toEqual([]);
    expect(rt.streaming).toBe(true);
  });

  test('start/stop wires/unwires the timer (smoke)', () => {
    const pool = fakePool(new Map());
    const watchdog = new HealthWatchdog(pool, { sweepIntervalMs: 50 });
    watchdog.start();
    // Calling start twice is a no-op (does not throw).
    watchdog.start();
    watchdog.stop();
    watchdog.stop();
  });
});
