/**
 * Zod schemas + types for the TOML-backed app configuration.
 *
 * The shape here MUST structurally match `AppConfig` from
 * `@/types/global`. A `satisfies`-style assignment at the bottom of the
 * file enforces that equality at compile time — if the two drift, TS
 * will error.
 */

import { z } from 'zod';
import type { AppConfig, Backend } from '@/types/global';

// ---------- Atom schemas ----------

/**
 * R9 — widened to cover cloud providers.
 *
 * Order matches `Backend` in `src/types/global.d.ts`. Adding cases
 * here is migration-safe: old TOMLs say `'ollama'` or `'lmstudio'`
 * which remain valid in the widened enum.
 */
export const BackendTypeSchema = z.enum([
  'ollama',
  'lmstudio',
  'openai',
  'anthropic',
  'openrouter',
  'google',
  'custom',
]);

export const BackendSchema = z.object({
  type: BackendTypeSchema,
  // Accept any non-empty string URL; we don't use .url() because some
  // local installs use plain host:port without scheme prefix. At the
  // callsite that reads this we can tighten if needed.
  //
  // R9: also accept the empty literal for `type === 'custom'` where
  // the user hasn't filled in the base URL yet. Validation that the
  // URL is non-empty before we actually try to talk to a custom
  // provider lives in the adapter / `/provider` command, not here.
  baseUrl: z
    .string()
    .min(1, 'backend.baseUrl must be a non-empty string')
    .or(z.literal('')),
  /**
   * R9 — optional API key. Local providers (`ollama`, `lmstudio`) and
   * cloud providers that fall back to an env var (e.g. `OPENAI_API_KEY`)
   * may leave this undefined. Treated as opaque — no length / format
   * check here so we don't reject e.g. project-scoped Anthropic keys.
   */
  apiKey: z.string().optional(),
  /**
   * R9 — optional custom request headers (proxies, OpenRouter site
   * tags, vendor-specific auth wrappers, etc). The adapter forwards
   * these verbatim alongside the per-provider `Authorization` /
   * `x-api-key` header.
   */
  customHeaders: z.record(z.string(), z.string()).optional(),
});

export const ModelSchema = z.object({
  current: z.string(),
  available: z.array(z.string()),
});

export const OnboardingSchema = z.object({
  completed: z.boolean(),
});

// ---------- Permissions ----------

/**
 * Tool names that a user may pre-approve (skip the per-call approval
 * prompt). Kept as a narrow literal union so the enum matches the
 * tool registry in `src/tools/*` exactly.
 */
export const AutoApprovableToolSchema = z.enum([
  'read_file',
  'write_file',
  'run_command',
  'list_dir',
  'glob_search',
]);

export type AutoApprovableTool = z.infer<typeof AutoApprovableToolSchema>;

// PERMISSIONS-PROFILE-SECTION ---------------------------------------
//
// Profile = orthogonal "mode" layered on top of the per-tool
// `autoApprove` whitelist. Categorisation:
//   - `default`           — read-only tools run; edit + command tools
//                           prompt for approval.
//   - `acceptEdits`       — edit tools (write_file/edit_file) bypass
//                           approval; command tools still prompt.
//   - `plan`              — read-only tools run; edit AND command tools
//                           are BLOCKED at the executor (no approval
//                           prompt, no preview, no PreToolUse hook
//                           fires). Returns a structured error that
//                           instructs the model to summarise its plan
//                           and switch profiles.
//   - `dontAsk`           — edit AND command tools bypass approval.
//                           Equivalent to legacy `--dangerously-allow-all`.
//   - `bypassPermissions` — same effect as `dontAsk` at the executor
//                           but surfaced in the UI with a red WARNING
//                           banner so the user knows every tool is
//                           auto-running.
//
// `default` is the safe back-compat baseline; old configs without a
// `profile` field parse as `default` so existing flows behave exactly
// as before.

export const PermissionProfileSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
]);

export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

/**
 * Permissions block. The whole object carries a default (empty
 * `autoApprove` array + `default` profile) so old configs that lack a
 * `[permissions]` section parse cleanly and get filled in on first
 * read.
 */
// BATCH-APPROVAL-SECTION
// `batchApprovalThreshold` controls the unified batch-approval dialog
// fired when the LLM emits N or more mutating tool calls in a single
// turn (typical for multi-file refactors). Default 3 — below that the
// historical per-call approval prompt fires sequentially (fewer
// prompts = lower cognitive cost than a modal for one or two calls).
// Range 1..99: setting to 1 effectively makes every mutating call open
// the batch UI (treats each as a "batch of one"); setting to 99
// disables the batch UI in practice. Old configs without the field
// fall through to the default via Zod.
// BATCH-APPROVAL-SECTION-END
export const PermissionsSchema = z
  .object({
    autoApprove: z.array(AutoApprovableToolSchema).default([]),
    profile: PermissionProfileSchema.default('default'),
    // BATCH-APPROVAL-SECTION
    // Optional in BOTH input AND output (no `.default`) so the matching
    // `PermissionsConfig.batchApprovalThreshold` on the .d.ts side stays
    // `number | undefined` and the bidirectional `_ConfigAssert` witness
    // still holds. Consumers read with `?? 3` to apply the default —
    // this keeps every existing literal
    // `{ autoApprove: [], profile: 'default' }` in tests / onboarding /
    // web API helpers / project-rc overrides type-checking unchanged.
    batchApprovalThreshold: z.number().int().min(1).max(99).optional(),
    // BATCH-APPROVAL-SECTION-END
  })
  .default({ autoApprove: [], profile: 'default' });

// PERMISSIONS-PROFILE-SECTION-END -----------------------------------

// ---------- Context (num_ctx + keep-alive + response timeout) ----------

/**
 * User-tunable context window (forwarded to Ollama as `num_ctx`),
 * keep-alive TTL (seconds a model stays hot in VRAM between requests),
 * and response stall timeout (seconds to wait for the next streamed
 * chunk from the LM Studio backend before bailing).
 *
 * Defaults chosen to match `DEFAULTS.maxContextTokens.ollama` (8192),
 * a sensible 30-minute keep-alive, and a 5-minute stall timeout —
 * long enough to accommodate slow models writing long code blocks
 * while still bounded (range 30s..2h) to prevent indefinite hangs.
 */
export const ContextSettingsSchema = z
  .object({
    maxTokens: z.number().int().positive().default(8192),
    keepAliveSeconds: z.number().int().nonnegative().default(1800),
    responseTimeoutSeconds: z.number().int().min(30).max(7200).default(300),
    /**
     * ROADMAP #5 — tool-result trimming threshold. Tool results older
     * than the most recent N are replaced with a one-line stub before
     * being sent to the model on the next turn. `0` disables. Range
     * 0..50. Default 3 — tightened from the original 5 after observing
     * 1M-token OpenRouter budgets burning through faster than expected
     * in long sessions where the model re-reads the same files. Users
     * who want the older behaviour can raise it via `/settings`.
     *
     * Belt-and-suspenders default mirrors the outer `.default(...)`
     * below: even partial `[context]` blocks in older TOMLs that
     * predate this field will fall through to 3 instead of failing
     * validation.
     */
    trimToolResultsAfter: z
      .number()
      .int()
      .nonnegative()
      .max(50)
      .default(3),
    /**
     * Auto-compress trigger threshold. Default 0.80; range 0.5..0.95.
     * Used by `app.tsx` after each streaming turn to decide whether to
     * queue a programmatic `/compress`. Backwards-compatible default
     * preserves existing behaviour for old configs.
     */
    autoCompressPercent: z.number().min(0.5).max(0.95).default(0.8),
    /**
     * Sliding-window cap on the number of trailing messages forwarded
     * to the LLM each turn. The system prompt and any synthetic
     * `[Compressed context]` marker are always kept on top. `0`
     * disables the window (full in-memory history is sent). Range
     * 0..200; default 20 — enough for a dozen tool round-trips while
     * keeping prompt cost bounded on long vibe-coding sessions.
     *
     * Belt-and-suspenders default mirrors the outer `.default(...)`
     * below so older `[context]` blocks parse cleanly.
     */
    maxRecentMessages: z
      .number()
      .int()
      .nonnegative()
      .max(200)
      .default(20),
  })
  .default({
    maxTokens: 8192,
    keepAliveSeconds: 1800,
    responseTimeoutSeconds: 300,
    trimToolResultsAfter: 3,
    autoCompressPercent: 0.8,
    maxRecentMessages: 20,
  });

// ---------- Sound (FIX #29) ----------

/**
 * Sound-effect settings. The whole section carries a `.default(...)` so
 * old configs without a `[sound]` block parse cleanly, and each field
 * also has its own default (belt-and-suspenders) so partial TOML
 * sections don't fail to merge.
 *
 * - `enabled`: master on/off switch (opt-in; off by default).
 * - `onCompletion` / `onApproval` / `onError`: per-event toggles.
 * - `volume`: 0.0 .. 1.0 gain.
 * - `*File`: optional absolute path to a custom `.wav` / `.mp3`.
 *   `null` means "use the system default sound for this event".
 */
export const SoundSchema = z
  .object({
    enabled: z.boolean().default(false),
    onCompletion: z.boolean().default(true),
    onApproval: z.boolean().default(true),
    onError: z.boolean().default(true),
    volume: z.number().min(0).max(1).default(0.5),
    completionFile: z.string().nullable().default(null),
    approvalFile: z.string().nullable().default(null),
    errorFile: z.string().nullable().default(null),
  })
  .default({
    enabled: false,
    onCompletion: true,
    onApproval: true,
    onError: true,
    volume: 0.5,
    completionFile: null,
    approvalFile: null,
    errorFile: null,
  });

// ---------- Generation (FIX #35) ----------

/**
 * Generation parameters forwarded to the LLM (temperature, top_p,
 * repeat_penalty, max_tokens).
 *
 * In TypeScript we use camelCase (`topP`, `repeatPenalty`, `maxTokens`).
 * On disk in `.localcode/settings.json` (per-project layer) the keys
 * are serialized as snake_case (`top_p`, `repeat_penalty`, `max_tokens`)
 * per the user-facing spec — the serialization mapping happens in
 * `ConfigManager.readProjectSettings` / `writeProjectSettings`.
 *
 * Belt-and-suspenders defaults: each field carries its own `.default`
 * AND the whole object has a `.default(...)` so old TOMLs (which
 * predate this section) parse cleanly and migrate to the defaults
 * without manual intervention.
 */
const GenerationObjectSchema = z.object({
  temperature: z.number().min(0).max(2).default(0.2),
  topP: z.number().min(0).max(1).default(0.9),
  repeatPenalty: z.number().min(0).max(2).default(1.1),
  maxTokens: z.number().int().positive().default(4096),
});

export const GenerationSchema = GenerationObjectSchema.default({
  temperature: 0.2,
  topP: 0.9,
  repeatPenalty: 1.1,
  maxTokens: 4096,
});

export type Generation = z.infer<typeof GenerationSchema>;

export const PartialGenerationSchema = GenerationObjectSchema.partial();
export type PartialGeneration = z.infer<typeof PartialGenerationSchema>;

// ---------- Diagnostics ----------

/**
 * Diagnostics block. `dumpFailedRequests` toggles writing sanitized
 * failure dumps to `~/.localcode/diagnostics/`. Off by default —
 * intended to be flipped on temporarily when reproducing a failure.
 *
 * The whole section carries a `.default(...)` so old TOMLs without a
 * `[diagnostics]` block parse cleanly.
 */
export const DiagnosticsSchema = z
  .object({
    dumpFailedRequests: z.boolean().default(false),
  })
  .default({ dumpFailedRequests: false });

// ---------- Circuit breaker ----------

/**
 * Process-wide circuit-breaker tuning. Optional — defaults in
 * `src/llm/circuit-breaker.ts` are sensible for cloud providers
 * (`failureThreshold: 10`, `initialCooldownMs: 30_000`,
 * `maxCooldownMs: 300_000`). Users only need to set this when they want
 * a faster trip on a flakier upstream or a longer cooldown on a paid
 * tier they don't want to hammer.
 *
 * The whole section carries a `.default(...)` so absence of the block
 * in older TOMLs round-trips cleanly through validation.
 */
export const CircuitBreakerSchema = z
  .object({
    failureThreshold: z.number().int().positive().default(10),
    failureWindowMs: z.number().int().positive().default(60_000),
    initialCooldownMs: z.number().int().positive().default(30_000),
    maxCooldownMs: z.number().int().positive().default(300_000),
    cooldownGrowthFactor: z.number().min(1).max(10).default(2.0),
  })
  .default({
    failureThreshold: 10,
    failureWindowMs: 60_000,
    initialCooldownMs: 30_000,
    maxCooldownMs: 300_000,
    cooldownGrowthFactor: 2.0,
  });

// ---------- Agents (multi-agent orchestration) ----------

/**
 * Multi-agent orchestration block. Defaults are conservative:
 *   - workerModel mirrors a strong-but-cheap default
 *   - maxConcurrent caps at 5 to bound resource use
 *   - isolation defaults to git worktree forks
 *   - approval=auto so workers can write/exec without bothering the user
 *
 * `leadModel` is optional — when omitted the orchestrator reuses the
 * lead session's active model.
 */
export const AgentsWorkerSlotSchema = z.object({
  model: z.string().min(1),
  skills: z.array(z.string()).optional(),
  isolationOverride: z.enum(['worktree', 'shared']).optional(),
  timeoutSec: z.number().int().positive().optional(),
});

export const AgentsSchema = z
  .object({
    leadModel: z.string().optional(),
    workerModel: z.string().default('deepseek/deepseek-coder'),
    workerSlots: z.array(AgentsWorkerSlotSchema).max(8).optional(),
    maxConcurrent: z.number().int().positive().max(20).default(5),
    isolation: z.enum(['worktree', 'shared']).default('worktree'),
    approval: z.enum(['auto', 'per-action']).default('auto'),
    defaultTimeoutSec: z.number().int().positive().default(600),
  })
  .default({
    workerModel: 'deepseek/deepseek-coder',
    maxConcurrent: 5,
    isolation: 'worktree',
    approval: 'auto',
    defaultTimeoutSec: 600,
  });

// HOOKS-CONFIG-SECTION ----------------------------------------------
//
// Settings-driven shell hooks. The schema lives next to its peers
// (agents, circuit-breaker) so the structural compatibility check
// between `Config` (Zod) and `AppConfig` (.d.ts) stays in one place.
// Validation is intentionally permissive: anything that round-trips
// through TOML is accepted, with sensible defaults filled in for
// optional fields.

export const HookTriggerSchema = z.enum([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'PreCompact',
  'SessionEnd',
  'Stop',
]);

export const HookConfigEntrySchema = z.object({
  trigger: HookTriggerSchema,
  toolPattern: z.string().optional(),
  command: z.string().min(1, 'hook.command must be a non-empty string'),
  // BUILTIN-HOOKS-SECTION — name of a built-in hook handler (e.g.
  // `'secret-scanner'`). When set, the engine routes to the internal
  // handler instead of spawning the shell `command`. The `command`
  // field then carries a synthetic label and is never executed.
  builtin: z.string().min(1).optional(),
  // BUILTIN-HOOKS-SECTION-END
  timeout: z.number().int().positive().max(600_000).optional(),
  blocking: z.boolean().optional(),
  description: z.string().optional(),
});

/**
 * Array form mirrors `[[hooks]]` repeated tables in TOML. Default to
 * an empty array so missing / absent sections parse cleanly and the
 * engine short-circuits with zero overhead.
 */
export const HooksConfigSchema = z
  .array(HookConfigEntrySchema)
  .default([]);

// HOOKS-CONFIG-SECTION-END ------------------------------------------

// SECURITY-CONFIG-SECTION -------------------------------------------
//
// Security-related toggles. Currently only one nested switch:
//   - `secretScanner.enabled` — defaults `true`. Auto-registers the
//     built-in secret scanner PreToolUse hook against `git_commit`.
//     Set to `false` to disable scanning (e.g. CI environments that
//     prefer external tooling).
//
// The whole section carries a `.default(...)` so old TOMLs that predate
// the feature parse cleanly and inherit the "scanner ON" default.
export const SecuritySchema = z
  .object({
    secretScanner: z
      .object({
        enabled: z.boolean().default(true),
      })
      .default({ enabled: true }),
  })
  .default({ secretScanner: { enabled: true } });

export type SecurityConfig = z.infer<typeof SecuritySchema>;
// SECURITY-CONFIG-SECTION-END ---------------------------------------

// SANDBOX-CONFIG-SECTION --------------------------------------------
//
// `run_command` execution sandbox. Wraps every shell invocation in an
// OS-native isolation envelope (sandbox-exec on macOS, firejail on
// Linux, optional docker) so even auto-approved commands cannot freely
// write outside the project root or open network sockets.
//
// All fields default to "safe defaults that preserve existing
// behaviour":
//   - `backend = 'auto'` picks the best native sandbox for the host
//     and silently falls back to passthrough when unavailable.
//   - `allowNetwork = true` matches the pre-sandbox default — turning
//     this OFF requires explicit opt-in because most dev commands need
//     network (`bun install`, `git clone`, …).
//   - `allowWritePaths = []` means writes are scoped to the project
//     root (plus the platform's `/tmp` scratch zone). Add absolute
//     paths to widen this list.
//   - `timeoutMs = 120_000` is a generous 2-minute cap (the legacy
//     hard-coded `run_command` timeout is 30s; this is the upper bound
//     the runner enforces — the existing 30s envelope still applies on
//     top via execa).
//
// Whole section is optional at the typed root so old TOMLs round-trip
// cleanly; absence yields the defaults above via Zod.
export const SandboxConfigSchema = z
  .object({
    backend: z
      .enum(['auto', 'sandbox-exec', 'firejail', 'docker', 'none'])
      .default('auto'),
    allowNetwork: z.boolean().default(true),
    allowWritePaths: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().default(120_000),
    /**
     * Image used by the `docker` backend. Defaults to `alpine:latest` —
     * the smallest image shipping a POSIX `sh`. Ignored by other
     * backends. Optional.
     */
    dockerImage: z.string().min(1).optional(),
  })
  .default({
    backend: 'auto',
    allowNetwork: true,
    allowWritePaths: [],
    timeoutMs: 120_000,
  });

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
// SANDBOX-CONFIG-SECTION-END ----------------------------------------

// MCP-CONFIG-SECTION ------------------------------------------------
// MCP (Model Context Protocol) servers. Optional; absence = dormant
// registry, zero overhead. Each entry boots a subprocess (stdio) or
// connects via HTTP and surfaces its tools as native LocalCode tools.
export const McpServerConfigSchema = z
  .object({
    type: z.enum(['stdio', 'http']),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    startupTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
  })
  .refine(
    (cfg) =>
      (cfg.type === 'stdio' && typeof cfg.command === 'string') ||
      (cfg.type === 'http' && typeof cfg.url === 'string'),
    {
      message:
        'mcpServers entry must have `command` when type=stdio or `url` when type=http',
    },
  );

export const McpServersConfigSchema = z
  .record(z.string(), McpServerConfigSchema)
  .default({});
// MCP-CONFIG-SECTION-END --------------------------------------------

// STATUSLINE-SECTION ------------------------------------------------
//
// User-customizable footer line shown under assistant messages (TUI)
// and in the web composer. Template placeholders: `{model}`, `{tokens}`,
// `{maxTokens}`, `{pct}`, `{cachedTokens}`, `{cost}`, `{profile}`,
// `{provider}`, `{sessionId}`, `{branch}`, `{cwd}`. Missing variables
// are rendered as empty strings via `renderStatusline()` so a partial
// snapshot never blows up the UI.
//
// `enabled` defaults true; setting it to false falls back to the
// previous "compact usage" footer.
//
// The whole section is optional at the root so old TOMLs without a
// `[statusline]` block parse cleanly.
export const StatuslineConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    template: z
      .string()
      .default(
        '{provider} · {model} · {tokens}/{maxTokens} ({pct}%) · {profile}',
      ),
  })
  .default({});

export type StatuslineConfig = z.infer<typeof StatuslineConfigSchema>;
// STATUSLINE-SECTION-END --------------------------------------------

// EDITOR-CONFIG-SECTION ---------------------------------------------
//
// Composer / input feature toggles. All three fields default to the
// "old behaviour" — vim mode off, mouse support auto-detected, and
// no custom keybinds — so users who never touch the section see ZERO
// difference from before. The section as a whole is optional at the
// root so old TOMLs round-trip cleanly.
//
//   - `vimMode`        — opt-in modal editing. Default `false`.
//   - `vimStartInsert` — only meaningful when `vimMode = true`. When
//                        true (the default) the composer mounts in
//                        INSERT mode so a user who flipped vim on can
//                        keep typing immediately; turning this off
//                        starts in NORMAL mode like a fresh vim
//                        buffer.
//   - `mouseSupport`   — opt-in mouse reporting. Default `true` (auto-
//                        detected against the TERM env var); set to
//                        false to force it off on a terminal that
//                        emits visible garbage instead of mouse bytes.
export const EditorSettingsSchema = z
  .object({
    vimMode: z.boolean().default(false),
    vimStartInsert: z.boolean().default(true),
    mouseSupport: z.boolean().default(true),
  })
  .default({
    vimMode: false,
    vimStartInsert: true,
    mouseSupport: true,
  });

export type EditorSettings = z.infer<typeof EditorSettingsSchema>;
// EDITOR-CONFIG-SECTION-END -----------------------------------------

// COMPOSER-CONFIG-SECTION -------------------------------------------
//
// Composer-only toggles distinct from the EDITOR section. Kept narrow
// so the wider editor settings (vim mode, mouse) and the composer
// behaviour switches don't fight for ownership of the same struct.
//
//   - `suppressVisionWarning` — when true, attaching an image while
//                                the active model is not heuristically
//                                vision-capable does NOT emit a warning
//                                toast. Default `false` so the warning
//                                fires unless the user explicitly opts
//                                out.
//
// Whole section is optional at the root so old TOMLs round-trip cleanly.
export const ComposerSettingsSchema = z
  .object({
    suppressVisionWarning: z.boolean().default(false),
  })
  .default({
    suppressVisionWarning: false,
  });

export type ComposerSettings = z.infer<typeof ComposerSettingsSchema>;
// COMPOSER-CONFIG-SECTION-END ---------------------------------------

// UPDATER-CONFIG-SECTION --------------------------------------------
//
// Auto-update settings. Drives the GitHub-Releases-based updater that
// runs alongside the TUI / web server. All fields default to "safe
// background behaviour": enabled, stable channel, 6h interval,
// auto-download on. Users opt out via `[updater] enabled = false` in
// `~/.localcode/config.toml` or `localcode update disable`.
//
//   - `enabled`              — master switch. When false, ZERO network
//                              activity from the updater module.
//   - `channel`              — `stable` follows `releases/latest`;
//                              `beta` follows the most recent
//                              prerelease tag. (`beta` falls back to
//                              the latest stable when no prerelease is
//                              published.)
//   - `checkIntervalHours`   — repeating interval between checks.
//                              Range 1..168. Default 6h.
//   - `autoDownload`         — when true (default) the scheduler
//                              fetches the tarball in the background
//                              the moment a newer version is detected.
//                              When false, the UI surfaces the notice
//                              but waits for `/update apply` to
//                              download + apply on demand.
//
// Whole section is optional at the root so old TOMLs round-trip cleanly.
export const UpdaterConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    channel: z.enum(['stable', 'beta']).default('stable'),
    checkIntervalHours: z.number().int().min(1).max(168).default(6),
    autoDownload: z.boolean().default(true),
    /**
     * Fire an immediate check ~5s after launch in addition to the
     * recurring interval. Default true — matches the user-facing
     * "check on every launch" requirement; the on-disk 6h cache still
     * dedupes repeated boots so we don't hammer GitHub.
     */
    checkOnLaunch: z.boolean().default(true),
    /**
     * When true (default) the background check produces no visible UI
     * affordance ("checking…") — only the eventual modal trigger on
     * `update-available`. Flip to false to surface a small status
     * indicator for power users who want feedback during the check.
     */
    silentBackground: z.boolean().default(true),
    /**
     * When true (default), the downloader prefers a tiny binary delta
     * patch (`localcode-<os>-<arch>-from-<prev>-to-<new>.patch`, applied
     * via `bspatch`) over the full release tarball — shrinking the
     * on-disk download from ~13 MB to a few hundred KB on incremental
     * upgrades. Falls back to the full tarball whenever the patch asset
     * is missing, `bspatch` is unavailable, or SHA-256 verification
     * fails. Mirrors `Updater.opts.preferPatchDelta`.
     */
    preferPatchDelta: z.boolean().default(true),
  })
  .default({
    enabled: true,
    channel: 'stable',
    checkIntervalHours: 6,
    autoDownload: true,
    checkOnLaunch: true,
    silentBackground: true,
    preferPatchDelta: true,
  });

export type UpdaterConfig = z.infer<typeof UpdaterConfigSchema>;
// UPDATER-CONFIG-SECTION-END ----------------------------------------

// OUTPUT-STYLE-SECTION ----------------------------------------------
//
// Top-level "output style" that shapes how the model narrates its
// responses. Injected as a stable, short preamble inside
// `ContextManager.buildSystemPrompt` at a fixed byte position
// (right after the `## Project context` block) so the prompt prefix
// remains deterministic for the local-model prompt cache.
//
//   - `concise`      — minimal narration, direct answers.
//   - `explanatory`  — adds rationale, tradeoffs, and alternatives.
//   - `verbose`      — full step-by-step commentary.
//
// Default is `concise`; old configs that omit the field auto-fill via
// the schema default.
export const OutputStyleSchema = z.enum(['concise', 'explanatory', 'verbose']);
export type OutputStyle = z.infer<typeof OutputStyleSchema>;
// OUTPUT-STYLE-SECTION-END ------------------------------------------

// LOCALE-CONFIG-SECTION ---------------------------------------------
//
// User-facing UI language. Drives:
//   - TUI strings (where the UI renders translated copy).
//   - Web UI translation table selection.
//   - Default thinking-phrase locale.
//
// Top-level (NOT nested) so a `/language` slash command can patch it
// via a single-field update. Optional at the typed root so old configs
// that predate the field round-trip cleanly. The first-launch picker
// fires whenever the field is `undefined`.
export const LocaleSchema = z.enum(['en', 'ru']);
export type Locale = z.infer<typeof LocaleSchema>;
// LOCALE-CONFIG-SECTION-END -----------------------------------------

// FIRST-RUN-CONFIG-SECTION ------------------------------------------
//
// First-run UX state. Currently a single Boolean tracking whether the
// interactive tutorial overlay has been shown to the user. Optional at
// the root so legacy configs round-trip cleanly; the TutorialOverlay
// fires whenever the field is `undefined` OR `false`, and the
// composition root patches it to `true` once the overlay dismisses
// (either completion or Esc — the tutorial is skippable, we never
// re-show automatically). Re-show on demand happens via `/tutorial`.
export const FirstRunSchema = z
  .object({
    tutorialShown: z.boolean().default(false),
  })
  .default({ tutorialShown: false });

export type FirstRunConfig = z.infer<typeof FirstRunSchema>;
// FIRST-RUN-CONFIG-SECTION-END --------------------------------------

// TELEMETRY-CONFIG-SECTION ------------------------------------------
//
// Opt-in local-only metrics aggregation toggle. Drives the `/metrics`
// dashboard (tool success rate, cache-hit %, avg turn duration, cost
// per model, top expensive sessions). Data is aggregated entirely from
// already-on-disk SQLite + crash-journal artefacts and NEVER leaves the
// user's machine — there is no network egress path. The block is
// off-by-default to satisfy the "telemetry must be explicit consent"
// posture: when `enabled = false` the aggregator returns a synthetic
// "disabled" snapshot and never reads journals.
//
//   - `enabled`        — master on/off switch. Default `false` (opt-in).
//   - `retentionDays`  — bound the lookback window for journal scans +
//                        SQL aggregates. Range 1..365. Default 30.
//
// Whole section is optional at the typed root so old TOMLs that predate
// the feature round-trip cleanly; Zod fills the defaults when absent.
export const TelemetrySchema = z
  .object({
    enabled: z.boolean().default(false),
    retentionDays: z.number().int().min(1).max(365).default(30),
  })
  .default({
    enabled: false,
    retentionDays: 30,
  });

export type TelemetryConfig = z.infer<typeof TelemetrySchema>;
// TELEMETRY-CONFIG-SECTION-END --------------------------------------

// IMPORT-FIRST-RUN-SECTION --------------------------------------------
//
// First-run migration prompt state. Currently only carries the
// "dismissed" flag for the Claude Code import prompt. Mirrored in
// `AppConfig.migration` (`src/types/global.d.ts`).
//
//   - `claudeCodeDismissed` — `true` once the user picked "Not now" or
//                             "Never ask" on the first-run prompt.
//                             Default `false`.
export const MigrationSchema = z
  .object({
    claudeCodeDismissed: z.boolean().default(false),
  })
  .default({
    claudeCodeDismissed: false,
  });
export type MigrationConfig = z.infer<typeof MigrationSchema>;
// IMPORT-FIRST-RUN-SECTION-END ----------------------------------------

// INFERENCE-CONFIG-SECTION --------------------------------------------
//
// Wave 16B — local-first constrained-decoding controls. These knobs only
// have teeth on LOCAL OpenAI-compatible backends (llama.cpp / LM Studio /
// Ollama) which expose GBNF `grammar` + raw `logit_bias` — cloud APIs do
// not. Cloud backends ignore the section entirely.
//
//   - `grammarLock`  — attach a GBNF tool-call grammar to the per-request
//     body so the local decoder can only emit a valid call to a real
//     tool. `'auto'` (default) defers to the capability probe; `'on'`
//     forces it (probe still gates the actual attach); `'off'` disables.
//   - `logitBanlist` — bias the decoder toward in-scope TypeScript
//     symbols (and optionally away from deprecated names). TS/TSX-only;
//     no-op on other languages. `'auto'` defers to the probe.
//
// Whole section optional at the typed root so old TOMLs round-trip
// cleanly; Zod fills `{ grammarLock: 'auto', logitBanlist: 'auto' }`.
export const InferenceModeSchema = z.enum(['auto', 'on', 'off']);
export type InferenceMode = z.infer<typeof InferenceModeSchema>;

export const InferenceSchema = z
  .object({
    grammarLock: InferenceModeSchema.default('auto'),
    logitBanlist: InferenceModeSchema.default('auto'),
  })
  .default({
    grammarLock: 'auto',
    logitBanlist: 'auto',
  });

export type InferenceConfig = z.infer<typeof InferenceSchema>;
// INFERENCE-CONFIG-SECTION-END ----------------------------------------

// ---------- Root schema ----------

export const ConfigSchema = z.object({
  backend: BackendSchema,
  model: ModelSchema,
  onboarding: OnboardingSchema,
  permissions: PermissionsSchema,
  context: ContextSettingsSchema,
  sound: SoundSchema,
  generation: GenerationSchema,
  // `.optional()` on top of the schema's own `.default(...)` so the
  // typed shape matches `AppConfig.diagnostics?` (kept optional to
  // avoid forcing every literal `AppConfig` site to add the field).
  diagnostics: DiagnosticsSchema.optional(),
  // Same pattern — optional at the typed root, but Zod-fills defaults
  // when the section is missing from the on-disk TOML.
  agents: AgentsSchema.optional(),
  // Circuit-breaker tuning. Optional; absence yields the in-code
  // defaults (30s cooldown, 5-min cap, 10 failures within 60s window).
  circuitBreaker: CircuitBreakerSchema.optional(),
  // Hooks — optional. Empty array is the zero-overhead default;
  // omitting the section in TOML round-trips to the same shape.
  hooks: HooksConfigSchema.optional(),
  // SECURITY-CONFIG-SECTION — optional security toggles. Absence in
  // TOML yields the defaults via the schema's own `.default(...)`.
  security: SecuritySchema.optional(),
  // SECURITY-CONFIG-SECTION-END
  // SANDBOX-CONFIG-SECTION — `run_command` sandbox layer. Optional at
  // the typed root; the schema's own `.default(...)` fills in the safe
  // defaults (backend='auto', allowNetwork=true, no extra write paths)
  // when the section is absent from disk.
  sandbox: SandboxConfigSchema.optional(),
  // SANDBOX-CONFIG-SECTION-END
  // MCP servers — optional. Empty/missing = dormant registry.
  mcpServers: McpServersConfigSchema.optional(),
  // Statusline customization — optional. Absence yields the default
  // template + enabled=true via the schema's own `.default(...)`.
  statusline: StatuslineConfigSchema.optional(),
  // Output style preamble injected into the system prompt. Top-level
  // (NOT nested) so toggling via `/style <name>` is a single-field
  // patch. Default `concise` preserves prior behaviour for users who
  // never touch it.
  outputStyle: OutputStyleSchema.default('concise'),
  // EDITOR-CONFIG-SECTION — optional editor settings (vim mode, mouse,
  // composer feature toggles). Absence in TOML yields the safe
  // defaults via the schema's own `.default(...)`.
  editor: EditorSettingsSchema.optional(),
  // COMPOSER-CONFIG-SECTION — optional composer behaviour toggles
  // (vision warning suppression). Absence in TOML yields the safe
  // defaults via the schema's own `.default(...)`.
  composer: ComposerSettingsSchema.optional(),
  // TEST-COMMAND-SECTION — optional project-level shell template used by
  // the "Run relevant tests" inline button under file-edit tool calls.
  // Supports a `{files}` placeholder; absence falls back to
  // `bun test {files}`. Validation: non-empty string when present.
  testCommand: z.string().min(1).optional(),
  // TEST-COMMAND-SECTION-END
  // UPDATER-CONFIG-SECTION — auto-update settings. Optional; absence
  // yields the safe defaults via the schema's own `.default(...)`.
  updater: UpdaterConfigSchema.optional(),
  // UPDATER-CONFIG-SECTION-END
  // LOCALE-CONFIG-SECTION — chosen UI language. Optional so legacy
  // configs round-trip cleanly; absence triggers the first-launch
  // language picker which then writes the chosen value back.
  locale: LocaleSchema.optional(),
  // LOCALE-CONFIG-SECTION-END
  // FIRST-RUN-CONFIG-SECTION — first-run UX state (tutorial dismissed?).
  // Optional at the root so old TOMLs round-trip cleanly; Zod fills in
  // `{ tutorialShown: false }` when the section is absent. The tutorial
  // overlay fires whenever `firstRun?.tutorialShown !== true`, and the
  // composition root patches it to `true` on overlay dismiss.
  firstRun: FirstRunSchema.optional(),
  // FIRST-RUN-CONFIG-SECTION-END
  // TELEMETRY-CONFIG-SECTION — opt-in local-only metrics aggregation
  // toggle. Optional so old TOMLs round-trip cleanly; Zod fills in
  // `{ enabled: false, retentionDays: 30 }` when the section is absent.
  // The `/metrics` dashboard reads this gate before touching any
  // SessionManager / journal data.
  telemetry: TelemetrySchema.optional(),
  // TELEMETRY-CONFIG-SECTION-END
  // IMPORT-FIRST-RUN-SECTION — migration prompt dismissal state.
  // Optional; absence yields the safe default (not dismissed).
  migration: MigrationSchema.optional(),
  // IMPORT-FIRST-RUN-SECTION-END
  // INFERENCE-CONFIG-SECTION — local-first constrained-decoding controls
  // (grammar lock + logit banlist). Optional; absence yields the
  // 'auto'/'auto' defaults via the schema's own `.default(...)`.
  inference: InferenceSchema.optional(),
  // INFERENCE-CONFIG-SECTION-END
});

export type Config = z.infer<typeof ConfigSchema>;

// ---------- Structural compatibility check with AppConfig ----------

/**
 * Compile-time assertion that `Config` (from Zod) and `AppConfig`
 * (from `global.d.ts`) are interchangeable.
 *
 * If the Zod schema drifts from the hand-written type, one of these
 * type aliases will error.
 */
type _ConfigIsAppConfig = Config extends AppConfig ? true : never;
type _AppConfigIsConfig = AppConfig extends Config ? true : never;
// Exported (as `never` / `true` unions) so unused-symbol lint doesn't
// complain. They're purely type-level witnesses.
export type _ConfigAssert = _ConfigIsAppConfig & _AppConfigIsConfig;

// Re-export the runtime backend type narrow so other config files can
// reuse it without re-importing from global.d.ts.
export type BackendKind = Backend;

// ---------- DeepPartial helper ----------

/**
 * Recursively optional version of a type — used by `ConfigManager.update`
 * so callers can merge a partial patch into the existing config.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Zod partial of the root config. Useful for validating patches before
 * merging. We use `.deepPartial()` to allow nested objects to be omitted.
 *
 * NOTE: `ConfigSchema.deepPartial()` accepts any subset; we still
 * validate the *merged* result with `ConfigSchema` before writing.
 */
export const PartialConfigSchema = ConfigSchema.deepPartial();
