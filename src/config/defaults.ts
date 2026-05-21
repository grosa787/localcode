/**
 * Default values for LocalCode configuration + helper to build a
 * minimal-but-valid default `Config` for a given backend.
 *
 * Shapes are authoritative — referenced by Agent 2 (context manager
 * summariseAt threshold, max context tokens) and by the onboarding
 * screen (initial `baseUrl` per backend).
 *
 * R9 additions:
 *   - `PROVIDER_DEFAULTS` — per-provider base URL + whether a key is
 *     required.
 *   - `PROVIDER_META`     — display names, default models, env-var
 *     fallback names, UI hint strings.
 *   - `resolveApiKey()`   — explicit-config-key vs env-var fallback.
 *
 * The pre-existing `DEFAULTS.ollama` / `DEFAULTS.lmstudio` /
 * `DEFAULTS.maxContextTokens` blobs stay unchanged for back-compat
 * with call sites that read them directly. New code should prefer
 * `PROVIDER_DEFAULTS[backend]`.
 */

import type { Backend } from '@/types/global';
import type { Config } from './types';

export const DEFAULTS = {
  ollama: { baseUrl: 'http://localhost:11434' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1' },
  maxContextTokens: { ollama: 8192, lmstudio: 4096 },
  // 80% full → trigger summarisation.
  summarizeAt: 0.8,
  // No tools pre-approved by default — users opt in via /permissions.
  permissions: { autoApprove: [] as readonly string[] },
  // num_ctx forwarded to Ollama + keep-alive TTL (seconds) for VRAM
  // residency between requests + response stall timeout (seconds) the
  // LM Studio adapter waits between streamed chunks before bailing.
  // 300s (5 min) is a sane upper bound for most models; users with
  // slow hardware writing long code can bump it via `/context` up to
  // 7200s (2h).
  //
  // `trimToolResultsAfter` (ROADMAP #5) — keep the latest N tool
  // results verbatim and replace older ones with a one-line stub
  // before re-sending to the model. 3 is a tighter default than the
  // original 5; trims more aggressively to stretch large context
  // budgets (notably OpenRouter's 1M-token tier) on long sessions
  // where the model re-reads the same files. `0` disables trimming
  // entirely; users can raise via `/settings` (range 0..50).
  context: {
    maxTokens: 8192,
    keepAliveSeconds: 1800,
    responseTimeoutSeconds: 300,
    trimToolResultsAfter: 3,
    autoCompressPercent: 0.8,
    // Sliding-window cap on trailing messages sent to the LLM each
    // turn. 20 is enough for ~10 tool round-trips while keeping the
    // prompt small on 200+-message sessions. Set to 0 to disable.
    maxRecentMessages: 20,
  },
  // Sound-effect settings (FIX #29). Off by default; per-event toggles
  // are on so flipping `enabled` immediately does something useful.
  // `*File: null` means "use the system-default sound for this event".
  sound: {
    enabled: false,
    onCompletion: true,
    onApproval: true,
    onError: true,
    volume: 0.5,
    completionFile: null as string | null,
    approvalFile: null as string | null,
    errorFile: null as string | null,
  },
  // Generation parameters (FIX #35) — forwarded to the LLM. These
  // are the global-scope defaults; per-project `.localcode/settings.json`
  // can override individual fields.
  generation: {
    temperature: 0.2,
    topP: 0.9,
    repeatPenalty: 1.1,
    maxTokens: 4096,
  },
  // Multi-agent orchestration defaults. Mirrors `AgentsSchema` in
  // `src/config/types.ts`. `leadModel` is intentionally absent here —
  // the orchestrator falls back to the active session's model when the
  // user hasn't explicitly pinned a lead model.
  agents: {
    workerModel: 'deepseek/deepseek-coder',
    maxConcurrent: 5,
    isolation: 'worktree' as const,
    approval: 'auto' as const,
    defaultTimeoutSec: 600,
  },
  // Settings-driven hooks. Empty by default — the engine short-circuits
  // when no hooks are configured, matching the "zero overhead /
  // identical behaviour" promise for users who don't opt in.
  hooks: [] as readonly never[],
} as const;

export type DefaultsShape = typeof DEFAULTS;

// ---------- R9: per-provider defaults + metadata ----------

/**
 * Per-provider base URL + whether the provider needs an API key.
 *
 * This is the single source of truth consumed by `getDefaultBaseUrl()`,
 * onboarding, and the `/provider` command. The `custom` row has an
 * empty `baseUrl` because the user is expected to fill it in; we
 * accept the empty literal in `BackendSchema.baseUrl` for that case
 * and validate non-empty at the adapter layer.
 *
 * `requiresApiKey` is informational — used by the UI to mark a row
 * as needing a key and by `resolveApiKey()` indirectly via
 * `PROVIDER_META[backend].apiKeyEnvVar`.
 */
export const PROVIDER_DEFAULTS: Record<
  Backend,
  { baseUrl: string; requiresApiKey: boolean }
> = {
  ollama: { baseUrl: 'http://localhost:11434', requiresApiKey: false },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', requiresApiKey: false },
  openai: { baseUrl: 'https://api.openai.com/v1', requiresApiKey: true },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', requiresApiKey: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', requiresApiKey: true },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresApiKey: true,
  },
  // Empty until the user supplies one. `BackendSchema` accepts the
  // empty literal so this round-trips through validation cleanly.
  custom: { baseUrl: '', requiresApiKey: false },
};

/**
 * Per-provider UI / onboarding metadata.
 *
 * - `displayName` — human-readable label shown in the provider picker.
 * - `defaultModel` — model id pre-selected when the user first picks
 *   this provider. Optional because some providers (LM Studio,
 *   custom) require the user to discover models manually.
 * - `apiKeyEnvVar` — env-var consulted by `resolveApiKey()` when the
 *   config doesn't have an explicit `apiKey`. Following each
 *   provider's published convention (`OPENAI_API_KEY`,
 *   `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`).
 * - `apiKeyHelp` — one-line hint shown below the key field in the UI.
 */
export interface ProviderMeta {
  displayName: string;
  defaultModel?: string;
  apiKeyEnvVar?: string;
  apiKeyHelp?: string;
}

export const PROVIDER_META: Record<Backend, ProviderMeta> = {
  ollama: { displayName: 'Ollama (local)', defaultModel: 'llama3' },
  lmstudio: { displayName: 'LM Studio (local)' },
  openai: {
    displayName: 'OpenAI',
    defaultModel: 'gpt-4o',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    apiKeyHelp: 'Get key at platform.openai.com/api-keys',
  },
  anthropic: {
    displayName: 'Anthropic',
    defaultModel: 'claude-3-5-sonnet-20241022',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    apiKeyHelp: 'Get key at console.anthropic.com',
  },
  openrouter: {
    displayName: 'OpenRouter (cloud aggregator)',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    apiKeyHelp:
      'Get key at openrouter.ai/keys. From Russia: VPN or proxy may be needed.',
  },
  google: {
    displayName: 'Google Gemini',
    defaultModel: 'gemini-1.5-pro',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    apiKeyHelp: 'Get key at aistudio.google.com/apikey',
  },
  custom: {
    displayName: 'Custom (OpenAI-compat URL)',
    apiKeyHelp:
      'Most cloud providers (Groq, Fireworks, Mistral) work via custom + their URL.',
  },
};

/**
 * Resolve the API key for a backend, preferring an explicit
 * `BackendConfig.apiKey` and falling back to the per-provider env var
 * declared in `PROVIDER_META[backend].apiKeyEnvVar`.
 *
 * Returns `undefined` for local providers (no env var declared) and
 * for cloud providers when neither the config nor the env var carries
 * a value. The caller is responsible for surfacing a clear error when
 * a cloud provider needs a key but none was found.
 *
 * Reads `process.env` directly so dynamic env changes (e.g. tests
 * setting `OPENAI_API_KEY` at runtime) are picked up without needing
 * to rebuild the metadata table.
 */
export function resolveApiKey(
  backend: Backend,
  configKey?: string,
): string | undefined {
  if (configKey !== undefined && configKey.length > 0) return configKey;
  const meta = PROVIDER_META[backend];
  if (meta.apiKeyEnvVar === undefined) return undefined;
  return process.env[meta.apiKeyEnvVar];
}

// ---------- legacy helpers (kept for back-compat) ----------

/**
 * Return the default `baseUrl` for a given backend.
 *
 * R9: now sourced from `PROVIDER_DEFAULTS` so cloud providers and
 * `custom` are covered. For `custom` this returns the empty string —
 * call sites that need a non-empty value (the onboarding URL prompt,
 * the adapter base URL) should validate before using.
 */
export function getDefaultBaseUrl(backend: Backend): string {
  return PROVIDER_DEFAULTS[backend].baseUrl;
}

/**
 * Return the default max context tokens for a given backend.
 *
 * R9: cloud providers route through their own per-model context
 * windows (set by the adapter at request time), so for now we map
 * unknown providers to the LM Studio default (4096) — a conservative
 * lower bound. Specific cloud per-model windows are the adapter's
 * concern, not this top-level config helper.
 */
export function getMaxContextTokens(backend: Backend): number {
  if (backend === 'ollama') return DEFAULTS.maxContextTokens.ollama;
  return DEFAULTS.maxContextTokens.lmstudio;
}

/**
 * Build a minimal, schema-valid default `Config` for the chosen backend.
 *
 * - `model.current` is empty (caller fills in after model selection).
 * - `model.available` is an empty array (populated by model scan).
 * - `onboarding.completed` is `false` until the user finishes onboarding.
 * - `permissions.autoApprove` is empty (no pre-approved tools).
 * - `context.maxTokens` / `context.keepAliveSeconds` /
 *   `context.responseTimeoutSeconds` get sensible defaults
 *   (8192 / 1800s / 300s).
 * - `sound` is off by default; per-event toggles are pre-armed so
 *   flipping `enabled = true` does something useful immediately.
 * - `generation` carries sane LLM-sampling defaults (temp 0.2, top_p
 *   0.9, repeat_penalty 1.1, max_tokens 4096); per-project
 *   `.localcode/settings.json` can override field-by-field.
 */
export function getDefaultConfig(backend: Backend): Config {
  return {
    backend: {
      type: backend,
      baseUrl: getDefaultBaseUrl(backend),
    },
    model: {
      current: '',
      available: [],
    },
    onboarding: {
      completed: false,
    },
    permissions: {
      autoApprove: [],
      profile: 'default',
    },
    context: {
      maxTokens: DEFAULTS.context.maxTokens,
      keepAliveSeconds: DEFAULTS.context.keepAliveSeconds,
      responseTimeoutSeconds: DEFAULTS.context.responseTimeoutSeconds,
      trimToolResultsAfter: DEFAULTS.context.trimToolResultsAfter,
      autoCompressPercent: DEFAULTS.context.autoCompressPercent,
      maxRecentMessages: DEFAULTS.context.maxRecentMessages,
    },
    sound: {
      enabled: DEFAULTS.sound.enabled,
      onCompletion: DEFAULTS.sound.onCompletion,
      onApproval: DEFAULTS.sound.onApproval,
      onError: DEFAULTS.sound.onError,
      volume: DEFAULTS.sound.volume,
      completionFile: DEFAULTS.sound.completionFile,
      approvalFile: DEFAULTS.sound.approvalFile,
      errorFile: DEFAULTS.sound.errorFile,
    },
    generation: {
      temperature: DEFAULTS.generation.temperature,
      topP: DEFAULTS.generation.topP,
      repeatPenalty: DEFAULTS.generation.repeatPenalty,
      maxTokens: DEFAULTS.generation.maxTokens,
    },
    // Off by default — flip via `[diagnostics] dump_failed_requests = true`
    // in `~/.localcode/config.toml` when reproducing an OpenRouter failure.
    diagnostics: {
      dumpFailedRequests: false,
    },
    // Multi-agent orchestration defaults. `[agents]` section may be
    // absent on disk — these are the conservative starting points used
    // by `AgentOrchestrator` until the user overrides them.
    agents: {
      workerModel: DEFAULTS.agents.workerModel,
      maxConcurrent: DEFAULTS.agents.maxConcurrent,
      isolation: DEFAULTS.agents.isolation,
      approval: DEFAULTS.agents.approval,
      defaultTimeoutSec: DEFAULTS.agents.defaultTimeoutSec,
    },
    // Hooks — empty by default. Users opt in via `[[hooks]]` blocks
    // in `~/.localcode/config.toml`.
    hooks: [],
    // Statusline + output-style defaults. Pre-filled so the typed root
    // shape never has an undefined surface; users opt in to overrides
    // via `/statusline set <template>` / `/style <name>`.
    statusline: {
      enabled: true,
      template: '{provider} · {model} · {tokens}/{maxTokens} ({pct}%) · {profile}',
    },
    outputStyle: 'concise',
  };
}
