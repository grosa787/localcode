/**
 * Per-model pricing table — USD cost per 1M tokens.
 *
 * Used by the usage-dashboard aggregation (`SessionManager.getUsageStats`)
 * to compute approximate $ cost per session / per model / per day.
 *
 * **Approximate by design.** Provider list prices change without notice;
 * cache-hit / volume discounts / enterprise contracts are not modelled.
 * The dashboard surfaces this number with an "estimated" badge.
 *
 * Lookup is prefix-based (`resolvePricing`): "anthropic/claude-3.5-sonnet"
 * matches a stored row whose key is "anthropic/claude-3.5-sonnet" or
 * "claude-3.5-sonnet" (the latter for direct-from-Anthropic calls that
 * skip the OpenRouter prefix). Local providers (Ollama / LM Studio) have
 * no entry — `resolvePricing` returns null and the UI shows "—".
 */

export interface ModelPricing {
  /** USD per 1M input (prompt) tokens. */
  inputPer1M: number;
  /** USD per 1M output (completion) tokens. */
  outputPer1M: number;
  /**
   * USD per 1M cached input tokens (for prompt-prefix caching). When
   * absent the dashboard falls back to `inputPer1M` for cached tokens
   * (conservative — overestimates cost rather than under).
   */
  cachedInputPer1M?: number;
}

/**
 * Curated table of common cloud-model prices (Q1 2026 list).
 *
 * Entries are keyed by the canonical "<vendor>/<model>" id used by
 * OpenRouter, plus the short vendor-native ids that Anthropic / OpenAI
 * adapters emit. Multiple keys can map to the same row when the same
 * model is reachable via multiple gateways.
 */
export const PRICING: Record<string, ModelPricing> = {
  // ---------- Anthropic ----------
  'anthropic/claude-3.5-sonnet': { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  'anthropic/claude-3-5-sonnet': { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  'claude-3-5-sonnet': { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  'claude-3.5-sonnet': { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  'anthropic/claude-3.5-haiku': { inputPer1M: 0.8, outputPer1M: 4.0, cachedInputPer1M: 0.08 },
  'claude-3-5-haiku': { inputPer1M: 0.8, outputPer1M: 4.0, cachedInputPer1M: 0.08 },
  'anthropic/claude-3-opus': { inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 },
  'claude-3-opus': { inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 },
  'anthropic/claude-opus-4': { inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 },
  'claude-opus-4': { inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 },
  'anthropic/claude-sonnet-4': { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  'claude-sonnet-4': { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },

  // ---------- OpenAI ----------
  'openai/gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0, cachedInputPer1M: 1.25 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0, cachedInputPer1M: 1.25 },
  'openai/gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 },
  'openai/gpt-4-turbo': { inputPer1M: 10.0, outputPer1M: 30.0 },
  'gpt-4-turbo': { inputPer1M: 10.0, outputPer1M: 30.0 },
  'openai/gpt-5': { inputPer1M: 5.0, outputPer1M: 15.0, cachedInputPer1M: 0.5 },
  'gpt-5': { inputPer1M: 5.0, outputPer1M: 15.0, cachedInputPer1M: 0.5 },
  'openai/o1': { inputPer1M: 15.0, outputPer1M: 60.0 },
  'openai/o1-mini': { inputPer1M: 3.0, outputPer1M: 12.0 },

  // ---------- Google ----------
  'google/gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 5.0, cachedInputPer1M: 0.3125 },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 5.0, cachedInputPer1M: 0.3125 },
  'google/gemini-2.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3, cachedInputPer1M: 0.01875 },
  'gemini-2.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3, cachedInputPer1M: 0.01875 },
  'google/gemini-1.5-pro': { inputPer1M: 1.25, outputPer1M: 5.0 },
  'gemini-1.5-pro': { inputPer1M: 1.25, outputPer1M: 5.0 },

  // ---------- DeepSeek ----------
  'deepseek/deepseek-coder': { inputPer1M: 0.14, outputPer1M: 0.28 },
  'deepseek/deepseek-chat': { inputPer1M: 0.27, outputPer1M: 1.1 },
  'deepseek/deepseek-v3': { inputPer1M: 0.27, outputPer1M: 1.1, cachedInputPer1M: 0.07 },

  // ---------- Qwen ----------
  'qwen/qwen3-coder': { inputPer1M: 0.3, outputPer1M: 1.2 },
  'qwen/qwen3-coder:free': { inputPer1M: 0, outputPer1M: 0 },
  'qwen/qwen-2.5-coder-32b-instruct': { inputPer1M: 0.07, outputPer1M: 0.16 },

  // ---------- Local providers (no cost) ----------
  // Ollama / LM Studio model ids are not pre-registered — `resolvePricing`
  // returns null for unknown keys, and the UI renders "—" for cost. This
  // is the correct behaviour: local inference has no marginal $ cost.
};

/**
 * Resolve a pricing entry for a model id.
 *
 * Resolution order:
 *   1. Exact match on the full id (e.g. "anthropic/claude-3.5-sonnet").
 *   2. Exact match on the basename after the last `/` (e.g.
 *      "claude-3.5-sonnet"). Catches direct Anthropic/OpenAI ids that
 *      lack a vendor prefix.
 *   3. Longest-prefix match (e.g. "anthropic/claude-3.5-sonnet:beta"
 *      matches "anthropic/claude-3.5-sonnet"). Lets `:variant` suffixes
 *      and date-stamped revisions pick up base pricing.
 *
 * Returns `null` for any model that doesn't match — local models, custom
 * provider names, etc. The UI must handle null and surface "—".
 */
export function resolvePricing(modelId: string): ModelPricing | null {
  if (modelId.length === 0) return null;

  // (1) Exact match.
  const exact = PRICING[modelId];
  if (exact !== undefined) return exact;

  // (2) Basename match.
  const slashIdx = modelId.lastIndexOf('/');
  if (slashIdx >= 0) {
    const basename = modelId.slice(slashIdx + 1);
    const baseHit = PRICING[basename];
    if (baseHit !== undefined) return baseHit;
  }

  // (3) Longest-prefix match — sort keys descending by length so a more
  // specific match beats a less specific one.
  let best: ModelPricing | null = null;
  let bestLen = 0;
  for (const [key, value] of Object.entries(PRICING)) {
    if (modelId.startsWith(key) && key.length > bestLen) {
      best = value;
      bestLen = key.length;
    }
  }
  return best;
}

/**
 * Compute the USD cost for a given (model, tokensIn, tokensOut, cachedIn?) tuple.
 *
 * `cachedIn` is the count of input tokens served from prompt-cache. When
 * provided, those tokens are billed at `cachedInputPer1M` (or
 * `inputPer1M` as a conservative fallback) and excluded from the fresh
 * input total. `tokensIn` is the **total** input tokens — the fresh
 * portion is computed as `tokensIn - cachedIn`.
 *
 * Returns 0 for unknown models (no pricing entry). Returns 0 for
 * non-positive token counts. Result is in USD, not cents — display
 * with `.toFixed(4)` for small amounts.
 */
export function computeCost(
  modelId: string,
  tokensIn: number,
  tokensOut: number,
  cachedIn?: number,
): number {
  const pricing = resolvePricing(modelId);
  if (pricing === null) return 0;

  const safeIn = Number.isFinite(tokensIn) && tokensIn > 0 ? tokensIn : 0;
  const safeOut = Number.isFinite(tokensOut) && tokensOut > 0 ? tokensOut : 0;
  const safeCached =
    cachedIn !== undefined && Number.isFinite(cachedIn) && cachedIn > 0
      ? Math.min(cachedIn, safeIn)
      : 0;

  const freshIn = Math.max(0, safeIn - safeCached);
  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M;

  return (
    (freshIn * pricing.inputPer1M) / 1_000_000 +
    (safeCached * cachedRate) / 1_000_000 +
    (safeOut * pricing.outputPer1M) / 1_000_000
  );
}
