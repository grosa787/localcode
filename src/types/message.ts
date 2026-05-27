/**
 * LLM-specific wire types and callback shapes.
 *
 * These types model the OpenAI-compatible Chat Completions streaming
 * protocol used by both Ollama and LM Studio. They complement — never
 * duplicate — the broader domain types from `@/types/global`.
 */

import type {
  Message,
  PermissionProfile,
  ToolCall,
  ToolResult,
} from '@/types/global';

// ---------- Multimodal content parts (vision) ----------

/**
 * An OpenAI-compatible multimodal content part. `text` parts are plain
 * strings; `image_url` parts carry either an `https://` URL or a
 * `data:image/<mime>;base64,<...>` URI. Vision-capable models (GPT-4o,
 * Qwen-VL, LLaVA, Llama-3.2-Vision, etc.) accept this shape natively
 * via the OpenAI Chat Completions API.
 *
 * `Message.content` remains `string` everywhere for backwards compat —
 * adapters that want to send a multimodal payload should set the
 * message's content to `MessageContentPart[]` at the call site (cast
 * through `unknown`) and the adapter will forward it verbatim.
 */
export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Narrow an unknown value into `MessageContentPart[]` at runtime. Used
 * by the adapter to detect whether the caller provided a multimodal
 * payload in place of the usual string content.
 */
export function isMessageContentPartArray(
  value: unknown,
): value is MessageContentPart[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return false;
  for (const item of value) {
    if (item === null || typeof item !== 'object') return false;
    const t = (item as { type?: unknown }).type;
    if (t === 'text') {
      const text = (item as { text?: unknown }).text;
      if (typeof text !== 'string') return false;
    } else if (t === 'image_url') {
      const urlField = (item as { image_url?: unknown }).image_url;
      if (urlField === null || typeof urlField !== 'object') return false;
      const url = (urlField as { url?: unknown }).url;
      if (typeof url !== 'string') return false;
    } else {
      return false;
    }
  }
  return true;
}

// ---------- Tool schema (OpenAI tools API shape) ----------

export interface ToolFunctionSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolSchema {
  type: 'function';
  function: ToolFunctionSchema;
}

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

// ---------- OpenAI-compatible wire types ----------

/** A single tool-call delta slice as produced by the streaming API. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** A single choice inside a streaming chunk. */
export interface ChatCompletionChoiceDelta {
  index: number;
  delta: {
    role?: 'assistant' | 'user' | 'system' | 'tool';
    content?: string | null;
    tool_calls?: ToolCallDelta[];
  };
  finish_reason?: string | null;
}

/** Top-level streaming chunk shape. */
export interface ChatCompletionChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: ChatCompletionChoiceDelta[];
  /**
   * OpenAI-style usage report. Present on the final chunk when
   * `stream_options: { include_usage: true }` was requested. Also used
   * to passthrough Ollama's native `prompt_eval_count` / `eval_count`.
   */
  usage?:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_eval_count?: number;
        eval_count?: number;
        [k: string]: unknown;
      }
    | null;
}

/** Result of running `parseSSEChunk` on a single `data:` line. */
export type SSEChunk =
  | { kind: 'done' }
  | { kind: 'data'; payload: ChatCompletionChunk }
  | { kind: 'heartbeat' };

/** Non-streaming wire message used when we POST to /v1/chat/completions. */
export interface WireMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /**
   * Either a plain string (the usual case) or an array of multimodal
   * content parts as accepted by OpenAI-compatible vision endpoints.
   */
  content: string | MessageContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

// ---------- Multimodal message helpers ----------

/**
 * Build a user-role Message whose content is an array of parts: an
 * `image_url` part holding a `data:<mime>;base64,<...>` URI plus an
 * optional trailing `text` part with a user hint.
 *
 * Consumers that call `llm.streamChat` will have this multimodal
 * payload forwarded verbatim to the underlying Chat Completions
 * endpoint (vision-capable models accept it natively).
 *
 * Note: `Message.content` is typed as `string` in `@/types/global` so
 * we cast the parts through `unknown` here. The adapter's serialiser
 * sniffs the value with `isMessageContentPartArray` before deciding
 * the wire format.
 */
export function buildImageMessage(
  base64Data: string,
  mimeType: string,
  userText?: string,
): Message {
  const dataUri = base64Data.startsWith('data:')
    ? base64Data
    : `data:${mimeType};base64,${base64Data}`;

  const parts: MessageContentPart[] = [
    { type: 'image_url', image_url: { url: dataUri } },
  ];
  if (typeof userText === 'string' && userText.length > 0) {
    parts.push({ type: 'text', text: userText });
  }

  return {
    id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    // Cast: Message.content is `string` in the public domain type, but
    // the adapter detects array form at serialisation time.
    content: parts as unknown as string,
    createdAt: Date.now(),
  };
}

// ---------- Adapter request/response shapes ----------

export interface LLMStreamCallbacks {
  /** Called for each VISIBLE text delta as it arrives (content outside `<think>` blocks). */
  onChunk?: (text: string) => void;
  /**
   * Called for each delta of MODEL THINKING content (text inside
   * `<think>...</think>` / `<thinking>...</thinking>` / `<|think|>...<|/think|>`
   * blocks). Optional — when omitted, the splitter still routes thinking
   * content separately from visible content but the bytes are dropped on
   * the floor. The UI is expected to render thinking distinctly (collapsed
   * accordion, dimmed text, etc.) so the user can see the model's
   * reasoning without confusing it for the actual reply.
   *
   * R13 — historically the adapter stripped thinking blocks silently
   * (treating them as Qwen runaway garbage). We now expose them as a
   * first-class channel: the splitter routes content inside `<think>`
   * to `onThinkingChunk` and content outside to `onChunk`.
   */
  onThinkingChunk?: (text: string) => void;
  /** Called once, with the fully assembled tool-call batch. */
  onToolCalls?: (toolCalls: ToolCall[]) => void;
  /** Called exactly once at the end of the stream, regardless of outcome. */
  onDone?: (result: StreamDoneResult) => void;
  /**
   * Optional progress callback invoked just before the adapter sleeps
   * between retry attempts. Lets callers surface "Retrying… (N/M)" in
   * the UI without polling. The callback is fire-and-forget — thrown
   * errors are swallowed by the adapter so a buggy listener can't
   * sabotage the retry loop.
   *
   *   - `attempt`        — 1-indexed attempt that just failed.
   *   - `maxAttempts`    — total attempts allowed for this stream
   *                        (transient budget for transient errors,
   *                        regular budget otherwise).
   *   - `reason`         — short error string from the failed attempt.
   *   - `nextDelayMs`    — milliseconds we're about to sleep before
   *                        the next attempt (jitter applied; honours
   *                        `Retry-After`).
   */
  onRetryAttempt?: (info: {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly reason: string;
    readonly nextDelayMs: number;
  }) => void;
}

/**
 * Usage telemetry from the OpenAI-compatible final chunk (when
 * `stream_options: { include_usage: true }` is honoured) or an
 * estimate computed by the adapter when the server omits it.
 */
export interface StreamUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** True when numbers came from a local estimator, not the server. */
  estimated?: boolean;
  /**
   * Prompt tokens served from the provider's prefix cache.
   *   - Anthropic: `usage.cache_read_input_tokens`
   *   - OpenAI / OpenRouter: `usage.prompt_tokens_details.cached_tokens`
   *   - Local providers (Ollama / LM Studio): not reported.
   */
  cachedInputTokens?: number;
  /**
   * Prompt tokens that had to be processed fresh
   * (i.e. `promptTokens - cachedInputTokens`). Computed by the adapter
   * when both promptTokens and cachedInputTokens are known so consumers
   * don't have to do the subtraction themselves.
   */
  freshInputTokens?: number;
  /**
   * Anthropic-only: tokens written into the prefix cache by THIS turn
   * (`usage.cache_creation_input_tokens`). Useful for surfacing the
   * cost of priming a long prompt that subsequent turns will re-use.
   */
  cacheCreationTokens?: number;
}

/**
 * Canonical set of finish reasons surfaced by `LLMAdapter.streamChat`.
 *
 *   - `'stop'`         — clean completion (server `finish_reason: 'stop'`,
 *                        `'tool_calls'`, or null/undefined; we collapse
 *                        non-error terminations into `stop`).
 *   - `'length'`       — server hit `max_tokens`. Response is truncated.
 *   - `'aborted'`      — caller cancelled via `cancel()` or external signal.
 *   - `'error'`        — generic stream-level failure (network, parse,
 *                        empty stream, stall, server 5xx, etc).
 *   - `'thinking-only'`— Qwen / DeepSeek-style model emitted only
 *                        `<think>...</think>` reasoning content and no
 *                        visible reply. The stream completed but the user
 *                        never saw any actual answer. Surfaced as its own
 *                        reason so the UI can render an actionable hint
 *                        rather than a generic empty-response error.
 *
 * `finishReason` is typed as `FinishReason | string` to keep wire-level
 * passthrough resilient — if a future server reports a brand-new value,
 * it propagates as-is to the caller without us swallowing it.
 */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'aborted'
  | 'error'
  | 'thinking-only';

export interface StreamDoneResult {
  error?: string;
  /**
   * One of the canonical {@link FinishReason} values, or any other
   * string the server surfaced verbatim. Callers should compare
   * against the canonical set first.
   */
  finishReason: FinishReason | string;
  usage?: StreamUsage;
  durationMs?: number;
}

export interface StreamChatParams extends LLMStreamCallbacks {
  messages: Message[];
  tools?: readonly ToolSchema[];
  /** Optional override for model — otherwise uses adapter config's current model. */
  model?: string;
  /** Optional per-request abort signal; combined with internal cancel(). */
  signal?: AbortSignal;
  /** Optional extra raw options passed through (temperature etc). */
  options?: Record<string, unknown>;
}

// ---------- Context manager types ----------

export interface ContextUsage {
  tokenCount: number;
  percent: number;
}

export type Summarizer = (messagesToSummarize: Message[]) => Promise<string>;

export interface ContextManagerOptions {
  summarizer?: Summarizer;
  /** Trigger summarize when usage exceeds this percent (0..1). Default 0.80. */
  summarizeAtPercent?: number;
  /** Number of recent messages to retain verbatim during summarization. Default 10. */
  keepLastN?: number;
  /** Callback fired after a successful summarization. */
  onSummarized?: (savedTokens: number) => void;
  /**
   * Cap on the number of messages kept resident in memory. When the
   * internal list grows past this, the oldest half is moved to an
   * in-process ring buffer (no disk paging — SQLite already persists).
   * Default 200.
   */
  maxInMemoryMessages?: number;
}

// ---------- Tool executor types ----------

export type ToolHandler = (
  args: Record<string, unknown>
) => Promise<ToolResult>;

export type ToolHandlerMap = Record<string, ToolHandler>;

/**
 * Return shape of the `approvalCallback`. The legacy `boolean` form
 * remains supported (every existing call site returns one); a richer
 * object form lets the UI signal the batching flags from the `[A]` and
 * `[S]` buttons in `<ApprovalPrompt>` without rebuilding the executor.
 *
 *   - `approveAllInTurn`  — every subsequent matching tool call this turn
 *                          auto-approves. Reset at the start of the next
 *                          user message via `resetTurnAutoApprove()`.
 *   - `approveForSession` — for `run_command`, captures the exact command
 *                          arg into the executor's in-memory allow-list.
 *                          NOT persisted to disk.
 */
export type ApprovalCallback = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<
  | boolean
  | {
      readonly approved: boolean;
      readonly approveAllInTurn?: boolean;
      readonly approveForSession?: boolean;
    }
>;

/**
 * Post-commit hook signature. Invoked by `ToolExecutor` after a
 * successful `write_file` or `edit_file` commit. Return a `ToolResult`
 * for the executor to surface via `onAutoCheckResult`, or `null` to
 * skip emitting a synthetic message for this call.
 *
 * The hook MUST NOT mutate the original tool result — the executor
 * already returns that to its caller. The hook's job is additive: a
 * secondary check (lint, format, test) whose output nudges the model
 * on its next turn.
 *
 * Signature intentionally matches the callback shape requested by
 * Agent 8: `(toolName, args, result) => Promise<ToolResult | null>`.
 */
export type PostCommitHook = (
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
) => Promise<ToolResult | null>;

// BATCH-APPROVAL-SECTION
/**
 * Single entry in a batch-approval request. The executor builds one of
 * these per mutating tool call (before invoking the handler) and hands
 * the full set to `batchApprovalCallback`. The UI uses `toolName` /
 * `args` to render an item row (filename, command, etc.) and uses
 * `toolCallId` as the stable map key when returning the decisions.
 */
export interface BatchApprovalItem {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

/**
 * Per-item decision returned by `batchApprovalCallback`. We deliberately
 * keep the wire vocabulary narrow (`'approved' | 'rejected'`) so the UI
 * can't smuggle ambiguous tri-state values through the channel. Any
 * `toolCallId` missing from the returned map is treated as rejected.
 */
export type BatchApprovalDecision = 'approved' | 'rejected';

/**
 * Batch-approval callback. Receives every mutating tool call in the
 * current LLM turn and resolves to a map of per-item decisions keyed by
 * `toolCallId`. The executor commits the approved calls in original
 * order and synthesises a "User rejected ..." ToolResult for the rest.
 *
 * Only fired when:
 *   - `batchApprovalCallback` is configured on the executor opts,
 *     AND
 *   - the count of mutating tool calls in a single `executeAll` invocation
 *     meets or exceeds `permissions.batchApprovalThreshold` (default 3).
 *
 * Below the threshold OR with no callback configured, the executor
 * falls back to the per-call `approvalCallback` flow (one prompt per
 * mutating tool, matching legacy behaviour).
 */
export type BatchApprovalCallback = (params: {
  readonly items: readonly BatchApprovalItem[];
}) => Promise<ReadonlyMap<string, BatchApprovalDecision>>;
// BATCH-APPROVAL-SECTION-END

export interface ToolExecutorOptions {
  handlers: ToolHandlerMap;
  approvalCallback?: ApprovalCallback;
  dangerouslyAllowAll?: boolean;
  /**
   * Tool names the user has pre-approved via `/permissions`. When a call
   * targets a tool in this list, the approval flow is skipped (the
   * handler runs directly). Equivalent to `dangerouslyAllowAll` but
   * scoped per-tool.
   */
  autoApproveTools?: readonly string[];
  /**
   * R4 — FIX #27. When true (default) the executor runs `lint_file` on
   * any `.ts/.tsx/.js/.jsx/.py/.go/.rs` file after a successful
   * `write_file` or `edit_file` commit. Diagnostics are surfaced to the
   * caller through `onAutoCheckResult` as a synthetic tool-role
   * `Message`; the original `execute()` return value is UNCHANGED.
   * Set to `false` to disable the hook (useful for tests or dry runs).
   */
  autoLintAfterWrite?: boolean;
  /**
   * R4 — FIX #27. Invoked with the synthetic tool-role Message produced
   * by the post-commit hook. Typical wiring appends the message to the
   * active `ContextManager` so the next LLM turn sees the diagnostics.
   * Called at most once per tool execution. Never called when the hook
   * returns `null` or `autoLintAfterWrite === false`.
   */
  onAutoCheckResult?: (syntheticMsg: Message) => void;
  /**
   * Settings-driven hooks bridge. When supplied, the executor invokes
   * the engine BEFORE each tool's handler (`PreToolUse`) and AFTER each
   * successful result (`PostToolUse`). A blocking `PreToolUse` hook
   * that exits non-zero converts the tool call into a `success: false`
   * ToolResult with the hook's stderr embedded. `PostToolUse` blocks
   * surface as a synthetic system note via `onHookEvent` but never
   * undo the tool. When the bridge is absent or `hasHooksFor` returns
   * false the executor's hot path is identical to before.
   */
  hookBridge?: ToolExecutorHookBridge;
  /**
   * Optional observer for hook events emitted during a tool call. The
   * synthetic Message describes what happened (e.g. "PostToolUse hook
   * X blocked: ..."), to be appended to the conversation by the caller.
   * Same wiring shape as `onAutoCheckResult` so call sites can reuse
   * a single dispatcher.
   */
  onHookEvent?: (syntheticMsg: Message) => void;
  /**
   * Project root used as the cwd for hook subprocesses. Falls back to
   * `process.cwd()` when unset; tests usually supply an explicit value.
   */
  projectRoot?: string;
  /**
   * Active session id forwarded into the `HookContext`. Optional —
   * absence is fine; the hook only sees an empty `${SESSION_ID}` env.
   */
  sessionId?: string;
  /**
   * Active permission profile. Layered on top of `autoApproveTools` /
   * `dangerouslyAllowAll`. See `ToolExecutor.resolveApprovalPolicy` for
   * precedence rules. Default `'default'` preserves legacy behaviour.
   */
  profile?: PermissionProfile;
  // BATCH-APPROVAL-SECTION
  /**
   * Unified batch-approval callback. When supplied AND the count of
   * mutating tool calls in a single `executeAll` invocation meets or
   * exceeds {@link batchApprovalThreshold}, the executor calls this
   * ONCE with every mutating item upfront (instead of firing
   * {@link approvalCallback} sequentially per call). The UI renders a
   * single modal where the user reviews all diffs at once and resolves
   * with a `Map<toolCallId, 'approved' | 'rejected'>`. Below the
   * threshold OR when undefined, the executor falls back to the
   * per-call `approvalCallback` flow.
   *
   * Sensitive-files matches and read-only calls are NEVER routed
   * through the batch flow — they always honour the per-call approval
   * gate (sensitive) or skip approval entirely (read-only).
   */
  batchApprovalCallback?: BatchApprovalCallback;
  /**
   * Minimum number of mutating tool calls required in a single
   * `executeAll` invocation to trigger {@link batchApprovalCallback}.
   * Default 3 — multi-file refactor threshold. Range 1..99 enforced
   * upstream (see `permissions.batchApprovalThreshold` in
   * `src/config/types.ts`); the executor accepts the value verbatim.
   * Setting to 1 makes every mutating call route through the batch UI;
   * setting to 99 effectively disables the batch flow.
   */
  batchApprovalThreshold?: number;
  // BATCH-APPROVAL-SECTION-END
}

/**
 * Narrow interface the executor uses to talk to the hook engine. The
 * concrete implementation in `src/hooks/engine.ts` satisfies this
 * shape; defining it here keeps the executor free of an import cycle
 * and lets tests inject hand-rolled fakes.
 */
export interface ToolExecutorHookBridge {
  /** Fast predicate — skip context build when no hooks match the trigger. */
  hasHooksFor(trigger: 'PreToolUse' | 'PostToolUse'): boolean;
  /**
   * Run every matching hook in parallel. The executor only inspects
   * `{ blocked, stderr }` on the returned entries; the rest is for
   * observability.
   */
  run(ctx: {
    trigger: 'PreToolUse' | 'PostToolUse';
    toolName: string;
    toolArgs: Record<string, unknown>;
    projectRoot: string;
    sessionId?: string;
  }): Promise<
    ReadonlyArray<{
      blocked: boolean;
      stderr: string;
      stdout: string;
      exitCode: number;
      hook: { command: string; description?: string };
    }>
  >;
}

/** Tools that always require explicit user approval unless dangerouslyAllowAll. */
export const APPROVAL_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'run_command',
  // `git_commit` mutates the repository state (HEAD moves, refs change).
  // It uses the standard preview/commit two-phase flow so the user can
  // inspect the diff before approving.
  'git_commit',
  // NOTE: `multi_edit` is intentionally NOT listed here — like `edit_file`
  // it uses the two-phase preview/commit flow where the diff itself IS
  // the approval surface (rendered by ChatScreen as a diff block, not as
  // an opaque approval prompt). The executor classifies it as an EDIT_TOOL
  // (see `src/llm/tool-executor.ts`) so `acceptEdits`/`plan` profiles and
  // the post-commit auto-lint hook still treat it as a mutating tool.
]);

/** The canonical set of supported tool names. */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'write_file',
  'run_command',
  'list_dir',
  'glob_search',
  'edit_file',
  'multi_edit',
  'fetch_image',
  'lint_file',
  'find_symbol',
  // Multi-agent orchestration tools (R+: handled by the orchestrator).
  // Lead-only: spawn_agent. Read-only: agent_status, team_read.
  // Mutating but auto-approved: await_agent, team_send.
  'spawn_agent',
  'agent_status',
  'await_agent',
  'team_send',
  'team_read',
  // Web + structured-git tool families.
  'web_fetch',
  'web_search',
  'git_status',
  'git_log',
  'git_branch',
  'git_diff',
  'git_commit',
  // Jupyter notebook tools (B2). notebook_read is read-only; notebook_edit
  // is two-phase mutating like edit_file.
  'notebook_read',
  'notebook_edit',
  // Background-task monitor (B3). Read-only with one exception (SIGTERM
  // via killTask: true), but the destructive run_command that spawned the
  // task already passed its own approval gate.
  'monitor',
  // C2 — schedule_wakeup: model defers its own continuation. Single-
  // phase, no approval, no destructive side effect.
  'schedule_wakeup',
  // PDF-TOOL-NAMES-SECTION — read_pdf is single-phase, read-only.
  'read_pdf',
  // PDF-TOOL-NAMES-SECTION-END
  // ONTOLOGY-TOOL-NAMES-SECTION — ontology queries; single-phase,
  // read-only; safe to bypass approval. Each handler returns a
  // `{ success: false, error: 'Ontology not ready' }` envelope when
  // the indexer hasn't surfaced any symbols yet.
  'find_call_sites',
  'impacts_of',
  'type_hierarchy',
  // ONTOLOGY-TOOL-NAMES-SECTION-END
  // PROCESS-STATUS-TOOL-NAMES-SECTION — read-only inspection of
  // `ProcessMonitor`. Single-phase, no approval; the underlying spawn
  // already passed approval via `/watch` (or run_command).
  'process_status',
  // PROCESS-STATUS-TOOL-NAMES-SECTION-END
]);

/**
 * Generic usage triple — an alias/alternative to {@link StreamUsage} with
 * all three fields required. Used by `LLMAdapter.streamMultiple` to
 * aggregate per-slot usage when every sub-stream reports numbers. Fields
 * default to 0 in aggregate contexts where the server omitted one value.
 */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
