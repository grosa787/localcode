/**
 * Global shared types for LocalCode.
 *
 * These are types referenced across multiple modules. Agent-specific types
 * (e.g. LLM message shapes, tool-argument schemas) live in each agent's
 * own module files.
 */

// ---------- Screen routing ----------

export type Screen = 'onboarding' | 'chat' | 'skills' | 'modelSelect';

// ---------- Backend / configuration ----------

/**
 * Identifies the active LLM provider.
 *
 * Local providers (`ollama`, `lmstudio`) need no API key. Cloud
 * providers all require an `apiKey` either in `BackendConfig.apiKey`
 * or via the env-var fallback exposed by `PROVIDER_META[backend]
 * .apiKeyEnvVar` (see `src/config/defaults.ts`).
 *
 * - `openai`     — native OpenAI Chat Completions API.
 * - `anthropic`  — Messages API (different shape; uses `x-api-key`
 *                  header instead of `Authorization: Bearer`).
 * - `openrouter` — OpenAI-compatible aggregator at
 *                  https://openrouter.ai.
 * - `google`     — Gemini API (different request shape; adapter
 *                  arrives in a later round).
 * - `custom`     — user-supplied OpenAI-compatible base URL. Useful
 *                  for Groq, Fireworks, Mistral, vLLM, llama.cpp
 *                  server, etc.
 *
 * R9: widening the enum is migration-safe. Old configs that say
 * `'ollama'` or `'lmstudio'` remain valid since both literals stay in
 * the union. The new fields (`apiKey`, `customHeaders`) are optional
 * so existing TOMLs without them parse cleanly.
 */
export type Backend =
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'google'
  | 'custom';

export interface BackendConfig {
  type: Backend;
  baseUrl: string;
  /**
   * R9 — API key for cloud providers. Optional; when missing the
   * `resolveApiKey()` helper in `src/config/defaults.ts` falls back to
   * the per-provider env var (e.g. `OPENAI_API_KEY`). Local providers
   * (`ollama`, `lmstudio`) don't need a key — leave undefined.
   */
  apiKey?: string;
  /**
   * R9 — extra request headers, forwarded verbatim by the adapter.
   * Useful for proxies, custom auth schemes, OpenRouter site / app
   * tagging headers, etc. Keys and values are both `string`.
   */
  customHeaders?: Record<string, string>;
}

export interface ModelConfig {
  current: string;
  available: string[];
}

export interface OnboardingConfig {
  completed: boolean;
}

/**
 * Names of tools the user may pre-approve so they don't prompt per call.
 * Must match the `AutoApprovableToolSchema` enum in `src/config/types.ts`.
 */
export type AutoApprovableTool =
  | 'read_file'
  | 'write_file'
  | 'run_command'
  | 'list_dir'
  | 'glob_search';

/**
 * Permission profile. Mirrors `PermissionProfileSchema` in
 * `src/config/types.ts`. See the PERMISSIONS-PROFILE-SECTION there for
 * full semantics — short version:
 *   - `default`           — edit + command tools prompt.
 *   - `acceptEdits`       — edit tools auto, command tools prompt.
 *   - `plan`              — edit + command tools BLOCKED at the executor.
 *   - `dontAsk`           — edit + command tools auto (no UI banner).
 *   - `bypassPermissions` — edit + command tools auto + red WARNING banner.
 */
export type PermissionProfile =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions';

export interface PermissionsConfig {
  autoApprove: AutoApprovableTool[];
  /**
   * Active permission profile. Required on the type so the
   * `_ConfigAssert` witness in `src/config/types.ts` stays satisfied —
   * Zod parses old TOMLs that lack the field by filling in `'default'`
   * via the schema default, so end users never have to set it
   * manually. Onboarding / test literals construct `'default'`
   * explicitly (see `getDefaultConfig` in `src/config/defaults.ts`).
   */
  profile: PermissionProfile;
}

export interface ContextSettingsConfig {
  /** num_ctx value forwarded to Ollama. */
  maxTokens: number;
  /** How long to keep the model hot in VRAM between requests (seconds). */
  keepAliveSeconds: number;
  /**
   * Stall timeout (seconds) the LM Studio adapter waits between
   * streamed chunks before bailing. Default 300s (5 min); range
   * 30..7200 (30s..2h) to give slow models writing long code blocks
   * room to finish without leaving the client hanging indefinitely.
   */
  responseTimeoutSeconds: number;
  /**
   * ROADMAP #5 — tool-result trimming. When the model has accumulated
   * many `read_file` / tool-call results in history, replace bodies of
   * results older than the most recent N with a one-line stub
   * (`[tool: name(args) → N bytes / N lines collapsed; re-call to view]`)
   * before sending the next prompt to the model. The full content stays
   * in SQLite — only the wire-payload is trimmed.
   *
   * Range 0..50. `0` disables trimming entirely (keep everything verbatim).
   * Default `5` — keeps the latest 5 tool results untouched.
   */
  trimToolResultsAfter: number;
  /**
   * Auto-compress trigger threshold (0.5..0.95). When the estimated
   * context-token usage divided by `maxTokens` exceeds this value at
   * the end of a streaming turn, app.tsx queues a programmatic
   * `/compress` to summarise older history before the next turn.
   * Default 0.80. Set close to 0.95 to compress only at the brink, or
   * down to 0.50 to compress aggressively on long sessions.
   */
  autoCompressPercent: number;
  /**
   * Sliding-window cap on the number of trailing messages forwarded to
   * the LLM each turn. System prompt + any `[Compressed context]`
   * marker are kept on top. `0` disables (send full history). Range
   * 0..200; default 20.
   */
  maxRecentMessages: number;
}

/**
 * Sound-effect configuration (FIX #29). Controls whether LocalCode
 * plays an audible cue on approval prompts, tool-run completion, or
 * errors. `*File` fields are optional absolute paths to custom
 * `.wav`/`.mp3`; `null` means "use the system default for this event".
 */
export interface SoundConfig {
  enabled: boolean;
  onCompletion: boolean;
  onApproval: boolean;
  onError: boolean;
  /** 0.0 (silent) .. 1.0 (full volume). */
  volume: number;
  completionFile: string | null;
  approvalFile: string | null;
  errorFile: string | null;
}

/**
 * Generation parameters forwarded to the LLM (FIX #35). Mirrors
 * `GenerationSchema` in `src/config/types.ts`. In TypeScript we use
 * camelCase; the per-project `.localcode/settings.json` file uses
 * snake_case (`top_p`, `repeat_penalty`, `max_tokens`) — the mapping
 * happens in `ConfigManager.readProjectSettings`.
 */
export interface GenerationConfig {
  /** Sampling temperature (0..2). Lower → more deterministic. */
  temperature: number;
  /** Nucleus-sampling probability mass (0..1). */
  topP: number;
  /** Repetition penalty (0..2). 1.0 = neutral. */
  repeatPenalty: number;
  /** Hard cap on tokens generated per response. */
  maxTokens: number;
}

/**
 * Diagnostics configuration. When `dumpFailedRequests` is true, the
 * adapter writes a sanitized JSON dump of every non-2xx OpenRouter
 * response to `~/.localcode/diagnostics/`. Off by default — enable
 * only while reproducing a specific failure to share with maintainers.
 */
export interface DiagnosticsConfig {
  dumpFailedRequests: boolean;
}

/**
 * Multi-agent orchestration configuration.
 *
 * Used by `AgentOrchestrator` to size the team, pick worker models,
 * and decide whether sub-agents auto-approve their tool calls.
 */
export interface AgentsWorkerSlotConfig {
  /** Model id this worker slot prefers. */
  model: string;
  /** Optional skill IDs to bias the worker toward. */
  skills?: string[];
  /** Optional per-slot isolation override. */
  isolationOverride?: 'worktree' | 'shared';
  /** Optional per-slot timeout override (seconds). */
  timeoutSec?: number;
}

export interface AgentsConfig {
  /** Optional lead-model override; otherwise the active model is used. */
  leadModel?: string;
  /** Default model for newly spawned workers. */
  workerModel: string;
  /**
   * Optional worker-slot roster. When populated, the orchestrator
   * distributes spawned tasks across these slots in order. When absent
   * or empty, the team falls back to dynamic spawning using
   * `workerModel` for every worker.
   */
  workerSlots?: AgentsWorkerSlotConfig[];
  /** Hard cap on simultaneously-live workers per parent session. */
  maxConcurrent: number;
  /** Default isolation strategy. Worktree creates a git fork per worker. */
  isolation: 'worktree' | 'shared';
  /** 'auto' bypasses approval for sub-agent tool calls. */
  approval: 'auto' | 'per-action';
  /** Default `timeout` (seconds) when spawn_agent omits the field. */
  defaultTimeoutSec: number;
}

export interface AppConfig {
  backend: BackendConfig;
  model: ModelConfig;
  onboarding: OnboardingConfig;
  permissions: PermissionsConfig;
  context: ContextSettingsConfig;
  sound: SoundConfig;
  generation: GenerationConfig;
  /**
   * Optional on the type so existing call sites that build AppConfig
   * literals (onboarding, web/api) keep compiling. Zod fills in the
   * default `{ dumpFailedRequests: false }` when reading config from
   * disk, so the runtime value is always present.
   */
  diagnostics?: DiagnosticsConfig;
  /**
   * Multi-agent orchestration block. Optional for back-compat with
   * existing call sites; Zod fills in conservative defaults when the
   * `[agents]` section is absent from disk.
   */
  agents?: AgentsConfig;
  /**
   * Circuit-breaker tuning. Optional — defaults in
   * `src/llm/circuit-breaker.ts` apply when absent. Lets users dial in
   * a faster trip on a flakier upstream or a longer cooldown on a
   * provider they don't want to hammer.
   */
  circuitBreaker?: CircuitBreakerConfig;
  /**
   * Settings-driven hooks. Optional — when absent (or empty) the hook
   * engine short-circuits with zero overhead and the harness behaves
   * exactly as before. Each entry binds a shell command to one of the
   * four supported trigger points.
   */
  hooks?: HooksConfig;
  // SECURITY-CONFIG-SECTION
  /**
   * Security toggles. Currently a single nested switch for the built-in
   * secret scanner (PreToolUse hook on `git_commit`). Optional —
   * absence yields the safe defaults (`secretScanner.enabled = true`).
   */
  security?: SecurityConfig;
  // SECURITY-CONFIG-SECTION-END
  /**
   * MCP (Model Context Protocol) servers. Optional — when absent or
   * empty the MCP registry is dormant and adds zero overhead. Each
   * entry boots an MCP server (stdio or HTTP) and surfaces its tools
   * as native LocalCode tools named `mcp_<server>_<tool>`.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Statusline customization. When absent or `enabled: false`, the TUI
   * UsageFooter and web StatusLine fall back to the compact usage
   * format. When enabled, the `template` string is rendered via
   * `renderStatusline()` with the standard placeholder set.
   */
  statusline?: StatuslineConfig;
  /**
   * Active output style. Drives the short preamble injected into the
   * system prompt by `ContextManager.buildSystemPrompt`. Optional on
   * the type so existing AppConfig literals (onboarding, tests) keep
   * compiling; Zod fills in `'concise'` at parse time so the runtime
   * value is always present.
   */
  outputStyle: OutputStyle;
  /**
   * Composer / input feature toggles. Optional — absence yields the
   * safe defaults (vim off, mouse auto, vim-start-insert on) so old
   * configs round-trip cleanly.
   */
  editor?: EditorSettings;
  /**
   * Composer-only behaviour toggles (image attach, vision warning).
   * Optional — Zod fills `{ suppressVisionWarning: false }` when the
   * section is missing from the TOML.
   */
  composer?: ComposerSettings;
  // TEST-COMMAND-SECTION
  /**
   * Project-level shell template invoked by the "Run relevant tests"
   * inline button. Supports a `{files}` placeholder. When absent, the
   * detector falls back to `bun test {files}`. Read from per-project
   * `.localcode/settings.json` (snake_case `test_command`).
   */
  testCommand?: string;
  // TEST-COMMAND-SECTION-END
}

/**
 * Statusline customization shape. Mirrors `StatuslineConfigSchema` in
 * `src/config/types.ts`. `enabled` toggles the template renderer; when
 * false the UI falls back to the prior usage-only footer.
 */
export interface StatuslineConfig {
  enabled: boolean;
  /**
   * Template string with `{placeholder}` substitutions. Recognised
   * placeholders:
   *   `{model}`, `{tokens}`, `{maxTokens}`, `{pct}`, `{cachedTokens}`,
   *   `{cost}`, `{profile}`, `{provider}`, `{sessionId}`, `{branch}`,
   *   `{cwd}`. Unknown placeholders are rendered as empty strings.
   */
  template: string;
}

/**
 * Output style applied to the system prompt preamble. Matches
 * `OutputStyleSchema` in `src/config/types.ts`.
 */
export type OutputStyle = 'concise' | 'explanatory' | 'verbose';

/**
 * Composer / input feature toggles. Matches `EditorSettingsSchema` in
 * `src/config/types.ts`. All three fields default to the safe back-compat
 * baseline so absence-of-section in old TOMLs round-trips cleanly:
 *
 *   - `vimMode`        — modal editing in the composer. Default `false`.
 *   - `vimStartInsert` — start in INSERT (vs NORMAL). Default `true`.
 *   - `mouseSupport`   — accept mouse reporting (click-to-focus, wheel
 *                        scroll, message-ref clicks). Default `true`,
 *                        gated by terminal capability at runtime.
 */
export interface EditorSettings {
  vimMode: boolean;
  vimStartInsert: boolean;
  mouseSupport: boolean;
}

/**
 * Composer-only behaviour toggles. Matches `ComposerSettingsSchema` in
 * `src/config/types.ts`.
 *
 *   - `suppressVisionWarning` — silence the toast that warns the user
 *                                when attaching an image to a model
 *                                that is not heuristically vision-capable.
 *                                Default `false`.
 */
export interface ComposerSettings {
  suppressVisionWarning: boolean;
}

/**
 * MCP server connection config. v1 supports two transports:
 *   - `stdio`: spawn a subprocess and speak JSON-RPC over stdin/stdout.
 *   - `http`: POST JSON-RPC over HTTP (Streamable HTTP transport).
 *
 * Stdio is the common case (most published MCP servers ship as npm
 * binaries or Python scripts launched via `npx` / `uvx`).
 */
export interface McpServerConfig {
  /** Transport family. */
  type: 'stdio' | 'http';
  /** stdio: executable. e.g. "npx", "uvx", "/usr/local/bin/mcp-server-github" */
  command?: string;
  /** stdio: argv tail. e.g. ["-y", "@modelcontextprotocol/server-github"] */
  args?: string[];
  /** stdio: env var overrides — typically tokens / credentials. */
  env?: Record<string, string>;
  /** stdio: working directory. Defaults to project root. */
  cwd?: string;
  /** http: full URL of the JSON-RPC endpoint. */
  url?: string;
  /** http: additional headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Boot timeout in ms. Default 15_000. */
  startupTimeoutMs?: number;
}

/**
 * Circuit-breaker tuning shape. Maps 1:1 to `CircuitBreakerSchema` in
 * `src/config/types.ts`. All fields optional at construction — defaults
 * are filled in by the breaker itself.
 */
export interface CircuitBreakerConfig {
  /** Consecutive transient failures within {@link failureWindowMs} that trip the breaker. */
  failureThreshold: number;
  /** Sliding window for the failure count. */
  failureWindowMs: number;
  /** Initial cooldown after first open. */
  initialCooldownMs: number;
  /** Hard cap on cooldown growth. */
  maxCooldownMs: number;
  /** Cooldown growth factor applied on HALF_OPEN→OPEN. 1.0 = no growth. */
  cooldownGrowthFactor: number;
}

/**
 * Settings-driven hooks (Claude-Code style). Each entry is one shell
 * command bound to a trigger point. See `src/hooks/types.ts` for the
 * full behavioural contract. The TOML round-trips through
 * `HooksConfigSchema` in `src/config/types.ts`.
 */
export type HookTrigger =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'PreCompact'
  | 'SessionEnd'
  | 'Stop';

export interface HookConfigEntry {
  trigger: HookTrigger;
  /** Optional tool-name glob — only meaningful for tool triggers. */
  toolPattern?: string;
  /**
   * Shell command (`sh -c`); supports `${TOOL_ARG_<name>}` placeholders.
   * For built-in hooks the value is a synthetic label and is never
   * executed.
   */
  command: string;
  // BUILTIN-HOOKS-SECTION — name of an internal handler. Currently
  // recognized: `'secret-scanner'`. When set, the engine routes to the
  // internal handler instead of spawning a shell.
  builtin?: string;
  // BUILTIN-HOOKS-SECTION-END
  /** Wall-clock timeout in ms. Default 10_000. */
  timeout?: number;
  /** When true, a non-zero exit rejects the action. Default false. */
  blocking?: boolean;
  /** Optional human-readable description for the read-only viewer. */
  description?: string;
}

/**
 * Alias used by the runtime engine + config layer. Matches the
 * `hooks` top-level array in TOML; an empty array (or missing section)
 * disables every hook with zero overhead.
 */
export type HooksConfig = HookConfigEntry[];

// SECURITY-CONFIG-SECTION
/**
 * Security toggles surfaced via the top-level `[security]` TOML
 * section. Mirrors `SecuritySchema` in `src/config/types.ts`. Defaults
 * are filled by Zod when the section is absent.
 */
export interface SecurityConfig {
  secretScanner: {
    /** Master on/off switch for the built-in secret scanner. Default `true`. */
    enabled: boolean;
  };
}
// SECURITY-CONFIG-SECTION-END

// ---------- CLI args ----------

export interface CliArgs {
  projectRoot: string;
  dangerouslyAllowAll: boolean;
  resumeSessionId: string | null;
  modelOverride: string | null;
}

// ---------- Chat messages ----------

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  requiresApproval?: boolean;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  createdAt: number;
  /**
   * Optional usage / timing telemetry captured by the LLM adapter
   * (Round-3 additions). All three fields are nullable in the DB so
   * existing rows and call sites that don't supply them keep working.
   */
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
  /**
   * Name of the model that generated this message (assistant role only).
   * Optional + nullable in DB for backward compat with rows persisted
   * before the column existed. Used by the chat UI to render the
   * correct per-message label so switching the active model mid-session
   * does NOT retroactively relabel old assistant messages.
   */
  model?: string;
  /**
   * COST-PERSIST-SECTION
   * Per-message USD cost computed at addMessage time via the
   * OpenRouter-aware resolver (`@/llm/pricing/resolver`) +
   * `computeCostBreakdown`. Optional — local providers and legacy
   * rows without pricing leave this undefined. The UI surfaces a
   * compact `$X.XXXX` chip when defined.
   * COST-PERSIST-SECTION-END
   */
  cost?: number;
  /**
   * COST-PERSIST-SECTION
   * Prompt tokens served from the provider's prefix cache (echoed
   * from `StreamUsage.cachedInputTokens`). Optional for legacy rows.
   * COST-PERSIST-SECTION-END
   */
  cachedInputTokens?: number;
  /**
   * COST-PERSIST-SECTION
   * Anthropic-only: tokens written into the cache this turn.
   * COST-PERSIST-SECTION-END
   */
  cacheCreationTokens?: number;
}

// ---------- Sessions ----------

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  projectRoot: string;
  title: string | null;
  model: string;
  backend: string;
  /**
   * Round-4 addition — compressed summary of the previous chat,
   * persisted on save and injected back into context on `/resume`.
   * Null for fresh sessions that haven't been summarized yet.
   */
  summary: string | null;
}

// ---------- Skills ----------

/**
 * Where a skill was loaded from:
 *   - `'project'` → `<projectRoot>/.localcode/skills/<id>.md`
 *   - `'global'`  → `~/.localcode/skills/<id>.md`
 *
 * Skills with the same id in both locations are resolved with
 * project-local taking priority (see SkillsManager).
 *
 * Optional for backwards compatibility with callers that construct
 * Skill records directly (tests, inline onboarding flows).
 */
export type SkillSource = 'project' | 'global';

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  active: boolean;
  path: string;
  source?: SkillSource;
}

// ---------- Slash commands ----------

/**
 * Round-4 addition — identifier for the local UI overlay that a slash
 * command may open instead of emitting text into the chat transcript.
 *
 * FIX #32: `/permissions`, `/context`, `/ctxsize`, `/resume`, `/model`,
 * and `/provider` (FIX #33) open their respective overlays when the
 * command is invoked without arguments. The overlay consumes keyboard
 * input exclusively until closed — the command itself never hits the
 * LLM.
 *
 * Round-5 (FIX #35) adds `'settings'` for the per-project generation
 * params overlay opened by `/settings`.
 *
 * `'skills'` is reserved for future use (e.g. `/skills` → the skills
 * browser overlay).
 */
export type OverlayKind =
  | 'permissions'
  | 'context'
  | 'ctxsize'
  | 'resume'
  | 'model'
  | 'provider'
  | 'skills'
  | 'settings'
  | 'usage'
  | 'cost'
  | 'perf'
  // BRANCHES-OVERLAY-KIND — `/branch` picker (Ctrl+B).
  | 'branch';

export interface CommandContext {
  projectRoot: string;
  sessionId: string | null;
  config: AppConfig;
  print: (text: string) => void;
  setScreen: (screen: Screen) => void;
  /**
   * Open a local UI overlay of the given kind. The overlay consumes
   * input exclusively until closed. Optional for backward compatibility
   * with existing callers that don't supply an overlay dispatcher —
   * commands that need it should check and fall back to text output
   * (via `print`) when `showOverlay` is undefined.
   *
   * R13 (Agent 8) — optional `data` payload threads kind-specific
   * details through to the overlay reducer. Currently only consumed
   * for `kind === 'model'`, where `data.filter` pre-seeds the inline
   * filter (used by `/model <query>` when `<query>` doesn't match a
   * model exactly). Other kinds ignore it. Existing callers that
   * invoke `showOverlay(kind)` without data continue to work unchanged.
   */
  showOverlay?: (
    kind: OverlayKind,
    data?: { filter?: string },
  ) => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  execute: (args: string, context: CommandContext) => Promise<void> | void;
}

// ---------- App state / actions ----------

export interface AppState {
  screen: Screen;
  config: AppConfig | null;
  sessionId: string | null;
}

export type AppAction =
  | { type: 'SET_SCREEN'; screen: Screen }
  | { type: 'SET_CONFIG'; config: AppConfig }
  | { type: 'SET_SESSION'; sessionId: string | null }
  | { type: 'RESET' };

// PLUGIN-SDK-TYPES-SECTION
/**
 * Wave 6D — public plugin SDK types are owned by `src/plugins/sdk/`.
 * The canonical Zod-derived `PluginManifest` shape is exported from
 * `@/plugins/sdk` (and its public barrel) so plugin authors don't reach
 * into deep paths. We re-export it here so callers that prefer importing
 * from `@/types/global` (matching the rest of the cross-module surface)
 * still see exactly the same type.
 *
 * Keep this in lockstep with `PluginManifestSchema` — adding a field on
 * the schema automatically widens the re-exported type via `z.infer`.
 */
export type {
  PluginManifest,
  PluginCapabilities,
  PluginToolDef,
  PluginCommandDef,
  PluginStatuslineDef,
  PluginThemeDef,
} from '@/plugins/sdk/types';
// PLUGIN-SDK-TYPES-SECTION-END
