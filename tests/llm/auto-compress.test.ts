/**
 * Tests for the auto-compress trigger predicate
 * (`src/llm/auto-compress.ts`).
 *
 * The predicate is a pure function — these tests exercise its
 * decision boundary at 0%, 50%, 79%, 80%, 100%, > 100%, and at
 * various non-finite / negative inputs to confirm the defensive
 * defaults.
 */
import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_AUTO_COMPRESS_COOLDOWN_MS,
  DEFAULT_AUTO_COMPRESS_TRIGGER_PERCENT,
  autoCompressCooldownElapsed,
  shouldAutoCompress,
} from '@/llm/auto-compress';

describe('shouldAutoCompress', () => {
  test('default trigger constant is 0.80', () => {
    expect(DEFAULT_AUTO_COMPRESS_TRIGGER_PERCENT).toBe(0.8);
  });

  test('returns false at 0% usage', () => {
    expect(
      shouldAutoCompress({ contextTokens: 0, maxContextTokens: 10_000 }),
    ).toBe(false);
  });

  test('returns false at 50% usage (below default 80%)', () => {
    expect(
      shouldAutoCompress({ contextTokens: 5_000, maxContextTokens: 10_000 }),
    ).toBe(false);
  });

  test('returns false just under 80% (79.99%)', () => {
    expect(
      shouldAutoCompress({ contextTokens: 7_999, maxContextTokens: 10_000 }),
    ).toBe(false);
  });

  test('returns true at exactly 80% (default trigger)', () => {
    expect(
      shouldAutoCompress({ contextTokens: 8_000, maxContextTokens: 10_000 }),
    ).toBe(true);
  });

  test('returns true at 100% usage', () => {
    expect(
      shouldAutoCompress({ contextTokens: 10_000, maxContextTokens: 10_000 }),
    ).toBe(true);
  });

  test('returns true at > 100% usage (over budget)', () => {
    expect(
      shouldAutoCompress({ contextTokens: 12_000, maxContextTokens: 10_000 }),
    ).toBe(true);
  });

  test('honours an explicit triggerAtPercent override', () => {
    // 50% trigger → fires earlier.
    expect(
      shouldAutoCompress({
        contextTokens: 5_000,
        maxContextTokens: 10_000,
        triggerAtPercent: 0.5,
      }),
    ).toBe(true);
    // 95% trigger → does not fire at 80%.
    expect(
      shouldAutoCompress({
        contextTokens: 8_000,
        maxContextTokens: 10_000,
        triggerAtPercent: 0.95,
      }),
    ).toBe(false);
  });

  test('returns false on NaN / non-finite inputs', () => {
    expect(
      shouldAutoCompress({
        contextTokens: Number.NaN,
        maxContextTokens: 10_000,
      }),
    ).toBe(false);
    expect(
      shouldAutoCompress({
        contextTokens: 5_000,
        maxContextTokens: Number.NaN,
      }),
    ).toBe(false);
    expect(
      shouldAutoCompress({
        contextTokens: 5_000,
        maxContextTokens: 10_000,
        triggerAtPercent: Number.NaN,
      }),
    ).toBe(false);
    expect(
      shouldAutoCompress({
        contextTokens: Number.POSITIVE_INFINITY,
        maxContextTokens: 10_000,
      }),
    ).toBe(false);
  });

  test('returns false on non-positive maxContextTokens (guards div-by-zero)', () => {
    expect(
      shouldAutoCompress({ contextTokens: 100, maxContextTokens: 0 }),
    ).toBe(false);
    expect(
      shouldAutoCompress({ contextTokens: 100, maxContextTokens: -10 }),
    ).toBe(false);
  });

  test('clamps triggerAtPercent above 1 to 1 (still triggers when context fills)', () => {
    expect(
      shouldAutoCompress({
        contextTokens: 10_000,
        maxContextTokens: 10_000,
        triggerAtPercent: 2,
      }),
    ).toBe(true);
  });
});

describe('autoCompressCooldownElapsed', () => {
  test('default cooldown constant is 60s', () => {
    expect(DEFAULT_AUTO_COMPRESS_COOLDOWN_MS).toBe(60_000);
  });

  test('returns true when no compress has run yet (lastCompressAt = 0)', () => {
    expect(
      autoCompressCooldownElapsed({ lastCompressAt: 0, now: 5_000 }),
    ).toBe(true);
  });

  test('returns false inside the cooldown window', () => {
    const last = 1_700_000_000_000;
    expect(
      autoCompressCooldownElapsed({
        lastCompressAt: last,
        now: last + 30_000, // 30s elapsed; default cooldown is 60s
      }),
    ).toBe(false);
  });

  test('returns true at exactly the cooldown boundary', () => {
    const last = 1_700_000_000_000;
    expect(
      autoCompressCooldownElapsed({
        lastCompressAt: last,
        now: last + DEFAULT_AUTO_COMPRESS_COOLDOWN_MS,
      }),
    ).toBe(true);
  });

  test('returns true after the cooldown elapses', () => {
    const last = 1_700_000_000_000;
    expect(
      autoCompressCooldownElapsed({
        lastCompressAt: last,
        now: last + DEFAULT_AUTO_COMPRESS_COOLDOWN_MS + 1,
      }),
    ).toBe(true);
  });

  test('honours an explicit cooldownMs override', () => {
    const last = 1_000;
    // 5s window; 4s elapsed → blocked
    expect(
      autoCompressCooldownElapsed({
        lastCompressAt: last,
        now: last + 4_000,
        cooldownMs: 5_000,
      }),
    ).toBe(false);
    // 5s window; 5s elapsed → allowed
    expect(
      autoCompressCooldownElapsed({
        lastCompressAt: last,
        now: last + 5_000,
        cooldownMs: 5_000,
      }),
    ).toBe(true);
  });

  test('cooldown of 0 always allows (back-to-back compresses)', () => {
    expect(
      autoCompressCooldownElapsed({
        lastCompressAt: 1_000,
        now: 1_000,
        cooldownMs: 0,
      }),
    ).toBe(true);
  });

  test('NaN now blocks (defensive default)', () => {
    expect(
      autoCompressCooldownElapsed({
        lastCompressAt: 1_000,
        now: Number.NaN,
      }),
    ).toBe(false);
  });
});
