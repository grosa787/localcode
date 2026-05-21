/**
 * Unified price resolver.
 *
 * For an OpenRouter-routed model, prefer the dynamically fetched
 * OpenRouter catalog (which carries up-to-date prices for thousands of
 * models including provider-specific variants). Fall back to the
 * static table for any other backend — and as a last resort, when the
 * OpenRouter cache is cold or doesn't include the requested model.
 *
 * Local providers (`ollama`, `lmstudio`) deliberately return `null`
 * (rather than `{ 0, 0 }`) so the UI can distinguish "free" from
 * "unknown" — both display "—" but the underlying signal matters when
 * aggregating across mixed-backend sessions.
 */

import type { Backend } from '@/types/global';
import type { ModelPricing } from '@/llm/pricing';
import { lookupStaticPrice } from '@/llm/pricing/static-pricing';
import { getOpenRouterPriceMapSync } from '@/llm/pricing/openrouter-pricing';

/**
 * Resolve a price entry for a model id given the backend it's running
 * against. Returns `null` when no entry can be located — the UI must
 * render "—" / "$0.00" for null cases and never invent a fake number.
 *
 * Resolution order:
 *   1. Backend === 'openrouter' → check the OpenRouter map (exact id,
 *      then basename match, then longest-prefix match).
 *   2. Static table — same three-tier resolution as the legacy
 *      `resolvePricing`.
 *   3. `null` for local providers (`ollama`, `lmstudio`) — they have
 *      zero marginal cost; UI shows "—".
 */
export function resolvePrice(
  backend: Backend | string,
  modelId: string,
): ModelPricing | null {
  if (typeof modelId !== 'string' || modelId.length === 0) return null;

  if (backend === 'ollama' || backend === 'lmstudio') {
    // Local backends — cost is zero but the dashboard should not bill
    // a $0 row that *looks* like a free cloud query. Returning null
    // lets the renderer pick the right label.
    return null;
  }

  if (backend === 'openrouter') {
    const map = getOpenRouterPriceMapSync();
    const hit = lookupInMap(map, modelId);
    if (hit !== null) return hit;
    // Fall through to static — the cache may be cold and the model
    // may still have a hardcoded entry (e.g. `qwen/qwen3-coder`).
  }

  return lookupStaticPrice(modelId);
}

/**
 * Three-tier match against a price map. Exposed so the OpenRouter
 * lookup and the static lookup share the same resolution rules — keeps
 * dashboards consistent across providers.
 */
function lookupInMap(
  map: Record<string, ModelPricing>,
  modelId: string,
): ModelPricing | null {
  const exact = map[modelId];
  if (exact !== undefined) return exact;

  const slashIdx = modelId.lastIndexOf('/');
  if (slashIdx >= 0) {
    const basename = modelId.slice(slashIdx + 1);
    const baseHit = map[basename];
    if (baseHit !== undefined) return baseHit;
  }

  let best: ModelPricing | null = null;
  let bestLen = 0;
  for (const [key, value] of Object.entries(map)) {
    if (modelId.startsWith(key) && key.length > bestLen) {
      best = value;
      bestLen = key.length;
    }
  }
  return best;
}
