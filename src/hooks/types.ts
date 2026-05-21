/**
 * Hook engine types.
 *
 * Hooks let users wire shell commands into LocalCode at seven trigger
 * points so the harness (not the model) enforces side-effects:
 *
 *   - `PreToolUse`        — before a tool call's handler runs.
 *   - `PostToolUse`       — after a tool result is produced.
 *   - `UserPromptSubmit`  — when the user submits a chat message.
 *   - `SessionStart`      — once at session boot.
 *   - `PreCompact`        — before auto-compress collapses history. A
 *                           blocking exit aborts the compress without
 *                           consuming the cooldown stamp.
 *   - `SessionEnd`        — when a session ends. Reason carries the
 *                           cause (`user_quit` / `session_switch` /
 *                           `shutdown` / `evicted`). Fire-and-forget —
 *                           blocking exits cannot keep the session alive.
 *   - `Stop`              — after the LAST assistant turn (plain-text
 *                           branch, no pending tool calls). Carries the
 *                           usage snapshot for the just-finished turn.
 *
 * Hooks are user-authored: the matched commands run through `sh -c`
 * with `${TOOL_ARG_xxx}` placeholders shell-escaped. A blocking hook
 * that exits non-zero rejects the action; non-blocking hooks
 * fire-and-forget.
 */
export type HookTrigger =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'PreCompact'
  | 'SessionEnd'
  | 'Stop';

/**
 * Reason a `SessionEnd` was fired. Mirrors the user-visible cause:
 *
 *   - `user_quit`      — `/quit`, `/exit`, Ctrl+C confirmed, SIGINT,
 *                        SIGTERM, SIGHUP.
 *   - `session_switch` — `/clear` (new blank session) or `/resume`
 *                        (load a different session).
 *   - `shutdown`       — top-level shutdown (e.g. web server tearing
 *                        down before sockets close).
 *   - `evicted`        — LRU eviction in the web runtime pool. NOT a
 *                        user-initiated end; the session row stays in
 *                        SQLite and reopens transparently on the next
 *                        `subscribe_session` frame.
 */
export type HookSessionEndReason =
  | 'user_quit'
  | 'session_switch'
  | 'shutdown'
  | 'evicted';

/**
 * Minimal usage snapshot exposed to `Stop` hooks. Intentionally NOT
 * imported from `@/llm/streaming` (`StreamUsage`) so the hooks module
 * stays free of LLM-layer dependencies — the wider type carries fields
 * we don't expose at this boundary. Wire-up sites populate as much as
 * the adapter reported.
 */
export interface HookUsageSnapshot {
  /** Prompt-side tokens this turn billed (input). */
  promptTokens?: number;
  /** Completion-side tokens this turn billed (output). */
  completionTokens?: number;
  /** Cached prompt tokens reported by the upstream (provider-specific). */
  cachedInputTokens?: number;
}

/**
 * A single configured hook.
 *
 * Fields mirror the TOML shape one-to-one. `toolPattern` is optional:
 * when omitted the hook fires on every tool call for the given trigger.
 * `timeout` defaults to 10s; the engine enforces it via the subprocess
 * abort signal.
 */
export interface HookConfig {
  /** Which trigger point this hook listens on. */
  trigger: HookTrigger;
  /**
   * Optional glob (e.g. `write_file`, `git_*`, `read_*`) matched against
   * the tool name. Only meaningful for tool-triggered hooks; ignored
   * for `UserPromptSubmit` / `SessionStart`.
   */
  toolPattern?: string;
  /**
   * Shell command. `${TOOL_ARG_<name>}` placeholders are replaced with
   * single-quote-escaped values pulled from `toolArgs[name]`. Anything
   * else passes through verbatim and is evaluated by `sh -c`.
   *
   * Always present (even for built-in hooks, where it carries a
   * synthetic label like `"(builtin: secret-scanner)"`) so consumers
   * downstream of `HookOutcome` can keep treating it as a `string`
   * without a non-null check.
   */
  command: string;
  // BUILTIN-HOOKS-SECTION ---------------------------------------------
  /**
   * Name of a built-in hook handler. When set, the engine bypasses
   * shell spawn entirely and dispatches to the corresponding internal
   * implementation. Currently registered builtins:
   *   - `'secret-scanner'` — scan staged git diff for credentials.
   *
   * When `builtin` is set the `command` field carries a synthetic
   * label and is NOT executed through `sh -c`.
   */
  builtin?: 'secret-scanner' | string;
  // BUILTIN-HOOKS-SECTION-END -----------------------------------------
  /** Wall-clock timeout in milliseconds. Defaults to 10_000. */
  timeout?: number;
  /**
   * When `true`, a non-zero exit code blocks the action (rejects the
   * tool call / user prompt). When `false`, the hook is fire-and-forget
   * — its outcome is recorded but never gates anything.
   *
   * Defaults to `false` — hooks should be opt-in blocking.
   */
  blocking?: boolean;
  /** Optional human-readable description shown in the read-only viewer. */
  description?: string;
}

/**
 * Runtime context handed to the hook engine. The engine never mutates
 * it — it's read-only metadata used to filter + expand the command.
 */
export interface HookContext {
  /** Which trigger to fire. The engine filters `HookConfig`s on this. */
  trigger: HookTrigger;
  /** Tool name (for `PreToolUse` / `PostToolUse`). */
  toolName?: string;
  /** Tool arguments dictionary — used for `${TOOL_ARG_xxx}` expansion. */
  toolArgs?: Record<string, unknown>;
  /** Raw user prompt text (for `UserPromptSubmit`). */
  userPrompt?: string;
  /** Active session id (informational; available as `${SESSION_ID}`). */
  sessionId?: string;
  /** Working directory for the spawned shell. Required. */
  projectRoot: string;
  /**
   * `SessionEnd` cause. Surfaced as `LOCALCODE_SESSION_END_REASON`.
   * Ignored for every other trigger.
   */
  reason?: HookSessionEndReason;
  /**
   * Estimated context-token usage at the moment `PreCompact` fired.
   * Surfaced as `LOCALCODE_CONTEXT_TOKENS`. Ignored for other triggers.
   */
  contextTokens?: number;
  /**
   * Configured context-window cap when `PreCompact` fired. Surfaced as
   * `LOCALCODE_MAX_CONTEXT_TOKENS`. Ignored for other triggers.
   */
  maxContextTokens?: number;
  /**
   * Usage snapshot for the just-finished assistant turn. Populated only
   * when firing `Stop`; surfaced as `LOCALCODE_STOP_USAGE_*` env vars.
   */
  usage?: HookUsageSnapshot;
}

/**
 * Result of running one hook. Aggregated by the engine into the array
 * returned from `run()`. Callers decide what to do with `blocked`:
 *
 *   - `PreToolUse`        — reject the tool call.
 *   - `PostToolUse`       — surface a system note but don't undo.
 *   - `UserPromptSubmit`  — reject the submission.
 *   - `SessionStart`      — log and continue (we only run non-blocking
 *     hooks at session start; the field is always false here).
 */
export interface HookOutcome {
  /** The hook that produced this result. */
  hook: HookConfig;
  /** Process exit code; -1 on timeout / spawn failure. */
  exitCode: number;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** `true` when `hook.blocking === true` AND `exitCode !== 0`. */
  blocked: boolean;
  /** `true` when the subprocess was killed for exceeding `hook.timeout`. */
  timedOut: boolean;
}

/**
 * Default per-hook timeout in milliseconds (10 seconds). Kept small to
 * keep tool-flow latency bounded; users who need longer can override
 * per-hook in TOML.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/**
 * Lightweight logger surface — the engine doesn't pull in a real
 * logger so tests can pass `console`-shaped fakes without importing
 * any production dependency.
 */
export interface HookLogger {
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}
