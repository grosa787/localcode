/**
 * ContextManager — owns the sliding window of chat messages sent to the LLM.
 *
 * Responsibilities:
 *   - Append new messages (`add`).
 *   - Expose the current list (`getMessages`).
 *   - Approximate token usage (`getTokenCount`, `getContextPercent`).
 *   - Build the system prompt with optional project context + active skills.
 *   - Auto-summarise older messages once usage passes a configurable threshold.
 *
 * Token estimate: 4 characters ≈ 1 token. Close enough for UI progress and
 * summarisation heuristics; the server enforces the real limit.
 *
 * Summarisation is *never* performed in-line here — the actual LLM call is
 * injected via the `summarizer` callback so the manager stays dependency-free.
 */

import type { Message, OutputStyle, Skill } from '@/types/global';
import type {
  ContextManagerOptions,
  ContextUsage,
  Summarizer,
} from '@/types/message';
import {
  buildPersonaForPreset,
  detectModelPreset,
  type ModelPresetName,
} from '@/llm/prompt-presets';
import { buildLeadAgentPrompt } from '@/llm/agent-prompts';

// OUTPUT-STYLE-SECTION ----------------------------------------------
//
// Short, byte-stable preambles for the three output styles. The
// `buildSystemPrompt` flow injects exactly one of these immediately
// after the `## Project context` block (and before `## Memory` /
// `## Active skills`) so the prompt prefix mutation is bounded to a
// single line — leaving the remainder of the prefix cacheable.
//
// Each preamble is a single string with no trailing newline so the
// parts-join contract elsewhere stays consistent. Keep it short — the
// purpose is to nudge style, not to teach the model how to write code
// (that's the job of the senior-engineer persona earlier in the prompt).
const OUTPUT_STYLE_PREAMBLES: Record<OutputStyle, string> = {
  concise:
    'Response style: concise — minimal narration, direct answers.',
  explanatory:
    'Response style: explanatory — include rationale, tradeoffs, and alternatives where relevant.',
  verbose:
    'Response style: verbose — detailed step-by-step commentary.',
};
// OUTPUT-STYLE-SECTION-END ------------------------------------------

const CHARS_PER_TOKEN = 4;
const DEFAULT_SUMMARIZE_AT = 0.8;
const DEFAULT_KEEP_LAST = 10;
const DEFAULT_MAX_IN_MEMORY_MESSAGES = 200;

/**
 * R26 (Agent A) — default number of recent tool-role messages to keep
 * verbatim in the wire payload sent to the LLM. Older tool results are
 * collapsed into a one-line stub via {@link trimOldToolResults} so the
 * model only sees the most recent N raw tool outputs. Reduces prompt
 * tokens by 40-60% on long sessions where the model has been reading
 * many files.
 *
 * The full content stays in SQLite — collapse is purely a view
 * transformation applied right before serialising to JSON for the
 * server. If the model needs an old tool result back it can simply
 * re-call the relevant tool.
 */
export const DEFAULT_TRIM_TOOL_RESULTS_AFTER = 3;

/**
 * Default cap on the number of trailing chat messages forwarded to the
 * LLM each turn (system prompt + optional `[Compressed context]`
 * marker are kept on top of this). Tunable via
 * `config.context.maxRecentMessages`. Picked at 20 because that
 * comfortably covers a dozen tool round-trips while staying well
 * inside the prompt budget for very long vibe-coding sessions where
 * the context manager has accumulated 200+ messages.
 *
 * Set to 0 (or any non-positive number) on the config side to disable
 * the window — the full in-memory history is sent.
 */
export const DEFAULT_MAX_RECENT_MESSAGES = 20;

/**
 * R9 — when LOCALCODE.md is larger than this many characters
 * (~1250 tokens at the 4-chars-per-token estimate), do NOT inline
 * the file into the system prompt. Replace it with a short pointer
 * directing the model to read the file lazily via `read_file`.
 *
 * Why: inlining a 30 KB project doc into every prompt makes the
 * local model (LM Studio / Ollama) pay the full re-tokenisation
 * cost on every turn, and — more importantly — embedding *any*
 * variable-length user content inside the system prompt prefix
 * defeats the prompt-cache (the cache keys on a stable byte prefix).
 *
 * Below the threshold we keep the legacy inline behaviour so small
 * docs still benefit from automatic context.
 */
export const LOCALCODE_INLINE_LIMIT = 5000;

/**
 * Cheap tokens-from-chars estimator. Accepts either a string or a raw
 * character count. Keep this in one place so the adapter (where we don't
 * re-scan the streamed text) and the manager (where we sum message
 * content) agree on the constant.
 */
export function estimateTokens(input: string | number): number {
  const chars = typeof input === 'number' ? input : input.length;
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Rough estimate of the wire-payload token count for a system prompt
 * + chat history. Uses the same `4 chars ≈ 1 token` heuristic as
 * {@link estimateTokens} — accurate to ±20%, which is good enough for
 * trigger decisions like the auto-compress threshold (see
 * `src/llm/auto-compress.ts`). For exact accounting use the server's
 * `usage` field returned on the SSE `done` event.
 *
 * Counts message content (string or multimodal parts via
 * {@link charsInContent}), role overhead, tool-call argument JSON, and
 * tool names. The optional `systemPrompt` is added on top so callers
 * can reason about the *full* prefix the model sees, not just the
 * conversation tail.
 */
export function estimateContextTokens(
  messages: readonly Message[],
  systemPrompt: string = '',
): number {
  let chars = systemPrompt.length;
  for (const m of messages) {
    chars += charsInContent(m.content);
    chars += m.role.length;
    if (m.toolCalls) {
      for (const call of m.toolCalls) {
        chars += call.name.length;
        chars += safeLength(call.arguments);
      }
    }
    if (m.toolName) chars += m.toolName.length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * R26 reframed the preamble around senior pair-programming (replacing
 * the older "AI coding assistant" framing). R27 keeps it a single,
 * stable sentence so the prompt prefix stays byte-identical for the
 * local-model prompt cache.
 */
export const SYSTEM_PROMPT_BASE =
  `You are LocalCode, a senior software engineer running locally on the user's machine and pair-programming with them.`;

export class ContextManager {
  private messages: Message[] = [];
  private readonly summarizer: Summarizer | undefined;
  private readonly summarizeAtPercent: number;
  private readonly keepLastN: number;
  private readonly onSummarized: ((savedTokens: number) => void) | undefined;
  private readonly maxInMemoryMessages: number;

  private _sessionTokensIn = 0;
  private _sessionTokensOut = 0;
  private _offloadedCount = 0;

  constructor(options: ContextManagerOptions = {}) {
    this.summarizer = options.summarizer;
    this.summarizeAtPercent = clampPercent(
      options.summarizeAtPercent ?? DEFAULT_SUMMARIZE_AT
    );
    this.keepLastN = Math.max(1, Math.floor(options.keepLastN ?? DEFAULT_KEEP_LAST));
    this.onSummarized = options.onSummarized;
    this.maxInMemoryMessages = Math.max(
      // Two is the smallest sane value (keeps at least one old + one new).
      2,
      Math.floor(options.maxInMemoryMessages ?? DEFAULT_MAX_IN_MEMORY_MESSAGES),
    );
  }

  // ---------- Session-wide usage totals ----------

  /** Total input tokens recorded for the current session via `recordUsage`. */
  get sessionTokensIn(): number {
    return this._sessionTokensIn;
  }

  /** Total output tokens recorded for the current session via `recordUsage`. */
  get sessionTokensOut(): number {
    return this._sessionTokensOut;
  }

  /**
   * Accumulate the usage numbers from a single LLM response. Non-finite
   * or negative values are clamped to zero so a bad server report can't
   * corrupt the session totals. Called by the composition root after
   * each `onDone` from `LLMAdapter.streamChat`.
   */
  recordUsage(tokensIn: number, tokensOut: number): void {
    this._sessionTokensIn += Math.max(
      0,
      Number.isFinite(tokensIn) ? Math.floor(tokensIn) : 0
    );
    this._sessionTokensOut += Math.max(
      0,
      Number.isFinite(tokensOut) ? Math.floor(tokensOut) : 0
    );
  }

  /** Reset the session-wide counters (call from /clear or /new). */
  resetUsage(): void {
    this._sessionTokensIn = 0;
    this._sessionTokensOut = 0;
  }

  // ---------- Message list ----------

  add(message: Message): void {
    this.messages.push(message);
    this.enforceInMemoryCap();
  }

  addMany(messages: readonly Message[]): void {
    for (const m of messages) this.messages.push(m);
    this.enforceInMemoryCap();
  }

  getMessages(): Message[] {
    // Return a shallow copy so callers can't mutate our internal state.
    // Callers that need older messages should lazily reload them from
    // SQLite via SessionManager and re-inject via `prependMessages`.
    return this.messages.slice();
  }

  /**
   * Re-hydrate older messages at the head of the in-memory list
   * (typically lazy-loaded from the SQLite store when the user scrolls
   * up in the UI). Duplicates by id are silently dropped so repeated
   * calls remain idempotent.
   */
  prependMessages(msgs: readonly Message[]): void {
    if (msgs.length === 0) return;
    const seen = new Set<string>(this.messages.map((m) => m.id));
    const fresh: Message[] = [];
    for (const m of msgs) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      fresh.push(m);
    }
    if (fresh.length === 0) return;
    this.messages = [...fresh, ...this.messages];
    // Re-hydration shrinks the offloaded count by at most that many.
    this._offloadedCount = Math.max(0, this._offloadedCount - fresh.length);
    this.enforceInMemoryCap();
  }

  /**
   * Number of messages that have been dropped from the in-memory view
   * because of `maxInMemoryMessages`. They remain persisted in SQLite
   * and can be re-attached via `prependMessages`. Always ≥ 0.
   */
  get offloadedCount(): number {
    return this._offloadedCount;
  }

  clear(): void {
    this.messages = [];
    this._offloadedCount = 0;
  }

  replaceAll(messages: readonly Message[]): void {
    this.messages = messages.slice();
    this._offloadedCount = 0;
    this.enforceInMemoryCap();
  }

  /**
   * If the in-memory array grew past `maxInMemoryMessages`, drop the
   * oldest half and bump the offloaded counter. SQLite already holds
   * the full history — this is purely a RAM bound.
   */
  private enforceInMemoryCap(): void {
    if (this.messages.length <= this.maxInMemoryMessages) return;
    const dropCount = Math.ceil(this.messages.length / 2);
    this.messages = this.messages.slice(dropCount);
    this._offloadedCount += dropCount;
  }

  // ---------- Token accounting ----------

  getTokenCount(): number {
    let chars = 0;
    for (const m of this.messages) {
      // content + role overhead + any tool-call JSON payloads
      chars += charsInContent(m.content);
      chars += m.role.length;
      if (m.toolCalls) {
        for (const call of m.toolCalls) {
          chars += call.name.length;
          chars += safeLength(call.arguments);
        }
      }
      if (m.toolName) chars += m.toolName.length;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  getContextPercent(maxTokens: number): number {
    if (maxTokens <= 0) return 0;
    return this.getTokenCount() / maxTokens;
  }

  getUsage(maxTokens: number): ContextUsage {
    return {
      tokenCount: this.getTokenCount(),
      percent: this.getContextPercent(maxTokens),
    };
  }

  // BUDGET-BREAKDOWN-SECTION (start) ----------------------------
  //
  // Per-zone context decomposition. The status pill / context-budget
  // bar wants to show WHICH part of the window is currently full —
  // five zones: system prompt, skills, memory, messages, tool results.
  // Each zone is computed by re-running the same `4 chars ≈ 1 token`
  // heuristic the rest of the manager uses, so the bar stays
  // self-consistent with `getTokenCount`.
  //
  // Caller responsibility: feed the rendered system-prompt parts back
  // in (`systemPromptText`, `skillsText`, `memoryText`) so this method
  // doesn't have to re-import the SkillsManager and rebuild the
  // prompt. When unknown, pass `''` and the zone collapses to zero.

  /**
   * Compute a per-zone breakdown of the current context fill. All
   * counts are token estimates using the same `4 chars ≈ 1 token`
   * heuristic as {@link getTokenCount}. `total` is the sum of the
   * five zones — equal to (or very close to) what {@link getTokenCount}
   * would return for the same messages and a system prompt assembled
   * from the supplied fragments.
   *
   * Zones:
   *   - `systemPromptTokens` — base preamble + identity + "how you work".
   *   - `skillsTokens` — concatenated active-skill markdown.
   *   - `memoryTokens` — rendered memory section text.
   *   - `messagesTokens` — user/assistant content + role overhead.
   *   - `toolResultsTokens` — tool-role content (subset of messages).
   *
   * The `max` field surfaces the same `maxTokens` argument so callers
   * don't have to track it separately for the bar denominator.
   */
  getBreakdown(opts: {
    systemPromptText?: string;
    skillsText?: string;
    memoryText?: string;
    maxTokens: number;
  }): {
    systemPromptTokens: number;
    skillsTokens: number;
    memoryTokens: number;
    messagesTokens: number;
    toolResultsTokens: number;
    total: number;
    max: number;
  } {
    const systemPromptTokens = estimateTokens(opts.systemPromptText ?? '');
    const skillsTokens = estimateTokens(opts.skillsText ?? '');
    const memoryTokens = estimateTokens(opts.memoryText ?? '');

    // Split message-side tokens into "regular" (user/assistant/system
    // chat content) vs "tool results" (tool-role messages). Tool
    // results are typically the dominant bulk — surfacing them
    // separately tells the user where to compress.
    let chatChars = 0;
    let toolChars = 0;
    for (const m of this.messages) {
      const c = charsInContent(m.content);
      const roleChars = m.role.length;
      const toolCallChars = (() => {
        if (!m.toolCalls) return 0;
        let total = 0;
        for (const call of m.toolCalls) {
          total += call.name.length;
          total += safeLength(call.arguments);
        }
        return total;
      })();
      const toolNameChars = m.toolName !== undefined ? m.toolName.length : 0;
      if (m.role === 'tool') {
        toolChars += c + roleChars + toolNameChars + toolCallChars;
      } else {
        chatChars += c + roleChars + toolNameChars + toolCallChars;
      }
    }

    const messagesTokens = Math.ceil(chatChars / CHARS_PER_TOKEN);
    const toolResultsTokens = Math.ceil(toolChars / CHARS_PER_TOKEN);

    const total =
      systemPromptTokens +
      skillsTokens +
      memoryTokens +
      messagesTokens +
      toolResultsTokens;

    return {
      systemPromptTokens,
      skillsTokens,
      memoryTokens,
      messagesTokens,
      toolResultsTokens,
      total,
      max: Math.max(0, Math.floor(opts.maxTokens)),
    };
  }
  // BUDGET-BREAKDOWN-SECTION (end) ------------------------------

  // ---------- Summarisation ----------

  /**
   * If usage exceeds `summarizeAtPercent` and a summarizer callback is wired
   * up, replace the older portion of the history with a single assistant
   * message containing the summary. Returns true if summarisation ran.
   *
   * Any error raised by the summariser is swallowed — the manager returns
   * false and leaves history untouched.
   */
  async maybeSummarize(maxTokens: number): Promise<boolean> {
    if (!this.summarizer) return false;
    const percent = this.getContextPercent(maxTokens);
    if (percent <= this.summarizeAtPercent) return false;
    if (this.messages.length <= this.keepLastN) return false;

    const splitAt = this.messages.length - this.keepLastN;
    const toSummarize = this.messages.slice(0, splitAt);
    const toKeep = this.messages.slice(splitAt);

    if (toSummarize.length === 0) return false;

    const before = this.getTokenCount();

    let summary: string;
    try {
      summary = await this.summarizer(toSummarize);
    } catch {
      return false;
    }
    if (typeof summary !== 'string' || summary.length === 0) {
      return false;
    }

    const summaryMessage: Message = {
      id: `summary-${Date.now().toString(36)}`,
      role: 'assistant',
      content: `[Previous context summary]: ${summary}`,
      createdAt: Date.now(),
    };

    this.messages = [summaryMessage, ...toKeep];

    const after = this.getTokenCount();
    const saved = Math.max(0, before - after);
    if (this.onSummarized) this.onSummarized(saved);
    return true;
  }

  /**
   * Manually compress the *entire* in-memory history into a single
   * summary message — the back-end of the `/compress` slash command
   * (FIX #34). Unlike `maybeSummarize`, this never checks a percent
   * threshold and never silently swallows errors: if the summariser
   * throws, the exception propagates to the caller (cmd-compress
   * surfaces it via `ctx.print`).
   *
   * Algorithm:
   *   1. Snapshot current messages + tokens.
   *   2. Split at `length - keepLast` (default 0 → summarise all).
   *   3. Run `summarizer(toSummarize)` → string.
   *   4. Replace internal messages with `[summaryMsg, ...keptTail]`,
   *      where `summaryMsg` is an assistant-role message whose
   *      content begins with `[Compressed context]\n\n` so the model
   *      can recognise it on the next turn (cf. system prompt
   *      addendum).
   *   5. Return `{ summary, oldCount, newCount, tokensSaved }`.
   *
   * Edge cases:
   *   - Empty history → no work, returns zero-shaped result.
   *   - `keepLast >= length` → no messages to summarise, returns
   *     a no-op result (history untouched).
   *   - Empty/whitespace summary → history untouched; `tokensSaved = 0`.
   */
  async compress(
    summarizer: (messages: Message[]) => Promise<string>,
    opts?: { keepLast?: number },
  ): Promise<{
    summary: string;
    oldCount: number;
    newCount: number;
    tokensSaved: number;
  }> {
    const oldMessages = this.getMessages();
    const oldCount = oldMessages.length;
    if (oldCount === 0) {
      return { summary: '', oldCount: 0, newCount: 0, tokensSaved: 0 };
    }

    const oldTokens = this.getTokenCount();

    const keepLast = Math.max(0, Math.floor(opts?.keepLast ?? 0));
    const splitAt = Math.max(0, oldMessages.length - keepLast);
    const toSummarize = oldMessages.slice(0, splitAt);
    const keptTail = oldMessages.slice(splitAt);

    if (toSummarize.length === 0) {
      // Nothing to summarise (keepLast >= length). No mutation.
      return {
        summary: '',
        oldCount,
        newCount: oldCount,
        tokensSaved: 0,
      };
    }

    const rawSummary = await summarizer(toSummarize);
    const summary =
      typeof rawSummary === 'string' ? rawSummary.trim() : '';

    if (summary.length === 0) {
      // Empty summary → don't blow away history.
      return {
        summary: '',
        oldCount,
        newCount: oldCount,
        tokensSaved: 0,
      };
    }

    const summaryMsg: Message = {
      id: makeRandomId('compressed'),
      role: 'assistant',
      content: `[Compressed context]\n\n${summary}`,
      createdAt: Date.now(),
    };

    this.messages = [summaryMsg, ...keptTail];
    // Compression is a deliberate user action — full history rewrite.
    // Reset offload accounting since the in-memory list is now the
    // truth (the older messages are still in SQLite, but the
    // compressed view supersedes them for prompt purposes).
    this._offloadedCount = 0;

    const newTokens = this.getTokenCount();
    const tokensSaved = Math.max(0, oldTokens - newTokens);

    return {
      summary,
      oldCount,
      newCount: this.messages.length,
      tokensSaved,
    };
  }

  /**
   * Produce a compact summary of the *entire* in-memory history for
   * the purpose of persisting to `session.summary` and re-injecting on
   * `/resume`. The summariser — usually a thin wrapper around
   * `llm.streamChat` — is injected so this module stays
   * dependency-free. An empty history short-circuits to an empty
   * string; a summariser that throws or returns an empty string is
   * surfaced as an empty string (callers decide whether to persist).
   */
  async generateSummary(
    summarizer: (messages: Message[]) => Promise<string>,
  ): Promise<string> {
    const snapshot = this.messages.slice();
    if (snapshot.length === 0) return '';
    let summary: string;
    try {
      summary = await summarizer(snapshot);
    } catch {
      return '';
    }
    if (typeof summary !== 'string') return '';
    return summary.trim();
  }

  // ---------- System prompt ----------

  /**
   * Build the full system prompt: a senior-engineer persona preamble,
   * a critical language-consistency rule (placed near the top so the
   * model gives it maximum weight), a "how you work" section
   * emphasising read-before-write and the `edit_file` over
   * `write_file` preference, a tool-approval reminder, a
   * self-configuration pointer, an image-handling note, plus optional
   * prior-session summary, project context (LOCALCODE.md — inlined
   * when small, replaced by a lazy-load pointer when above
   * `LOCALCODE_INLINE_LIMIT`), and the currently active skills sorted
   * deterministically by id.
   *
   * Accepts two call shapes for backwards-compat:
   *   - `buildSystemPrompt(localcodeMd, skills)` — legacy positional
   *   - `buildSystemPrompt({ localcodeMd, skills, summary, userLatestSnippet })`
   *     — new options bag
   *
   * Empty / null sections are omitted rather than rendered as empty
   * headings — keeps the prompt tight.
   *
   * R9 — stable-prefix optimisation:
   *   - Skills are sorted by `id` so reload order doesn't perturb the
   *     prompt prefix.
   *   - The `userLatestSnippet` param is accepted for backwards-compat
   *     but intentionally ignored: the trailing "## Reminder" block
   *     was removed because embedding the user's most recent message
   *     into the system prompt forced a cache miss on every turn. The
   *     language-consistency rule still lives at the TOP of the
   *     prompt under "## Language (CRITICAL)", which is enough.
   */
  buildSystemPrompt(
    localcodeMdOrOpts?:
      | string
      | null
      | {
          localcodeMd?: string | null;
          skills?: readonly Skill[];
          summary?: string | null;
          /**
           * R9 — accepted for backwards-compat with R7 callers but
           * intentionally ignored. Previously a soft reminder was
           * appended to the end of the prompt double-anchoring the
           * language rule. That made the system prompt mutate every
           * turn (because the reminder embedded the user's latest
           * message), which defeated the local-model prompt cache.
           * The language rule near the top is enough.
           */
          userLatestSnippet?: string;
          /**
           * R26 (ROADMAP #14) — optional model name used to select a
           * model-specific Identity preset (Qwen / Gemma / Llama /
           * DeepSeek / generic). When omitted or the name doesn't
           * match a known family, the `default` preset is used (which
           * preserves the legacy R8/R15 senior-engineer text). The
           * REST of the prompt — Language, How you work,
           * Self-configuration, etc — is unchanged across presets so
           * the cache prefix stays as stable as possible.
           */
          modelName?: string;
          /**
           * R26 — explicit preset override. Wins over `modelName`
           * detection. Useful for tests and for users who want to
           * pin a specific preset regardless of which model is loaded.
           */
          preset?: ModelPresetName;
          /**
           * Multi-agent — when true, the lead-orchestration prompt
           * (built via `buildLeadAgentPrompt`) is appended at the end
           * of the prompt body. Pure function of inputs, so calling
           * `buildSystemPrompt` twice with the same options yields
           * byte-identical output (preserves prefix-cache stability).
           */
          agentsExposed?: boolean;
          /**
           * Tool names to surface in the lead-orchestration section
           * (kept stable / sorted by the caller for cache stability).
           * Ignored when `agentsExposed !== true`.
           */
          agentTools?: readonly string[];
          /**
           * Strict allow-list of worker slots the lead may spawn —
           * surfaced verbatim in the multi-agent section so the model
           * knows the exact set of acceptable models / slot indices.
           * Ignored when `agentsExposed !== true`.
           */
          agentWorkerSlots?: readonly { model: string; skills?: readonly string[] }[];
          /**
           * Legacy single-model worker fallback. Rendered only when
           * `agentWorkerSlots` is empty / absent (preserves byte-stable
           * output for sessions that never touched the slot UI).
           */
          agentWorkerModelFallback?: string;
          /**
           * Memory system — pre-rendered memory section text. When
           * supplied, injected between the project-context block and the
           * active-skills block. Must be byte-stable for fixed inputs
           * (sort entries by name before building the string). When
           * absent or empty, the section is omitted entirely so the
           * prompt stays byte-identical for projects that have no memory
           * entries yet (preserves prefix-cache hit rate).
           */
          memorySection?: string | null;
          /**
           * Output style preamble selector. Injected right after the
           * `## Project context` block so the bulk of the prompt prefix
           * remains byte-stable. Optional: when omitted the section is
           * suppressed entirely (legacy behaviour). Stays out of the
           * prefix-cache invariant test path when absent.
           */
          outputStyle?: OutputStyle;
        },
    skills: readonly Skill[] = [],
  ): string {
    // Normalise both overloads onto a single options object.
    let localcodeMd: string | null | undefined;
    let resolvedSkills: readonly Skill[];
    let summary: string | null | undefined;
    let presetName: ModelPresetName = 'default';
    let agentsExposed = false;
    let agentTools: readonly string[] = [];
    let agentWorkerSlots: readonly { model: string; skills?: readonly string[] }[] = [];
    let agentWorkerModelFallback: string | undefined;
    let memorySection: string | undefined;
    let outputStyle: OutputStyle | undefined;
    if (
      localcodeMdOrOpts !== null &&
      typeof localcodeMdOrOpts === 'object'
    ) {
      localcodeMd = localcodeMdOrOpts.localcodeMd ?? null;
      resolvedSkills = localcodeMdOrOpts.skills ?? [];
      summary = localcodeMdOrOpts.summary ?? null;
      agentsExposed = localcodeMdOrOpts.agentsExposed === true;
      if (Array.isArray(localcodeMdOrOpts.agentTools)) {
        agentTools = localcodeMdOrOpts.agentTools;
      }
      if (Array.isArray(localcodeMdOrOpts.agentWorkerSlots)) {
        agentWorkerSlots = localcodeMdOrOpts.agentWorkerSlots;
      }
      if (typeof localcodeMdOrOpts.agentWorkerModelFallback === 'string') {
        agentWorkerModelFallback = localcodeMdOrOpts.agentWorkerModelFallback;
      }
      if (typeof localcodeMdOrOpts.memorySection === 'string' && localcodeMdOrOpts.memorySection.trim().length > 0) {
        memorySection = localcodeMdOrOpts.memorySection.trim();
      }
      if (
        typeof localcodeMdOrOpts.outputStyle === 'string' &&
        (localcodeMdOrOpts.outputStyle === 'concise' ||
          localcodeMdOrOpts.outputStyle === 'explanatory' ||
          localcodeMdOrOpts.outputStyle === 'verbose')
      ) {
        outputStyle = localcodeMdOrOpts.outputStyle;
      }
      // userLatestSnippet is intentionally read-and-discarded so
      // typed callers still type-check, but the value never reaches
      // the rendered prompt. See the JSDoc above for rationale.
      void localcodeMdOrOpts.userLatestSnippet;
      // R26 — preset selection. Explicit `preset` wins over `modelName`
      // auto-detection. Both are optional; missing means `default`.
      if (typeof localcodeMdOrOpts.preset === 'string') {
        presetName = localcodeMdOrOpts.preset;
      } else if (typeof localcodeMdOrOpts.modelName === 'string') {
        presetName = detectModelPreset(localcodeMdOrOpts.modelName);
      }
    } else {
      localcodeMd = localcodeMdOrOpts ?? null;
      resolvedSkills = skills;
      summary = null;
    }

    // R26 — Identity body comes from the selected preset. The header
    // "## Identity" itself is added here so all presets compose
    // consistently. Default preset reproduces the legacy R8/R15 body.
    const identityBody = buildPersonaForPreset(presetName);

    const parts: string[] = [
      SYSTEM_PROMPT_BASE,
      '',
      'A "[Compressed context]" message summarizes prior work — resume from there.',
      '',
      '## Identity',
      identityBody,
      // Empty-line separator suppressed; identity body has no trailing
      // newline and the next section header supplies its own.
      // Language rule sits right after Identity — early positions carry
      // the most weight; the rule was historically ignored when buried
      // lower in the prompt.
      '',
      '## Language (CRITICAL)',
      'Reply in the SAME natural language as the user (Russian → Russian, English → English, Spanish → Spanish). Code identifiers and library names keep original form; tool output is data, not a language switch. When uncertain, match the MOST RECENT user message.',
    ];

    // Prior-session summary — surfaced near the top so the model
    // immediately sees the resumed-conversation framing.
    if (typeof summary === 'string' && summary.trim().length > 0) {
      parts.push(
        '',
        '## Conversation summary (from prior sessions)',
        summary.trim(),
      );
    }

    parts.push(
      '',
      '## How you work',
      // Token-economy rewrite. Asserted phrases kept literally:
      //   "Be proactive — execute", "Read before you write",
      //   "Prefer surgical edits", "Code goes in FILES, not chat",
      //   "do NOT flatter", "trade-off", "invariant", "throwaway",
      //   "WHY", "WHAT", "self-review", "Tool-call discipline".
      '1. **Be proactive — execute** the next step; don\'t ask permission.',
      '2. **Read before you write.** read_file, list_dir, glob_search, find_symbol — never guess APIs or paths.',
      '3. **Prefer surgical edits.** edit_file for targeted changes; write_file for new files or rewrites. Code goes in FILES, not chat — confirm path and move on.',
      '4. **State the trade-off** before coding (architectural thinking); **push back** on bad ideas with reason — do NOT flatter.',
      '5. **Self-review the diff** for off-by-one, typos, swapped args; **verify invariants** with test + typecheck. No throwaway code — every line ships to production; hacks get a comment for WHY (code says WHAT).',
      '6. **Tool-call discipline.** Text OR tools, not both half-finished. Each tool_call is complete JSON; finish each call+result before the next.',
      '',
      '## Tool approval',
      'Approval: write_file, run_command, fetch_image (unless via /permissions or --dangerously-allow-all). Auto: read_file, list_dir, glob_search, edit_file, lint_file, find_symbol.',
      '',
      '## Self-configuration',
      'Config: `~/.localcode/config.toml` (global TOML) + `<projectRoot>/.localcode/settings.json` (per-project snake_case JSON, priority over global). Edit via read_file → edit_file; diff approval required — never bypass even with `--dangerously-allow-all`. Tilde (~) → $HOME.',
      'Rebuild next turn: context.maxTokens (80000 = 80K), backend.type, backend.baseUrl, model.current. Immediate: permissions.autoApprove, sound.*. Per-project: generation.temperature, top_p, repeat_penalty, max_tokens.',
      '',
      '## Images',
      'On image URL (http/https or data:image/*), call fetch_image. Vision models get base64 automatically.',
    );

    // Project context — render only when set. When absent, fall back to
    // the "suggest running /init" nudge. Legacy [PROJECT CONTEXT] marker
    // kept inside this branch so tests that assert its presence /
    // absence remain accurate.
    parts.push('', ...renderProjectContextSection(localcodeMd));

    // Output style — single-line preamble injected right after the
    // project-context block so the bulk of the prefix stays byte-stable.
    // Omitting `outputStyle` suppresses the line entirely; the prefix is
    // byte-identical to the legacy (pre-output-style) layout.
    if (outputStyle !== undefined) {
      parts.push('', OUTPUT_STYLE_PREAMBLES[outputStyle]);
    }

    // Memory — injected only when entries exist (absent = no heading at
    // all) so the prompt prefix is byte-identical for projects with no
    // memory, preserving the cache hit rate for the common case.
    if (typeof memorySection === 'string' && memorySection.trim().length > 0) {
      parts.push('', '## Memory', '[MEMORY]', memorySection.trim());
    }

    // R9 — sort active skills deterministically by id BEFORE joining.
    // The skills loader's filesystem listing order is implementation-
    // defined (and varies across reloads), so without this sort the
    // system-prompt prefix could differ byte-for-byte across two
    // semantically identical states, defeating the local-model prompt
    // cache. Sorting once here keeps the prefix stable.
    const activeSkills = resolvedSkills
      .filter((s) => s.active && s.content.trim().length > 0)
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (activeSkills.length > 0) {
      parts.push(
        '',
        '## Active skills',
        '[ACTIVE SKILLS]',
        activeSkills.map((s) => s.content.trim()).join('\n\n---\n\n')
      );
    } else {
      parts.push('', '## Active skills', '(none)');
    }

    // R9 — the trailing "## Reminder" block has been REMOVED. See the
    // JSDoc on this method and on `userLatestSnippet` for the full
    // rationale. The language-consistency rule remains anchored at
    // the TOP of the prompt under "## Language (CRITICAL)".

    // Multi-agent — append lead-orchestration section when this session
    // owns the spawn_agent tool. Pure function of inputs (the
    // availableTools list is sorted by the caller), so the prompt stays
    // byte-stable across turns when nothing changes.
    if (agentsExposed) {
      const leadOpts: Parameters<typeof buildLeadAgentPrompt>[0] = {
        availableTools: agentTools,
      };
      if (agentWorkerSlots.length > 0) {
        leadOpts.workerSlots = agentWorkerSlots;
      } else if (
        agentWorkerModelFallback !== undefined &&
        agentWorkerModelFallback.length > 0
      ) {
        leadOpts.workerModelFallback = agentWorkerModelFallback;
      }
      parts.push('', buildLeadAgentPrompt(leadOpts));
    }

    return parts.join('\n');
  }
}

/**
 * R9 — render the `## Project context` section with size-aware
 * inlining. Below `LOCALCODE_INLINE_LIMIT` we inline the document
 * as before (small docs are essentially free). Above the threshold
 * we replace the file body with a short pointer; the model can
 * fetch the full content lazily via `read_file` when it actually
 * needs it. This keeps the system-prompt prefix stable and small
 * across long-running sessions, which is the only way the local
 * model's prompt cache can pay off.
 */
function renderProjectContextSection(
  localcodeMd: string | null | undefined,
): string[] {
  if (!localcodeMd || localcodeMd.trim().length === 0) {
    return [
      '## Project context',
      'No LOCALCODE.md is configured yet. Suggest running /init to scan the project.',
    ];
  }

  const trimmed = localcodeMd.trim();
  if (trimmed.length <= LOCALCODE_INLINE_LIMIT) {
    return ['## Project context', '[PROJECT CONTEXT]', trimmed];
  }

  const charCount = trimmed.length;
  const tokenEstimate = Math.ceil(charCount / CHARS_PER_TOKEN);
  return [
    '## Project context (lazy-loaded)',
    `A LOCALCODE.md file (${charCount.toLocaleString('en-US')} chars, ~${tokenEstimate.toLocaleString('en-US')} tokens) lives at \`.localcode/LOCALCODE.md\` in the project root.`,
    'Read it with `read_file({ path: ".localcode/LOCALCODE.md" })` when you need full project context.',
    'Do NOT assume any specific architecture or conventions until you have read it.',
  ];
}

// ---------- helpers ----------

/**
 * Generate a unique-ish id for a synthetic in-memory message. Prefers
 * `crypto.randomUUID()` when available (Node 20+, Bun, browsers); else
 * falls back to a base-36 timestamp + random tail.
 */
function makeRandomId(prefix: string): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return `${prefix}-${cryptoObj.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return DEFAULT_SUMMARIZE_AT;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return p;
}

function safeLength(value: Record<string, unknown>): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * Count characters in a `Message.content` value that may be either a
 * plain string (typed, normal case) or — because of the multimodal
 * smuggling through `Message.content: string` — an array of
 * `MessageContentPart`. For `image_url` parts we count the URL
 * length; for `text` parts the raw text length. Base64 payloads
 * inflate quickly, so undercounting here would make the percent bar
 * lie.
 */
function charsInContent(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const p of content) {
      if (p === null || typeof p !== 'object') continue;
      const obj = p as { type?: unknown; text?: unknown; image_url?: unknown };
      if (obj.type === 'text' && typeof obj.text === 'string') {
        total += obj.text.length;
      } else if (obj.type === 'image_url') {
        const urlField = obj.image_url;
        if (urlField !== null && typeof urlField === 'object') {
          const url = (urlField as { url?: unknown }).url;
          if (typeof url === 'string') total += url.length;
        }
      }
    }
    return total;
  }
  return 0;
}

/**
 * Render a compact USER/ASSISTANT/TOOL transcript suitable for feeding
 * to a summariser. Produces stable output so downstream prompt caches
 * can hit on identical histories.
 *
 * The instruction header is baked in so callers don't have to duplicate
 * it — just pass the resulting string straight to the LLM as user
 * content.
 */
export function buildSummaryPrompt(messages: readonly Message[]): string {
  const header = [
    'Summarize the conversation below for future reference. Focus on: intent, key decisions, files touched, unresolved issues. Keep under 500 tokens.',
    '',
    '---',
    '',
  ].join('\n');

  const lines: string[] = [];
  for (const m of messages) {
    const tag = roleTag(m);
    const body = contentForPrompt(m);
    if (body.length === 0) continue;
    lines.push(`${tag}: ${body}`);
  }
  return header + lines.join('\n');
}

function roleTag(m: Message): string {
  switch (m.role) {
    case 'user':
      return 'USER';
    case 'assistant':
      return 'ASSISTANT';
    case 'tool':
      return m.toolName ? `TOOL(${m.toolName})` : 'TOOL';
    case 'system':
      return 'SYSTEM';
  }
}

function contentForPrompt(m: Message): string {
  // `Message.content` is typed as string, but `buildImageMessage` may
  // smuggle an array in. Render a short placeholder in that case — the
  // summariser doesn't need the base64 bytes.
  const raw: unknown = m.content;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : '';
  }
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const p of raw) {
      if (p !== null && typeof p === 'object') {
        const obj = p as { type?: unknown; text?: unknown };
        if (obj.type === 'text' && typeof obj.text === 'string') {
          parts.push(obj.text);
        } else if (obj.type === 'image_url') {
          parts.push('[image]');
        }
      }
    }
    return parts.join(' ').trim();
  }
  return '';
}

// ---------- /compress prompt builder ----------

/**
 * Build the user prompt fed to the summariser by `/compress`
 * (FIX #34). Designed for high-compression but lossless-of-intent
 * summaries: the model is told what to keep (goal, decisions, files,
 * blockers) and what to drop (verbatim quotes, full code blocks).
 *
 * Each message is prefixed with a single-letter role tag — kept short
 * so a long history fits in the prompt window — and tool messages
 * include the tool name plus the first 200 chars of their content
 * (typically diff snippets, file contents). System messages are
 * trimmed to 100 chars (most of the body is boilerplate persona).
 */
/**
 * R16 (Agent 8) — build the user-prompt for the auto-summarise-on-exit
 * flow. This is intentionally DIFFERENT from {@link buildCompressPrompt}
 * (which produces a longer "lossless-of-intent" handoff summary for
 * `/compress` and resume-context re-injection).
 *
 * The output of this prompt is fed to the model and the resulting
 * one-or-two-sentence summary is persisted onto `Session.summary`.
 * That string is shown in the `/resume` overlay's preview row beside
 * each session, so its job is to tell the user — at a glance — what
 * they were working on. Keep it tight: 100-200 chars, no preamble,
 * no labels, no bullets.
 *
 * Only the trailing 30 messages are rendered (older context is
 * already part of the conversation summary if compression has run);
 * user messages are truncated to 300 chars and assistant messages to
 * 200 chars to fit a long history into the request without blowing the
 * context window for cheap local models.
 */
export function buildPreviewSummaryPrompt(messages: readonly Message[]): string {
  const lines = messages
    .slice(-30)
    .map((m) => {
      const raw = typeof m.content === 'string' ? m.content : '';
      if (m.role === 'user') return `U: ${raw.slice(0, 300)}`;
      if (m.role === 'assistant') return `A: ${raw.slice(0, 200)}`;
      return null;
    })
    .filter((line): line is string => line !== null)
    .join('\n');

  return [
    'Produce a SHORT 1-2 sentence summary of this conversation suitable for a session-list preview.',
    'Focus on what the user was trying to do (NOT what the assistant said or did).',
    '100-200 chars. NO preamble, NO labels — just the sentence.',
    '',
    'Example: "Refactoring user authentication to use JWT instead of session cookies; debugging cookie domain mismatch."',
    '',
    'Conversation:',
    lines,
  ].join('\n');
}

/**
 * R26 (Agent A) — collapse old tool-role messages so only the most
 * recent {@link keepLast} of them survive verbatim in the prompt sent
 * to the LLM. Pure function — does NOT mutate the input array; returns
 * a new array with the same length but with old tool messages
 * substituted for short stubs.
 *
 * Stub format:
 *   `[tool: <toolName>(<short-args>) → <origLen> bytes collapsed; re-call to view]`
 *
 * Where `<short-args>` is the message's own `toolCallId` (if present)
 * or a literal `?` placeholder. We deliberately do NOT include the
 * full original arguments here because the calling site doesn't have
 * them — the original arguments live on the *assistant* message that
 * issued the call. The stub's purpose is to remind the model that the
 * call happened and tell it how to recover the full content (re-call
 * the tool). 40-60% token saving on long sessions.
 *
 * Why "tool-role only" and not also assistant tool-call payloads:
 *   - Assistant `toolCalls` payloads are tiny by design — typically a
 *     few hundred bytes per call. Trimming them gains little.
 *   - Tool-role result messages are where the bulk lives — `read_file`
 *     can return 50KB, `run_command` can return arbitrary stdout.
 *
 * Edge cases:
 *   - `keepLast <= 0` → all tool messages collapsed.
 *   - `keepLast >= total tool messages` → no collapse.
 *   - Non-tool messages (`user`, `assistant`, `system`) pass through
 *     unchanged.
 *   - A tool message whose content is already shorter than the stub
 *     is collapsed anyway — keeps the rule predictable; the cost of
 *     a 50-byte vs 80-byte stub is irrelevant in practice.
 *
 * Determinism: the function inspects only the input messages — same
 * input always yields the same output. Useful for prompt-cache
 * stability when the conversation tail is stable.
 */
export function trimOldToolResults(
  messages: readonly Message[],
  keepLast: number = DEFAULT_TRIM_TOOL_RESULTS_AFTER,
): Message[] {
  if (messages.length === 0) return [];

  // Two-pass: count tool messages first so we know which indices to
  // keep verbatim and which to collapse. Single pass would either
  // require iterating in reverse (messy with role checks) or buffering
  // all tool indices upfront (same big-O as two passes anyway).
  const keep = Math.max(0, Math.floor(keepLast));
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg && msg.role === 'tool') toolIndices.push(i);
  }

  if (toolIndices.length <= keep) {
    // Nothing to collapse — return a shallow copy so callers get a
    // fresh array (matches the contract of `getMessages`).
    return messages.slice();
  }

  // Indices that survive verbatim are the LAST `keep` tool indices.
  const collapseUntil = toolIndices[toolIndices.length - keep] ?? toolIndices[0];
  const survivors = new Set<number>();
  for (let i = toolIndices.length - keep; i < toolIndices.length; i += 1) {
    const idx = toolIndices[i];
    if (typeof idx === 'number') survivors.add(idx);
  }
  // `collapseUntil` is intentionally read for the curious reader; the
  // actual decision logic is the survivors set.
  void collapseUntil;

  const out: Message[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== 'tool' || survivors.has(i)) {
      out[i] = msg;
      continue;
    }
    out[i] = collapseToolMessage(msg);
  }
  return out;
}

/**
 * Build the collapse stub for a tool-role message. Extracted so the
 * format is in one place and the cost-of-stub is computed once.
 */
function collapseToolMessage(msg: Message): Message {
  const toolName = typeof msg.toolName === 'string' && msg.toolName.length > 0
    ? msg.toolName
    : 'unknown';
  // Use `toolCallId` as the short-args descriptor — it's stable and
  // non-arbitrary. If the message has no callId (synthetic auto-lint
  // notices, manual injects), fall back to `?` so the stub still makes
  // sense to the model.
  const shortArgs = typeof msg.toolCallId === 'string' && msg.toolCallId.length > 0
    ? msg.toolCallId
    : '?';
  const rawContent = typeof msg.content === 'string' ? msg.content : '';
  const origLen = rawContent.length;
  const stub = `[tool: ${toolName}(${shortArgs}) → ${origLen} bytes collapsed; re-call to view]`;
  return {
    ...msg,
    content: stub,
  };
}

/**
 * Apply a "last-N-messages sliding window" to a chat history before
 * sending it to the LLM. Long vibe-coding sessions accumulate hundreds
 * of messages — the bulk of the prompt budget burns on stale chatter
 * that the model rarely needs. This helper keeps:
 *
 *   - every `system`-role message (typically just the leading one);
 *   - any synthetic `[Compressed context]` summary message produced by
 *     `/compress` (recognised by content-prefix on user OR assistant
 *     role — `cmd-compress` wraps it as an assistant message but
 *     manual injects sometimes use a user role);
 *   - the LAST `maxRecent` non-pinned messages, sliced on ROUND
 *     BOUNDARIES so we never strand a `tool` message at the head of
 *     the slice with no preceding `assistant.tool_calls`. A "round"
 *     starts on a `user` message and includes everything up to (but
 *     not including) the next `user`. This guarantees the slice
 *     ALWAYS opens with `user` — never a leftover tool reply whose
 *     caller assistant just got sliced off.
 *
 * The middle is dropped. Cross-cut tool-call pairing is also repaired
 * defensively by `sanitiseToolCallPairing` in `src/llm/adapter.ts`,
 * but the round-boundary slice ensures we don't rely on that for
 * correctness — DeepSeek (and other strict OpenAI-compatible
 * providers) reject an orphan tool message before sanitiser runs in
 * some upstream paths.
 *
 * Edge cases:
 *   - `maxRecent <= 0` → return a shallow copy unchanged (window
 *     disabled).
 *   - `messages.length <= maxRecent + 2` → return as-is (small history;
 *     +2 covers the cost of pinning a system + summary message).
 *   - Empty input → empty output.
 *   - A single round larger than `maxRecent` → keep the round whole.
 *     We never cut mid-round; better to spill over the budget by a
 *     few messages than to send an invalid wire payload.
 *
 * Pure: no mutation of the input array; deterministic for stable
 * prompt-cache behaviour.
 *
 * NOTE: TUI-side `app.tsx` should adopt this helper too — sliding
 * window is currently wired only in the web `ChatRuntime`. Move the
 * call into the shared turn-prep path when refactoring.
 */
export function applyRecentWindow(
  messages: readonly Message[],
  maxRecent: number,
): Message[] {
  if (messages.length === 0) return [];
  if (!Number.isFinite(maxRecent) || maxRecent <= 0) return messages.slice();
  const cap = Math.floor(maxRecent);
  // +2 slack so we don't slice a history that's only marginally larger
  // than the cap — the savings would be negligible and the risk of
  // surprise is real.
  if (messages.length <= cap + 2) return messages.slice();

  // ---- Identify pinned indices (system + compressed-context summary).
  // COMPRESS-STRATEGY-SECTION — the new strategy-aware compressor in
  // `cmd-compress.ts` emits an `[auto-compressed summary]` marker for
  // its summarise + truncate paths (the dedup path leaves the array
  // shape unchanged so no new marker fires). Pin both prefixes so the
  // sliding-window slicer below preserves them on every turn.
  const pinnedIdx = new Set<number>();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'system') {
      pinnedIdx.add(i);
      continue;
    }
    const content = typeof m.content === 'string' ? m.content : '';
    if (
      content.startsWith('[Compressed context]') ||
      content.startsWith('[auto-compressed summary]')
    ) {
      pinnedIdx.add(i);
    }
  }
  // COMPRESS-STRATEGY-SECTION-END

  // ---- Find non-pinned `user`-message indices. Each is the start
  // of a round. The list is in ascending order.
  const roundStarts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (pinnedIdx.has(i)) continue;
    const m = messages[i];
    if (m && m.role === 'user') roundStarts.push(i);
  }

  // No user messages in the unpinned region → nothing reasonable to
  // slice on. Fall back to keeping pinned + entire tail (defensive;
  // unlikely in practice since every real conversation opens with a
  // user message).
  if (roundStarts.length === 0) return messages.slice();

  // ---- Walk round starts from the END, accumulating message counts
  // until we either match/exceed `cap` or run out of rounds. Each
  // round spans from `roundStarts[k]` to (`roundStarts[k+1]` - 1) for
  // k < last, and to `messages.length - 1` for the final round.
  // Pinned indices inside a round don't count against the unpinned
  // budget.
  const totalLen = messages.length;
  let chosenStart = roundStarts[roundStarts.length - 1];
  if (chosenStart === undefined) return messages.slice();
  let runningCount = 0;
  for (let k = roundStarts.length - 1; k >= 0; k -= 1) {
    const s = roundStarts[k];
    if (s === undefined) continue;
    const next = k + 1 < roundStarts.length ? roundStarts[k + 1] : undefined;
    const end = next !== undefined ? next : totalLen;
    let unpinnedInRound = 0;
    for (let j = s; j < end; j += 1) {
      if (!pinnedIdx.has(j)) unpinnedInRound += 1;
    }
    if (runningCount > 0 && runningCount + unpinnedInRound > cap) {
      // Adding this round would overshoot — stop, keep the rounds
      // already accumulated.
      break;
    }
    chosenStart = s;
    runningCount += unpinnedInRound;
    if (runningCount >= cap) break;
  }

  // ---- Build the output: pinned messages (in original order) +
  // every message at index >= chosenStart. A pinned message inside the
  // tail (uncommon) is included once — not duplicated.
  const tailIdx = new Set<number>();
  for (let i = chosenStart; i < totalLen; i += 1) tailIdx.add(i);

  const out: Message[] = [];
  for (let i = 0; i < totalLen; i += 1) {
    if (pinnedIdx.has(i) || tailIdx.has(i)) {
      const m = messages[i];
      if (m) out.push(m);
    }
  }
  return out;
}

export function buildCompressPrompt(messages: Message[]): string {
  const lines = messages
    .map((m) => {
      const raw = typeof m.content === 'string' ? m.content : '';
      if (m.role === 'user') return `U: ${raw}`;
      if (m.role === 'assistant') return `A: ${raw}`;
      if (m.role === 'tool') {
        const tool = m.toolName ?? '?';
        return `T(${tool}): ${raw.slice(0, 200)}`;
      }
      if (m.role === 'system') return `S: ${raw.slice(0, 100)}`;
      return `?: ${raw}`;
    })
    .join('\n');

  return [
    'Produce a HIGH-COMPRESSION summary of the conversation below.',
    'Focus on:',
    "  1. The user's overall goal/intent.",
    '  2. Key decisions and trade-offs made.',
    '  3. Files touched (path + brief description of change).',
    '  4. Code patterns or libraries introduced.',
    '  5. Open work, blockers, and TODOs.',
    'Output ONE dense paragraph or short bulleted list. Aim for ≤500 tokens.',
    'Prioritize info that lets a future model continue this work without missing important context.',
    'Do NOT include verbatim user messages or full code blocks; describe them concisely.',
    '',
    '--- Conversation ---',
    lines,
    '--- End ---',
  ].join('\n');
}
