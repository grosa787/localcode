/**
 * Model context window resolver.
 *
 * Maps a model id (typically the provider/model slug surfaced by
 * OpenRouter, Ollama, or the user's `--model` arg) onto the model's
 * advertised context window. Used by the ContextUsageRing in the
 * project bar to render a "% of context consumed" indicator.
 *
 * Resolution order:
 *   1. Exact match in `KNOWN_MODELS`.
 *   2. Strip provider-specific suffixes (`:free`, `:nitro`, `:beta`,
 *      `-latest`) and re-try exact match.
 *   3. Prefix scan: longest prefix in `KNOWN_MODELS` that matches the
 *      cleaned id wins (handles unknown variants of a known family —
 *      e.g. `anthropic/claude-3.5-sonnet-20241022` falls back to
 *      `anthropic/claude-3.5-sonnet`).
 *   4. Provider-only prefix scan as a final family fallback (e.g.
 *      `anthropic/<unknown>` → 200K).
 *   5. `configMaxTokens` from `cfg.context.maxTokens` if provided.
 *   6. Safe default of 8192.
 *
 * No `any`, no runtime deps. Pure functions only.
 */

export interface ModelContextInfo {
  modelId: string;
  contextWindow: number;
}

/**
 * Curated table of model context windows. The keys are normalised
 * (provider/model lowercase, no suffix). Adding a model: pick the
 * lowest documented limit if multiple variants ship — the ring is
 * intentionally pessimistic so users don't blow past the cache.
 */
const KNOWN_MODELS: Record<string, number> = {
  // Anthropic
  'anthropic/claude-3.5-sonnet': 200_000,
  'anthropic/claude-3.5-haiku': 200_000,
  'anthropic/claude-3-opus': 200_000,
  'anthropic/claude-3-sonnet': 200_000,
  'anthropic/claude-3-haiku': 200_000,
  'anthropic/claude-sonnet-4': 200_000,
  'anthropic/claude-sonnet-4.5': 200_000,
  'anthropic/claude-opus-4': 200_000,
  'anthropic/claude-opus-4.1': 200_000,
  'anthropic/claude-haiku-4': 200_000,
  // OpenAI
  'openai/gpt-4o': 128_000,
  'openai/gpt-4o-mini': 128_000,
  'openai/gpt-4-turbo': 128_000,
  'openai/gpt-4': 8_192,
  'openai/gpt-3.5-turbo': 16_385,
  'openai/o1': 200_000,
  'openai/o1-mini': 128_000,
  'openai/o1-preview': 128_000,
  'openai/o3-mini': 200_000,
  'openai/gpt-5': 256_000,
  'openai/gpt-5-mini': 256_000,
  // Google
  'google/gemini-2.5-pro': 1_000_000,
  'google/gemini-2.5-flash': 1_000_000,
  'google/gemini-2.0-flash-001': 1_000_000,
  'google/gemini-2.0-flash-thinking': 1_000_000,
  'google/gemini-1.5-pro': 2_000_000,
  'google/gemini-1.5-flash': 1_000_000,
  // DeepSeek
  'deepseek/deepseek-coder': 128_000,
  'deepseek/deepseek-chat': 64_000,
  'deepseek/deepseek-r1': 64_000,
  'deepseek/deepseek-v3': 64_000,
  'deepseek/deepseek-v4-flash': 128_000,
  // Qwen
  'qwen/qwen-2.5-coder-32b-instruct': 128_000,
  'qwen/qwen-2.5-72b-instruct': 128_000,
  'qwen/qwen3-coder': 256_000,
  'qwen/qwen3-max': 256_000,
  'qwen/qwen-vl-max': 32_000,
  'qwen/qwen-turbo': 128_000,
  'qwen/qwen-plus': 128_000,
  // Mistral
  'mistralai/mistral-large': 128_000,
  'mistralai/mistral-medium-3': 128_000,
  'mistralai/mistral-small-3': 32_000,
  'mistralai/codestral': 32_000,
  // Meta
  'meta-llama/llama-3.3-70b-instruct': 128_000,
  'meta-llama/llama-3.1-70b-instruct': 128_000,
  'meta-llama/llama-3.1-8b-instruct': 128_000,
  // GLM (Zhipu)
  'z-ai/glm-4.5': 128_000,
  'z-ai/glm-4.6': 128_000,
  // xAI
  'x-ai/grok-2': 128_000,
  'x-ai/grok-3': 128_000,
};

/**
 * Provider-only family fallback. When the cleaned id has a recognised
 * provider prefix but no model-level match in `KNOWN_MODELS`, we use
 * this conservative per-provider default. Single source of truth so
 * adding a provider in one place updates the fallback.
 */
const PROVIDER_FAMILY_FALLBACK: Record<string, number> = {
  'anthropic/': 200_000,
  'openai/': 128_000,
  'google/': 1_000_000,
  'deepseek/': 64_000,
  'qwen/': 128_000,
  'mistralai/': 128_000,
  'meta-llama/': 128_000,
  'z-ai/': 128_000,
  'x-ai/': 128_000,
};

const SAFE_DEFAULT = 8192;

/**
 * Strip OpenRouter / vendor suffixes that don't change the underlying
 * context window: `:free`, `:nitro`, `:beta`, `-latest`, `-preview`
 * markers, and any trailing build/date stamp like `-20241022`.
 */
function normaliseModelId(raw: string): string {
  let id = raw.trim().toLowerCase();
  // Drop colon-suffixed routing tags.
  const colonIdx = id.indexOf(':');
  if (colonIdx !== -1) id = id.slice(0, colonIdx);
  // Drop trailing -YYYYMMDD date stamps Anthropic uses.
  id = id.replace(/-\d{8}$/, '');
  // Drop trailing -latest sentinel.
  id = id.replace(/-latest$/, '');
  return id;
}

/**
 * Resolve the effective context window for a model id.
 *
 * Returns a positive integer; never NaN. Negative or zero
 * `configMaxTokens` is ignored.
 */
export function resolveContextWindow(
  modelId: string | null | undefined,
  configMaxTokens: number | null | undefined,
): number {
  const fallback =
    typeof configMaxTokens === 'number' &&
    Number.isFinite(configMaxTokens) &&
    configMaxTokens > 0
      ? Math.floor(configMaxTokens)
      : SAFE_DEFAULT;

  if (typeof modelId !== 'string' || modelId.length === 0) {
    return fallback;
  }
  const normalised = normaliseModelId(modelId);
  if (normalised.length === 0) return fallback;

  // 1. Exact match (raw or lower-cased).
  const exactRaw = KNOWN_MODELS[modelId];
  if (typeof exactRaw === 'number') return exactRaw;
  const exactNorm = KNOWN_MODELS[normalised];
  if (typeof exactNorm === 'number') return exactNorm;

  // 2. Longest model-level prefix scan (keeps unknown date-stamped
  // variants tied to their family). Sort entries by key length DESC so
  // the most specific match wins.
  const entries = Object.entries(KNOWN_MODELS).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [key, val] of entries) {
    if (normalised.startsWith(`${key}-`) || normalised.startsWith(`${key}/`)) {
      return val;
    }
  }

  // 3. Provider-family fallback.
  for (const [prefix, val] of Object.entries(PROVIDER_FAMILY_FALLBACK)) {
    if (normalised.startsWith(prefix)) return val;
  }

  // 4. Config / safe default.
  return fallback;
}

/**
 * Format a token count as a compact, human-readable string.
 *
 *   0       → "0"
 *   999     → "999"
 *   1_000   → "1K"
 *   1_500   → "1.5K"
 *   12_345  → "12K"
 *   1_000_000 → "1M"
 *   1_230_000 → "1.2M"
 *
 * Negative or non-finite inputs render as "0" (defensive — the ring
 * never wants to display "NaN" or "-3K").
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    if (m >= 100) return `${Math.round(m)}M`;
    if (m >= 10) return `${m.toFixed(1).replace(/\.0$/, '')}M`;
    return `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    if (k >= 10) return `${Math.round(k)}K`;
    // 1.5K, 2.1K — strip a trailing .0 so we don't show "1.0K".
    return `${k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(Math.round(n));
}

/**
 * Compute usage as an integer percent in [0, 100]. Non-finite or
 * non-positive `total` yields 0 (no division by zero).
 */
export function contextUsagePercent(used: number, total: number): number {
  if (!Number.isFinite(used) || used <= 0) return 0;
  if (!Number.isFinite(total) || total <= 0) return 0;
  const ratio = used / total;
  if (ratio <= 0) return 0;
  if (ratio >= 1) return 100;
  return Math.round(ratio * 100);
}
