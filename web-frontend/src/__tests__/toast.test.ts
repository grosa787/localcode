/**
 * Toast — level-aware durations + sticky-on-long-error + per-toast override.
 */
import { describe, expect, test } from 'vitest';

import { dismissDurationFor } from '../components/Toast';
import type { UIToast } from '../state/store';

function makeToast(partial: Partial<UIToast>): UIToast {
  return {
    id: 'test',
    createdAt: 0,
    level: 'info',
    message: 'hi',
    ...partial,
  } as UIToast;
}

describe('dismissDurationFor', () => {
  test('info → 5000ms', () => {
    expect(dismissDurationFor(makeToast({ level: 'info' }))).toBe(5_000);
  });

  test('success → 5000ms', () => {
    expect(dismissDurationFor(makeToast({ level: 'success' }))).toBe(5_000);
  });

  test('warning → 8000ms', () => {
    expect(dismissDurationFor(makeToast({ level: 'warning' }))).toBe(8_000);
  });

  test('error → 12000ms by default', () => {
    expect(
      dismissDurationFor(makeToast({ level: 'error', message: 'short error' })),
    ).toBe(12_000);
  });

  test('error with very long message → 20000ms', () => {
    const longMessage = 'x'.repeat(250);
    expect(
      dismissDurationFor(makeToast({ level: 'error', message: longMessage })),
    ).toBe(20_000);
  });

  test('per-toast `duration` override beats defaults', () => {
    expect(
      dismissDurationFor(
        makeToast({ level: 'info', duration: 1_000 }),
      ),
    ).toBe(1_000);
    expect(
      dismissDurationFor(
        makeToast({ level: 'error', message: 'short', duration: 99_999 }),
      ),
    ).toBe(99_999);
  });

  test('duration: 0 marks toast as sticky', () => {
    expect(
      dismissDurationFor(
        makeToast({ level: 'info', duration: 0 }),
      ),
    ).toBe(0);
  });
});
