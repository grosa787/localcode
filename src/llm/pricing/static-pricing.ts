/**
 * Static, hand-curated price table for cloud LLM providers.
 *
 * Re-exports {@link ModelPricing} and {@link PRICING} from
 * `src/llm/pricing.ts` so existing call sites that already import from
 * `@/llm/pricing` keep compiling — this file is the *primary* source of
 * truth for static prices; the legacy single-file module remains a
 * compatibility shim. The new modular layout (`src/llm/pricing/...`) is
 * preferred for new code.
 *
 * Sources (verify with vendor docs before bumping):
 *   - Anthropic:    https://www.anthropic.com/pricing#api
 *   - OpenAI:       https://openai.com/api/pricing/
 *   - Google AI:    https://ai.google.dev/pricing
 *   - DeepSeek:     https://api-docs.deepseek.com/quick_start/pricing
 *   - OpenRouter:   https://openrouter.ai/models  (per-model JSON)
 *
 * Prices are USD per **1M tokens** so the per-row numbers stay tidy and
 * the cost formula divides by `1_000_000` (rather than per-1K to match
 * OpenAI's old display). Cached and cache-write prices are optional —
 * the calculator falls back to `inputPer1M` when missing.
 *
 * Local providers (Ollama, LM Studio) have NO entry — `resolvePrice`
 * returns `null` and the UI renders "—" / `$0.00` for them. Local
 * inference has no marginal $ cost; surfacing a fake price would be
 * misleading.
 */

import { PRICING as LEGACY_PRICING, type ModelPricing } from '@/llm/pricing';

export type { ModelPricing };

/**
 * Optional extended pricing record. Mirrors the cloud-billing shape:
 *
 *   - `inputPer1M` — fresh prompt tokens.
 *   - `outputPer1M` — completion tokens.
 *   - `cachedInputPer1M` — prompt-cache read tokens (typically 0.1×..0.5× input).
 *   - `cacheWritePer1M` — prompt-cache write tokens (Anthropic only; typically 1.25× input).
 *
 * We re-export the canonical `ModelPricing` from the legacy module so
 * the type continues to flow through `UsageFooter.tsx`, the session
 * aggregator, and downstream consumers without a flag-day change.
 */
export interface ExtendedModelPricing extends ModelPricing {
  /**
   * Cache-write price (per 1M tokens). Only Anthropic exposes a
   * distinct cache-write rate — every other provider rolls cache-write
   * into the prompt rate. Optional everywhere.
   */
  cacheWritePer1M?: number;
}

/**
 * Live static pricing table. Equal to the legacy `PRICING` export from
 * `@/llm/pricing` (preserved via re-export so write-time mutations stay
 * coherent across the codebase). New entries should be added here.
 */
export const STATIC_PRICING: Record<string, ModelPricing> = LEGACY_PRICING;

/**
 * Direct lookup over the static table. Mirrors the legacy
 * `resolvePricing` resolution order:
 *   1. exact id (`anthropic/claude-3.5-sonnet`),
 *   2. basename after the last `/` (`claude-3.5-sonnet`),
 *   3. longest-prefix match (`anthropic/claude-3.5-sonnet:beta`).
 *
 * Returns `null` for any unknown model id so the UI can show "—".
 */
export function lookupStaticPrice(modelId: string): ModelPricing | null {
  if (typeof modelId !== 'string' || modelId.length === 0) return null;

  const exact = STATIC_PRICING[modelId];
  if (exact !== undefined) return exact;

  const slashIdx = modelId.lastIndexOf('/');
  if (slashIdx >= 0) {
    const basename = modelId.slice(slashIdx + 1);
    const baseHit = STATIC_PRICING[basename];
    if (baseHit !== undefined) return baseHit;
  }

  let best: ModelPricing | null = null;
  let bestLen = 0;
  for (const [key, value] of Object.entries(STATIC_PRICING)) {
    if (modelId.startsWith(key) && key.length > bestLen) {
      best = value;
      bestLen = key.length;
    }
  }
  return best;
}
