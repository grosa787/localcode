/**
 * Adaptive streaming throttle (R-perf, 2026-05).
 *
 * The classification is a pure function of (state, { now, hasNewline }),
 * so every transition the production effect can encounter is exercised
 * here with a synthetic clock — no `setTimeout`, no wall-clock
 * sensitivity.
 *
 * Coverage matrix:
 *   1. First chunk of a stream → flush immediately, lastChunkAt set.
 *   2. Burst of normal chunks under 500ms → trailing 80ms throttle.
 *   3. 800ms gap → next chunk treated as post-intermission leader.
 *   4. Newline chunk → flush immediately, mode = 'fast'.
 *   5. Idle tick crosses 500ms boundary → mode flips to 'slow'.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyAdaptiveThrottle,
  tickAdaptiveThrottle,
  initialAdaptiveThrottleState,
  ADAPTIVE_THROTTLE_FAST_MS,
  ADAPTIVE_THROTTLE_NORMAL_MS,
  ADAPTIVE_INTERMISSION_GAP_MS,
  type AdaptiveThrottleState,
} from '@/integration/chat-state';

describe('adaptive throttle — single-chunk classifications', () => {
  test('first chunk of a fresh stream flushes immediately', () => {
    const res = classifyAdaptiveThrottle(initialAdaptiveThrottleState, {
      now: 1000,
      hasNewline: false,
    });
    expect(res.flushImmediately).toBe(true);
    expect(res.nextState.mode).toBe('normal');
    expect(res.nextState.lastChunkAt).toBe(1000);
  });

  test('newline chunk flushes immediately with fast mode', () => {
    const after1 = classifyAdaptiveThrottle(initialAdaptiveThrottleState, {
      now: 1000,
      hasNewline: false,
    });
    const res = classifyAdaptiveThrottle(after1.nextState, {
      now: 1050,
      hasNewline: true,
    });
    expect(res.flushImmediately).toBe(true);
    expect(res.throttleMs).toBe(ADAPTIVE_THROTTLE_FAST_MS);
    expect(res.nextState.mode).toBe('fast');
  });

  test('quick follow-up uses normal trailing throttle', () => {
    const after1 = classifyAdaptiveThrottle(initialAdaptiveThrottleState, {
      now: 1000,
      hasNewline: false,
    });
    const res = classifyAdaptiveThrottle(after1.nextState, {
      now: 1050,
      hasNewline: false,
    });
    expect(res.flushImmediately).toBe(false);
    expect(res.throttleMs).toBe(ADAPTIVE_THROTTLE_NORMAL_MS);
    expect(res.nextState.mode).toBe('normal');
  });
});

describe('adaptive throttle — burst → pause → burst pattern', () => {
  test('5 chunks in 50ms, 800ms pause, 5 more chunks', () => {
    // First burst: chunk every 10ms starting at t=1000.
    let s: AdaptiveThrottleState = initialAdaptiveThrottleState;
    const burst1Flushes: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const now = 1000 + i * 10;
      const r = classifyAdaptiveThrottle(s, { now, hasNewline: false });
      burst1Flushes.push(r.flushImmediately);
      s = r.nextState;
    }
    // First chunk: immediate flush. Followers: trailing throttle.
    expect(burst1Flushes).toEqual([true, false, false, false, false]);
    expect(s.lastChunkAt).toBe(1040);

    // 800ms gap: the next chunk arrives at t=1040 + 800 = 1840.
    const postGap = classifyAdaptiveThrottle(s, {
      now: 1840,
      hasNewline: false,
    });
    expect(postGap.flushImmediately).toBe(true);
    expect(postGap.nextState.mode).toBe('normal');
    s = postGap.nextState;

    // Second burst: same shape as the first.
    const burst2Flushes: boolean[] = [];
    for (let i = 1; i < 5; i++) {
      const now = 1840 + i * 10;
      const r = classifyAdaptiveThrottle(s, { now, hasNewline: false });
      burst2Flushes.push(r.flushImmediately);
      s = r.nextState;
    }
    // After the post-gap leader, the followers within the burst all
    // trail through the 80ms throttle.
    expect(burst2Flushes).toEqual([false, false, false, false]);
  });
});

describe('adaptive throttle — tick / intermission detection', () => {
  test('idle tick past the gap flips mode to slow', () => {
    const after1 = classifyAdaptiveThrottle(initialAdaptiveThrottleState, {
      now: 1000,
      hasNewline: false,
    });
    // Tick while still under the gap → no change.
    const tickEarly = tickAdaptiveThrottle(after1.nextState, 1400);
    expect(tickEarly.mode).toBe('normal');

    // Tick past the gap → mode flips to slow.
    const tickLate = tickAdaptiveThrottle(
      after1.nextState,
      1000 + ADAPTIVE_INTERMISSION_GAP_MS + 1,
    );
    expect(tickLate.mode).toBe('slow');
    // lastChunkAt is preserved — only a real chunk advances the clock.
    expect(tickLate.lastChunkAt).toBe(1000);
  });

  test('idle tick with no chunks yet is a no-op', () => {
    const tickFresh = tickAdaptiveThrottle(
      initialAdaptiveThrottleState,
      999999,
    );
    expect(tickFresh).toBe(initialAdaptiveThrottleState);
  });

  test('first chunk after intermission flushes immediately and resets to normal', () => {
    let s: AdaptiveThrottleState = initialAdaptiveThrottleState;
    s = classifyAdaptiveThrottle(s, { now: 1000, hasNewline: false }).nextState;
    s = tickAdaptiveThrottle(s, 1600); // crosses 500ms gap
    expect(s.mode).toBe('slow');

    const post = classifyAdaptiveThrottle(s, {
      now: 1700,
      hasNewline: false,
    });
    expect(post.flushImmediately).toBe(true);
    expect(post.nextState.mode).toBe('normal');
    expect(post.nextState.lastChunkAt).toBe(1700);
  });
});

describe('adaptive throttle — paragraph end fast flush', () => {
  test('newline chunk during normal burst flushes instantly', () => {
    let s: AdaptiveThrottleState = initialAdaptiveThrottleState;
    s = classifyAdaptiveThrottle(s, { now: 1000, hasNewline: false }).nextState;
    s = classifyAdaptiveThrottle(s, { now: 1050, hasNewline: false }).nextState;
    const r = classifyAdaptiveThrottle(s, { now: 1080, hasNewline: true });
    expect(r.flushImmediately).toBe(true);
    expect(r.throttleMs).toBe(ADAPTIVE_THROTTLE_FAST_MS);
    expect(r.nextState.mode).toBe('fast');
  });
});
