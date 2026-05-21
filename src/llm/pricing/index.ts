/**
 * Public surface of the modular pricing layer.
 *
 * Re-exports are organised so call sites can import from
 * `@/llm/pricing/<file>` for a specific concern, or from
 * `@/llm/pricing-module` (this index) when they want the umbrella API.
 *
 * The legacy single-file module `@/llm/pricing` remains the source of
 * truth for `PRICING` / `ModelPricing` / `computeCost` so existing
 * imports keep working — this index does NOT shadow that path.
 */

export type { ModelPricing } from '@/llm/pricing';
export {
  STATIC_PRICING,
  lookupStaticPrice,
} from '@/llm/pricing/static-pricing';
export type { ExtendedModelPricing } from '@/llm/pricing/static-pricing';
export {
  refreshOpenRouterPricing,
  getOpenRouterPriceMap,
  getOpenRouterPriceMapSync,
  parseOpenRouterResponse,
  configureOpenRouterPricingCache,
  __resetOpenRouterPricingForTests,
} from '@/llm/pricing/openrouter-pricing';
export type { OpenRouterPriceMap } from '@/llm/pricing/openrouter-pricing';
export { resolvePrice } from '@/llm/pricing/resolver';
export {
  computeCostBreakdown,
  formatCostCell,
} from '@/llm/pricing/cost-calculator';
export type {
  CostBreakdown,
  UsageCounts,
} from '@/llm/pricing/cost-calculator';
