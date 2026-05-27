/**
 * Next-turn cost estimator.
 *
 * Given the current chat's token totals and the active backend+model,
 * produce a USD forecast for the user's next reply. Used by the
 * cost-forecast chip rendered above the InputBar so users on cloud
 * providers are not surprised by the bill.
 *
 * Design notes:
 *   - Pricing comes from `getPricing(provider, model)` in
 *     `src/llm/pricing.ts`. That helper returns:
 *       - the `ModelPricing` row for known cloud models,
 *       - `{ 0, 0, 0 }` for local providers (Ollama, LM Studio),
 *       - `null` for unknown models (e.g. a fresh OpenRouter slug not
 *         yet in the static table; the estimator surfaces this as
 *         `unknown: true` so the UI can render a `?`).
 *   - Input cost charges `contextTokens - cacheTokens` at the fresh
 *     input rate, and `cacheTokens` at the cache-read rate (falling
 *     back to the fresh rate when the model has no published cache
 *     rate). Cache tokens are clamped to `contextTokens`.
 *   - Output is forecast from a `recentOutputAvg` (typically the
 *     average completion-token count over the last few assistant
 *     turns). Defaults to 500 when not supplied. The range `[low, high]`
 *     uses a `[0.5x, 2x]` envelope around the estimate to capture
 *     the inherent variance of completion length.
 *   - Local providers (`ollama`, `lmstudio`) return `{ 0, [0, 0], false }`
 *     so the UI can hide the chip without a special-case.
 */

import { getPricing } from '@/llm/pricing';

/**
 * Range envelope around the central estimate. `[low, high]` are USD
 * amounts that bracket the expected cost given the variance in
 * completion length and the fact that fresh-vs-cached input depends
 * on what the provider actually serves.
 */
export interface CostEstimate {
  /** Central USD estimate for the next turn. */
  readonly estimated: number;
  /** Lower / upper USD bound around `estimated`. */
  readonly range: readonly [low: number, high: number];
  /** True when the model has no known pricing. `estimated` is 0 in that case. */
  readonly unknown: boolean;
}

/** Default completion-token count when the caller has no recent history. */
export const DEFAULT_RECENT_OUTPUT = 500;

/**
 * Lower / upper envelope multipliers around the central estimate. The
 * range bakes in the typical 0.5x..2x variance of completion length
 * across consecutive turns — a strict pricing prediction is impossible
 * because the user hasn't typed the prompt yet.
 */
const RANGE_LOW = 0.5;
const RANGE_HIGH = 2.0;

export interface EstimateInputs {
  /** Total prompt tokens that will be sent (system + history + new turn). */
  readonly contextTokens: number;
  /** Subset of `contextTokens` served from the provider's prefix cache. */
  readonly cacheTokens: number;
  /** Active model id (e.g. `claude-opus-4-7`, `gpt-5`). */
  readonly currentModel: string;
  /** Backend the model is routed through (drives free / paid lookup). */
  readonly provider: string;
  /**
   * Recent completion-token average (last few assistant turns). Lets
   * the estimator track session-specific verbosity. Defaults to 500
   * when omitted or non-positive.
   */
  readonly recentOutputAvg?: number;
}

/**
 * Forecast the cost of the next assistant reply. Returns a central
 * estimate plus a `[low, high]` range envelope, or `{ unknown: true }`
 * when the model has no known pricing entry.
 */
export function estimateNextTurn(args: EstimateInputs): CostEstimate {
  const pricing = getPricing(args.provider, args.currentModel);
  if (pricing === null) {
    return { estimated: 0, range: [0, 0], unknown: true };
  }

  const ctx = clampNonNeg(args.contextTokens);
  const cache = Math.min(clampNonNeg(args.cacheTokens), ctx);
  const freshIn = Math.max(0, ctx - cache);

  const inputRate = pricing.inputPer1M;
  const outputRate = pricing.outputPer1M;
  const cacheRate = pricing.cachedInputPer1M ?? pricing.inputPer1M;

  const inputCost = (freshIn * inputRate) / 1_000_000;
  const cacheCost = (cache * cacheRate) / 1_000_000;
  const fixedCost = inputCost + cacheCost;

  const rawAvg = args.recentOutputAvg;
  const outputAvg =
    typeof rawAvg === 'number' && Number.isFinite(rawAvg) && rawAvg > 0
      ? rawAvg
      : DEFAULT_RECENT_OUTPUT;

  const outputCost = (outputAvg * outputRate) / 1_000_000;
  const estimated = fixedCost + outputCost;

  // Range envelope covers completion-length variance only — fresh
  // input is fully known at submit time, so it stays fixed across
  // the bounds.
  const low = fixedCost + (outputAvg * RANGE_LOW * outputRate) / 1_000_000;
  const high = fixedCost + (outputAvg * RANGE_HIGH * outputRate) / 1_000_000;

  return {
    estimated,
    range: [low, high],
    unknown: false,
  };
}

function clampNonNeg(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}
