/**
 * Unsloth Studio — the money path must resolve to zero.
 *
 * `unsloth-local-classification.test.ts` pins the two pricing lookups
 * (`resolvePrice` → null, `getPricing` → all-zero). This file pins what
 * the UI actually consumes: the forecast chip and the per-message cost
 * that lands in the `messages.cost_usd` column.
 *
 * The failure this guards against is specific and plausible. Unsloth is
 * the first backend that both requires an API key and costs nothing, so
 * any code that reasons "has a key ⇒ bill it" will produce real dollar
 * figures for inference the user already paid for in electricity. A key
 * on this backend is authentication, never billing.
 */
import { describe, expect, test } from 'bun:test';
import { estimateNextTurn } from '@/llm/cost-estimator';
import { computeCostBreakdown } from '@/llm/pricing/cost-calculator';
import { resolvePrice } from '@/llm/pricing/resolver';
import { getPricing } from '@/llm/pricing';

const UNSLOTH_MODEL = 'unsloth/gemma-4-26B-A4B-it-GGUF';

describe('unsloth — next-turn forecast', () => {
  test('estimates exactly zero and is NOT flagged unknown', () => {
    // "Free" and "unpriced" are different states. Unsloth is free: the
    // chip should read $0.00, not "?".
    const est = estimateNextTurn({
      contextTokens: 120_000,
      cacheTokens: 0,
      currentModel: UNSLOTH_MODEL,
      provider: 'unsloth',
    });

    expect(est.estimated).toBe(0);
    expect(est.range).toEqual([0, 0]);
    expect(est.unknown).toBe(false);
  });

  test('stays zero at an absurd context size', () => {
    // A local 200k-token context is normal usage, and it is precisely
    // where an accidental cloud rate would produce an alarming number.
    const est = estimateNextTurn({
      contextTokens: 2_000_000,
      cacheTokens: 500_000,
      currentModel: UNSLOTH_MODEL,
      provider: 'unsloth',
      recentOutputAvg: 4_000,
    });

    expect(est.estimated).toBe(0);
    expect(est.unknown).toBe(false);
  });

  test('a model id that collides with a paid cloud model is still free', () => {
    // Nothing stops a user naming a local GGUF `gpt-4o`. The backend,
    // not the model string, decides whether money is involved.
    const local = estimateNextTurn({
      contextTokens: 100_000,
      cacheTokens: 0,
      currentModel: 'gpt-4o',
      provider: 'unsloth',
    });
    expect(local.estimated).toBe(0);

    // Control: the same id on OpenAI must cost real money, otherwise
    // this test would pass against a globally broken estimator.
    const cloud = estimateNextTurn({
      contextTokens: 100_000,
      cacheTokens: 0,
      currentModel: 'gpt-4o',
      provider: 'openai',
    });
    expect(cloud.estimated).toBeGreaterThan(0);
    expect(cloud.unknown).toBe(false);
  });
});

describe('unsloth — committed per-message cost', () => {
  test('resolvePrice + computeCostBreakdown yields a zero total', () => {
    // This is the exact pair used when an assistant message is written
    // to `messages.cost_usd`.
    const pricing = resolvePrice('unsloth', UNSLOTH_MODEL);
    const breakdown = computeCostBreakdown(
      { inputTokens: 90_000, outputTokens: 3_000, cachedInputTokens: 40_000 },
      pricing,
    );

    expect(breakdown.total).toBe(0);
    expect(breakdown.input).toBe(0);
    expect(breakdown.output).toBe(0);
    expect(breakdown.cache).toBe(0);
  });

  test('the zero-rate table produces a zero total too', () => {
    // Belt and braces: `getPricing` returns all-zero rates rather than
    // null, so cost must be zero through that route as well — the two
    // helpers disagree on null-vs-zero by design, but never on the
    // final number.
    const breakdown = computeCostBreakdown(
      { inputTokens: 500_000, outputTokens: 50_000, cachedInputTokens: 0 },
      getPricing('unsloth', UNSLOTH_MODEL),
    );

    expect(breakdown.total).toBe(0);
  });

  test('matches what Ollama and LM Studio produce', () => {
    // Unsloth must be indistinguishable from the other local backends in
    // the cost dashboard. The API key is the only difference between
    // them, and it is not a billing signal.
    const usage = {
      inputTokens: 10_000,
      outputTokens: 1_000,
      cachedInputTokens: 0,
    };
    const unsloth = computeCostBreakdown(
      usage,
      resolvePrice('unsloth', UNSLOTH_MODEL),
    );
    const ollama = computeCostBreakdown(
      usage,
      resolvePrice('ollama', 'qwen2.5-coder'),
    );
    const lmstudio = computeCostBreakdown(
      usage,
      resolvePrice('lmstudio', 'local-model'),
    );

    expect(unsloth).toEqual(ollama);
    expect(unsloth).toEqual(lmstudio);
  });
});
