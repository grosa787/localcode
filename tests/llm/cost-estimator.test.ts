/**
 * Cost-estimator math correctness — verifies the next-turn forecast
 * matches the pricing table for known models, returns `unknown: true`
 * for unrecognised models, returns zero for local providers, that
 * cache tokens reduce the estimate proportionally, and that a higher
 * `recentOutputAvg` produces a higher estimate than the default.
 */

import { describe, test, expect } from 'bun:test';

import {
  estimateNextTurn,
  DEFAULT_RECENT_OUTPUT,
} from '@/llm/cost-estimator';

describe('estimateNextTurn', () => {
  test('claude-opus-4 with 50K context / 30K cache → matches table', () => {
    // claude-opus-4 pricing (static table): input $15, output $75,
    // cache-read $1.5 per 1M.
    // freshIn = 50_000 - 30_000 = 20_000
    // inputCost  = 20_000 * 15  / 1e6 = 0.30
    // cacheCost  = 30_000 * 1.5 / 1e6 = 0.045
    // outputCost = 500    * 75  / 1e6 = 0.0375  (default avg)
    // total      = 0.30 + 0.045 + 0.0375 = 0.3825
    const est = estimateNextTurn({
      contextTokens: 50_000,
      cacheTokens: 30_000,
      currentModel: 'claude-opus-4',
      provider: 'anthropic',
    });
    expect(est.unknown).toBe(false);
    expect(est.estimated).toBeCloseTo(0.3825, 6);
    // Range envelope: output * 0.5x .. 2x → 0.01875 .. 0.075 + fixed 0.345
    expect(est.range[0]).toBeCloseTo(0.345 + 0.01875, 6);
    expect(est.range[1]).toBeCloseTo(0.345 + 0.075, 6);
  });

  test('unknown model → { unknown: true, estimated: 0 }', () => {
    const est = estimateNextTurn({
      contextTokens: 10_000,
      cacheTokens: 0,
      currentModel: 'some-random-model-id-xyz',
      provider: 'openrouter',
    });
    expect(est.unknown).toBe(true);
    expect(est.estimated).toBe(0);
    expect(est.range[0]).toBe(0);
    expect(est.range[1]).toBe(0);
  });

  test('Ollama with any model → $0 (not unknown)', () => {
    const est = estimateNextTurn({
      contextTokens: 100_000,
      cacheTokens: 0,
      currentModel: 'llama3',
      provider: 'ollama',
    });
    expect(est.unknown).toBe(false);
    expect(est.estimated).toBe(0);
    expect(est.range[0]).toBe(0);
    expect(est.range[1]).toBe(0);
  });

  test('LM Studio → $0 even for cloud-named models', () => {
    const est = estimateNextTurn({
      contextTokens: 50_000,
      cacheTokens: 0,
      // local mirror of an Anthropic-named model — provider wins.
      currentModel: 'claude-3-opus',
      provider: 'lmstudio',
    });
    expect(est.unknown).toBe(false);
    expect(est.estimated).toBe(0);
  });

  test('cache tokens reduce the estimate proportionally', () => {
    const base = estimateNextTurn({
      contextTokens: 100_000,
      cacheTokens: 0,
      currentModel: 'claude-3-5-sonnet',
      provider: 'anthropic',
    });
    const cached = estimateNextTurn({
      contextTokens: 100_000,
      cacheTokens: 80_000,
      currentModel: 'claude-3-5-sonnet',
      provider: 'anthropic',
    });
    expect(cached.estimated).toBeLessThan(base.estimated);
    // Cache rate is 0.3 / input rate 3.0 → 10x cheaper, so 80% cached
    // input should clearly drop the bill.
    expect(cached.estimated).toBeLessThan(base.estimated * 0.5);
  });

  test('recentOutputAvg=2000 produces a higher estimate than the default', () => {
    const def = estimateNextTurn({
      contextTokens: 10_000,
      cacheTokens: 0,
      currentModel: 'gpt-4o-mini',
      provider: 'openai',
    });
    const big = estimateNextTurn({
      contextTokens: 10_000,
      cacheTokens: 0,
      currentModel: 'gpt-4o-mini',
      provider: 'openai',
      recentOutputAvg: 2000,
    });
    expect(big.estimated).toBeGreaterThan(def.estimated);
    // Output rate dominates the delta — 1500 extra tokens * 0.6/1M
    // = 0.0009 USD difference.
    expect(big.estimated - def.estimated).toBeCloseTo(
      ((2000 - DEFAULT_RECENT_OUTPUT) * 0.6) / 1_000_000,
      6,
    );
  });

  test('cacheTokens > contextTokens clamps safely', () => {
    const est = estimateNextTurn({
      contextTokens: 1_000,
      cacheTokens: 9_999_999,
      currentModel: 'gpt-4o',
      provider: 'openai',
    });
    expect(est.unknown).toBe(false);
    expect(est.estimated).toBeGreaterThanOrEqual(0);
  });

  test('negative / NaN inputs treated as zero', () => {
    const est = estimateNextTurn({
      contextTokens: Number.NaN,
      cacheTokens: -500,
      currentModel: 'gpt-4o-mini',
      provider: 'openai',
    });
    expect(est.unknown).toBe(false);
    // Only the default output portion contributes.
    // 500 * 0.6 / 1e6 = 0.0003
    expect(est.estimated).toBeCloseTo(0.0003, 6);
  });

  test('range envelope brackets the central estimate', () => {
    const est = estimateNextTurn({
      contextTokens: 25_000,
      cacheTokens: 5_000,
      currentModel: 'gemini-2.5-pro',
      provider: 'google',
      recentOutputAvg: 1000,
    });
    expect(est.unknown).toBe(false);
    expect(est.range[0]).toBeLessThanOrEqual(est.estimated);
    expect(est.range[1]).toBeGreaterThanOrEqual(est.estimated);
  });
});
