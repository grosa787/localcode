/**
 * Detailed cost computation for the usage dashboard.
 *
 * The single-number `computeCost(model, in, out, cached)` in
 * `@/llm/pricing` is fine for the per-turn footer, but the dashboard
 * wants a breakdown of input / output / cache so users can see WHERE
 * their spend goes. This module is the canonical home for that
 * breakdown.
 *
 * USD result fields are kept at 6 decimal places of precision (i.e.
 * micro-cents) so summing many small per-turn costs is accurate; the
 * UI is responsible for the *displayed* rounding.
 */

import type { ModelPricing } from '@/llm/pricing';

/** Per-component spend in USD. All values ≥ 0. */
export interface CostBreakdown {
  /** Cost of fresh (non-cached) input tokens. */
  input: number;
  /** Cost of completion / output tokens. */
  output: number;
  /** Cost of cached-input tokens (read at the cache rate). */
  cache: number;
  /** Sum of the three above. */
  total: number;
}

/** Token counts entering the cost calculator. */
export interface UsageCounts {
  /** Total input tokens (BEFORE subtracting cached). */
  inputTokens?: number;
  /** Completion / output tokens. */
  outputTokens?: number;
  /** Subset of `inputTokens` served from prompt-cache. */
  cachedInputTokens?: number;
  /** Tokens written into the cache (Anthropic only). */
  cacheCreationTokens?: number;
}

/**
 * Compute a full cost breakdown for a single (usage, pricing) pair.
 *
 * Behaviour:
 *   - `null` pricing → `{ 0, 0, 0, 0 }` (e.g. local providers, unknown models).
 *   - Negative / NaN token counts clamp to zero — defensive.
 *   - `cachedInputTokens` is clamped to ≤ `inputTokens` so a buggy
 *     telemetry feed can't yield negative fresh-input charges.
 *   - When `cachedInputPer1M` is missing on the pricing record, cached
 *     tokens fall back to the input rate — pessimistic but safe.
 */
export function computeCostBreakdown(
  usage: UsageCounts,
  pricing: ModelPricing | null,
): CostBreakdown {
  if (pricing === null) {
    return { input: 0, output: 0, cache: 0, total: 0 };
  }

  const safeIn = clampNonNeg(usage.inputTokens);
  const safeOut = clampNonNeg(usage.outputTokens);
  const safeCached = Math.min(safeIn, clampNonNeg(usage.cachedInputTokens));
  const safeCacheWrite = clampNonNeg(usage.cacheCreationTokens);

  const freshIn = Math.max(0, safeIn - safeCached);
  const inputRate = pricing.inputPer1M;
  const outputRate = pricing.outputPer1M;
  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M;

  const input = round6((freshIn * inputRate) / 1_000_000);
  const output = round6((safeOut * outputRate) / 1_000_000);
  const cacheRead = (safeCached * cachedRate) / 1_000_000;

  // Cache-write surcharge (Anthropic). When the pricing record lacks
  // a dedicated `cacheWritePer1M`, fall back to the input rate so
  // we don't undercount — Anthropic publishes cache_write at 1.25× input.
  const writeRate =
    (pricing as { cacheWritePer1M?: number }).cacheWritePer1M ??
    pricing.inputPer1M * 1.25;
  const cacheWrite = (safeCacheWrite * writeRate) / 1_000_000;

  const cache = round6(cacheRead + cacheWrite);
  const total = round6(input + output + cache);

  return { input, output, cache, total };
}

function clampNonNeg(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

/**
 * Round to 6 decimal places (1 micro-cent). Avoids the floating-point
 * trail that makes dashboards look like `$0.00045000000003`.
 */
function round6(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Compact USD formatter for dashboard cells. Numbers below half a
 * cent collapse to `$0.00` so a wall of micro-rows doesn't look like
 * spend. Larger values render with two decimal places (`$1.23`).
 */
export function formatCostCell(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.005) return '$0.00';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export const __test__ = {
  clampNonNeg,
  round6,
};
