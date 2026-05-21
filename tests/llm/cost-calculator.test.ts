/**
 * Cost-calculator math correctness — verifies the breakdown components
 * (input/output/cache) sum to the total, that cached tokens flow at
 * the cached rate, and that defensive clamping (negative tokens, NaN)
 * yields zeros.
 */

import { describe, test, expect } from 'bun:test';
import {
  computeCostBreakdown,
  formatCostCell,
} from '@/llm/pricing/cost-calculator';

describe('computeCostBreakdown', () => {
  test('null pricing → all zeros', () => {
    const c = computeCostBreakdown(
      { inputTokens: 1000, outputTokens: 1000 },
      null,
    );
    expect(c.total).toBe(0);
    expect(c.input).toBe(0);
    expect(c.output).toBe(0);
    expect(c.cache).toBe(0);
  });

  test('plain input + output math', () => {
    // gpt-4o-mini: 0.15 input / 0.6 output per 1M.
    // 100k in + 50k out = 0.015 + 0.03 = 0.045
    const c = computeCostBreakdown(
      { inputTokens: 100_000, outputTokens: 50_000 },
      { inputPer1M: 0.15, outputPer1M: 0.6 },
    );
    expect(c.input).toBeCloseTo(0.015, 6);
    expect(c.output).toBeCloseTo(0.03, 6);
    expect(c.cache).toBe(0);
    expect(c.total).toBeCloseTo(0.045, 6);
  });

  test('cached tokens billed at cached rate', () => {
    // gpt-4o style: input 2.5, cached 1.25, output 10.0 per 1M.
    // 1000 in (200 cached) + 0 out → 800 * 2.5/1e6 + 200 * 1.25/1e6
    //                               = 0.002 + 0.00025 = 0.00225
    const c = computeCostBreakdown(
      { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 200 },
      { inputPer1M: 2.5, outputPer1M: 10.0, cachedInputPer1M: 1.25 },
    );
    expect(c.input).toBeCloseTo(0.002, 6);
    expect(c.cache).toBeCloseTo(0.00025, 6);
    expect(c.total).toBeCloseTo(0.00225, 6);
  });

  test('cached fallback to input rate when cachedInputPer1M absent', () => {
    const c = computeCostBreakdown(
      { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 1000 },
      { inputPer1M: 1.0, outputPer1M: 2.0 },
    );
    // Without a cached rate, fresh in = 0; all 1000 priced at input rate (1.0).
    expect(c.cache).toBeCloseTo(0.001, 6);
    expect(c.input).toBe(0);
  });

  test('cachedIn capped at inputTokens (defensive)', () => {
    const c = computeCostBreakdown(
      { inputTokens: 200, cachedInputTokens: 500 },
      { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.5 },
    );
    expect(c.total).toBeGreaterThanOrEqual(0);
    // All 200 input tokens treated as cached (capped). Cost = 200 * 0.5/1e6.
    expect(c.cache).toBeCloseTo(0.0001, 6);
    expect(c.input).toBe(0);
  });

  test('negative / NaN tokens clamp to zero', () => {
    const c = computeCostBreakdown(
      {
        inputTokens: Number.NaN,
        outputTokens: -100,
        cachedInputTokens: -5,
      },
      { inputPer1M: 1.0, outputPer1M: 2.0 },
    );
    expect(c.total).toBe(0);
  });

  test('cache-write surcharge applies when cacheCreationTokens > 0', () => {
    const c = computeCostBreakdown(
      { inputTokens: 0, cacheCreationTokens: 1000 },
      { inputPer1M: 1.0, outputPer1M: 2.0 },
    );
    // No dedicated cacheWritePer1M → fallback to inputPer1M * 1.25 = 1.25.
    // 1000 * 1.25/1e6 = 0.00125
    expect(c.cache).toBeCloseTo(0.00125, 6);
  });

  test('explicit cacheWritePer1M overrides fallback', () => {
    const c = computeCostBreakdown(
      { cacheCreationTokens: 1000 },
      {
        inputPer1M: 1.0,
        outputPer1M: 2.0,
        cacheWritePer1M: 3.75,
      } as { inputPer1M: number; outputPer1M: number; cacheWritePer1M: number },
    );
    expect(c.cache).toBeCloseTo(0.00375, 6);
  });
});

describe('formatCostCell', () => {
  test('tiny costs collapse to $0.00', () => {
    expect(formatCostCell(0)).toBe('$0.00');
    expect(formatCostCell(0.001)).toBe('$0.00');
    expect(formatCostCell(0.0049)).toBe('$0.00');
  });

  test('mid-range costs render with 4 decimals', () => {
    expect(formatCostCell(0.01)).toBe('$0.0100');
    expect(formatCostCell(0.1234)).toBe('$0.1234');
  });

  test('large costs render with 2 decimals', () => {
    expect(formatCostCell(1.234)).toBe('$1.23');
    expect(formatCostCell(99.999)).toBe('$100.00');
  });

  test('negative / NaN → $0.00', () => {
    expect(formatCostCell(-1)).toBe('$0.00');
    expect(formatCostCell(Number.NaN)).toBe('$0.00');
  });
});
