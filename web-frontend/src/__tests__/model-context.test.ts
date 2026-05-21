/**
 * Unit tests for model-context resolver + token formatters.
 *
 * Runs under vitest (jsdom env, but these are pure-function tests —
 * no DOM dependency). Covers exact match, prefix fallback for unknown
 * variants, provider-family fallback, config fallback, formatter edge
 * cases, and percent clamping.
 */

import { describe, expect, test } from 'vitest';

import {
  contextUsagePercent,
  formatTokens,
  resolveContextWindow,
} from '../util/model-context';

describe('resolveContextWindow', () => {
  test('exact match resolves a known model', () => {
    expect(resolveContextWindow('anthropic/claude-3.5-sonnet', 8192)).toBe(
      200_000,
    );
    expect(resolveContextWindow('openai/gpt-4o', 8192)).toBe(128_000);
    expect(resolveContextWindow('google/gemini-2.5-pro', 8192)).toBe(
      1_000_000,
    );
    expect(resolveContextWindow('deepseek/deepseek-chat', 8192)).toBe(64_000);
  });

  test('strips :free / :nitro routing tags before matching', () => {
    expect(resolveContextWindow('openai/gpt-4o:free', 8192)).toBe(128_000);
    expect(resolveContextWindow('anthropic/claude-3.5-sonnet:beta', 8192)).toBe(
      200_000,
    );
  });

  test('strips trailing date stamps (Anthropic style)', () => {
    expect(
      resolveContextWindow('anthropic/claude-3.5-sonnet-20241022', 8192),
    ).toBe(200_000);
    expect(resolveContextWindow('anthropic/claude-3-opus-20240229', 8192)).toBe(
      200_000,
    );
  });

  test('prefix fallback catches unknown family variants', () => {
    // Unknown specific id, but the family prefix is known.
    expect(
      resolveContextWindow('anthropic/claude-future-model-2099', 8192),
    ).toBe(200_000);
    expect(resolveContextWindow('openai/gpt-4o-superduper', 8192)).toBe(
      128_000,
    );
  });

  test('provider-family fallback for completely unknown models', () => {
    expect(resolveContextWindow('x-ai/grok-99-experimental', 8192)).toBe(
      128_000,
    );
  });

  test('config fallback when model is unknown entirely', () => {
    expect(resolveContextWindow('totally-fake/no-such-model', 32_000)).toBe(
      32_000,
    );
  });

  test('safe default 8192 when model unknown and no config', () => {
    expect(resolveContextWindow('totally-fake/no-such-model', null)).toBe(8192);
    expect(resolveContextWindow('totally-fake/no-such-model', undefined)).toBe(
      8192,
    );
  });

  test('null / undefined / empty model id returns config fallback', () => {
    expect(resolveContextWindow(null, 16_000)).toBe(16_000);
    expect(resolveContextWindow(undefined, 16_000)).toBe(16_000);
    expect(resolveContextWindow('', 16_000)).toBe(16_000);
    expect(resolveContextWindow('   ', 16_000)).toBe(16_000);
  });

  test('ignores non-positive / NaN configMaxTokens', () => {
    expect(resolveContextWindow('totally-fake/no-such-model', 0)).toBe(8192);
    expect(resolveContextWindow('totally-fake/no-such-model', -100)).toBe(8192);
    expect(resolveContextWindow('totally-fake/no-such-model', Number.NaN)).toBe(
      8192,
    );
  });

  test('case-insensitive matching', () => {
    expect(resolveContextWindow('Anthropic/Claude-3.5-Sonnet', 8192)).toBe(
      200_000,
    );
  });
});

describe('formatTokens', () => {
  test('renders zero, sub-thousand, and exact thousand', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1K');
  });

  test('keeps one decimal under 10K, integer above', () => {
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(2100)).toBe('2.1K');
    expect(formatTokens(9900)).toBe('9.9K');
    expect(formatTokens(12_345)).toBe('12K');
    expect(formatTokens(99_500)).toBe('100K');
  });

  test('renders millions with M suffix', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_230_000)).toBe('1.2M');
    expect(formatTokens(2_000_000)).toBe('2M');
  });

  test('NaN / negative / non-finite inputs render as "0"', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(-1234)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatTokens(Number.NEGATIVE_INFINITY)).toBe('0');
  });
});

describe('contextUsagePercent', () => {
  test('basic ratios round to integer percent', () => {
    expect(contextUsagePercent(0, 100)).toBe(0);
    expect(contextUsagePercent(50, 100)).toBe(50);
    expect(contextUsagePercent(47_000, 80_000)).toBe(59);
  });

  test('clamps above 100 and below 0', () => {
    expect(contextUsagePercent(200, 100)).toBe(100);
    expect(contextUsagePercent(-50, 100)).toBe(0);
  });

  test('zero or non-positive total returns 0', () => {
    expect(contextUsagePercent(50, 0)).toBe(0);
    expect(contextUsagePercent(50, -10)).toBe(0);
    expect(contextUsagePercent(50, Number.NaN)).toBe(0);
  });

  test('non-finite used returns 0', () => {
    expect(contextUsagePercent(Number.NaN, 100)).toBe(0);
    expect(contextUsagePercent(Number.POSITIVE_INFINITY, 100)).toBe(0);
  });
});
