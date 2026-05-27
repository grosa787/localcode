/**
 * Compression strategy selector.
 *
 * Three strategies, ordered by aggressiveness / cost:
 *
 *   1. `dedup`     — collapse repeated `read_file` results (cheapest, no
 *                   LLM call). Preserves mutating-tool history verbatim.
 *                   Always safe to try first.
 *   2. `summarize` — split history into head + middle + tail; ask the
 *                   cheapest available model in the current backend to
 *                   summarise the middle; replace it with a single
 *                   `[auto-compressed summary]` system message.
 *   3. `truncate`  — fallback when no cheap model is available; drop
 *                   the middle entirely and keep head + last 30.
 *
 * The selector is a pure function over (`backend`, message-list shape,
 * dedup-savings-estimate). The actual `summarize` call requires an LLM
 * adapter callback the caller injects — kept narrow so tests can stub.
 */

import type { Backend, Message } from '@/types/global';
import { dedupReadResults, isMutatingTool } from '@/llm/semantic-dedup';

/** Token estimator — kept in sync with `context-manager.ts`. */
const CHARS_PER_TOKEN = 4;

export type CompressStrategyName = 'dedup' | 'summarize' | 'truncate';

/**
 * Number of messages reserved on the head (system + first
 * user/assistant exchange). Tuned so the model still sees the original
 * intent + initial framing after a heavy summarise pass.
 */
export const HEAD_KEEP = 6;
/** Number of messages reserved on the tail when summarising. */
export const SUMMARIZE_TAIL_KEEP = 10;
/**
 * Minimum middle-section size that justifies a summarise call. Below
 * this we either skip (savings too small) or fall back to dedup. The
 * task brief calls for >100 messages; we use that exact threshold.
 */
export const SUMMARIZE_MIDDLE_MIN = 100;
/**
 * Tail kept when truncating (no summarise available). Larger than
 * `SUMMARIZE_TAIL_KEEP` because we have no summary to anchor older
 * context — the tail is all the model has.
 */
export const TRUNCATE_TAIL_KEEP = 30;

/**
 * Per-backend cheapest model id used for summary calls. Mapped to
 * widely-available official names; resolveCheapModel() looks them up
 * with sensible fallbacks.
 *
 *   - openai     → `gpt-4o-mini`
 *   - openrouter → `openai/gpt-4o-mini` (routes via the same backbone)
 *   - anthropic  → `claude-3-5-haiku-latest`
 *   - google     → `gemini-1.5-flash`
 *
 * Local providers (ollama, lmstudio, custom) have no canonical "cheap"
 * tier; the selector falls back to `truncate` for them.
 */
export const CHEAP_MODEL_BY_BACKEND: Readonly<Record<Backend, string | null>> =
  {
    openai: 'gpt-4o-mini',
    openrouter: 'openai/gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-latest',
    google: 'gemini-1.5-flash',
    ollama: null,
    lmstudio: null,
    custom: null,
  };

/**
 * Look up the cheap model id for a backend, or null when no
 * cheap-tier model is available (local providers).
 */
export function resolveCheapModel(backend: Backend): string | null {
  return CHEAP_MODEL_BY_BACKEND[backend] ?? null;
}

export interface ChooseStrategyArgs {
  backend: Backend;
  messages: readonly Message[];
  /**
   * Optional savings estimate from a prior `dedupReadResults` call.
   * When supplied and ≥ {@link DEDUP_USEFUL_SAVINGS_TOKENS}, the
   * selector prefers `dedup` even if the middle would be eligible
   * for summarise.
   */
  dedupSavingsTokens?: number;
}

/**
 * Minimum token savings to justify staying on the cheap `dedup`
 * strategy. Below this, prefer summarise/truncate (we want a meaningful
 * compression, not a rounding-error one).
 */
export const DEDUP_USEFUL_SAVINGS_TOKENS = 200;

/**
 * Pure decision function. No I/O, no LLM call. Picks the strategy
 * for the next compression pass given the backend + current history
 * shape.
 *
 * Decision matrix (in order):
 *   1. If dedup would save ≥ 200 tokens → `dedup`.
 *   2. Else if message middle ≥ 100 AND backend has a cheap model
 *      → `summarize`.
 *   3. Else if message middle ≥ 100 (no cheap model) → `truncate`.
 *   4. Else → `dedup` (no-op-ish; safest cheap strategy).
 *
 * The middle is defined as `messages.length - HEAD_KEEP -
 * SUMMARIZE_TAIL_KEEP`; below zero it's treated as 0.
 */
export function chooseCompressStrategy(
  args: ChooseStrategyArgs,
): CompressStrategyName {
  const { backend, messages } = args;
  const total = messages.length;
  const middle = Math.max(0, total - HEAD_KEEP - SUMMARIZE_TAIL_KEEP);

  const dedupSavings = Math.max(0, Math.floor(args.dedupSavingsTokens ?? 0));
  if (dedupSavings >= DEDUP_USEFUL_SAVINGS_TOKENS) return 'dedup';

  if (middle >= SUMMARIZE_MIDDLE_MIN) {
    if (resolveCheapModel(backend) !== null) return 'summarize';
    return 'truncate';
  }

  return 'dedup';
}

/**
 * Strategy executor — given a chosen strategy, produce a new message
 * list. `summarize` is async because it calls the LLM via the injected
 * summariser. `dedup` and `truncate` are pure.
 *
 * The returned `outMessages` array is what the caller should hand to
 * `ContextManager.replaceAll` (or the equivalent commit path). Token
 * accounting is best-effort using the standard 4-chars-per-token
 * estimator.
 */
export interface ApplyStrategyArgs {
  strategy: CompressStrategyName;
  messages: readonly Message[];
  /**
   * Cheap-model summariser. Required for `summarize`; ignored
   * otherwise. Must return the summary text. The caller is
   * responsible for routing through `LLMAdapter.streamChat` with the
   * cheap model id (see {@link resolveCheapModel}).
   */
  summarize?: (messages: readonly Message[]) => Promise<string>;
}

export interface ApplyStrategyResult {
  messages: Message[];
  removedTokens: number;
  /** Strategy actually executed (may differ from input on fallback). */
  applied: CompressStrategyName;
  /** Optional summary text generated by the `summarize` strategy. */
  summary?: string;
}

export async function applyCompressStrategy(
  args: ApplyStrategyArgs,
): Promise<ApplyStrategyResult> {
  const { strategy, messages } = args;

  if (strategy === 'dedup') {
    const r = dedupReadResults(messages);
    return {
      messages: r.messages,
      removedTokens: r.removedTokens,
      applied: 'dedup',
    };
  }

  if (strategy === 'summarize') {
    if (typeof args.summarize !== 'function') {
      // Defensive fallback: caller asked for summarise but didn't
      // wire the summariser. Drop to truncate so we still make
      // progress instead of returning the unchanged list.
      return truncateStrategy(messages);
    }
    return summarizeStrategy(messages, args.summarize);
  }

  // strategy === 'truncate'
  return truncateStrategy(messages);
}

/**
 * Build the head+middle+tail split. Mutating-tool results inside the
 * middle are PROMOTED into the kept set (they must survive verbatim
 * per the task contract). The summary spans only NON-mutating middle
 * messages, but the kept array reinserts the promoted ones at their
 * original positions relative to the surviving tail.
 */
interface Split {
  head: Message[];
  middle: Message[];
  tail: Message[];
  /**
   * Promoted (mutating-tool) messages from the middle, in original
   * order. Reinserted between head and summary so the model still sees
   * its prior write/edit history.
   */
  promoted: Message[];
}

function splitForSummarize(
  messages: readonly Message[],
  tailKeep: number,
): Split {
  const total = messages.length;
  const headEnd = Math.min(HEAD_KEEP, total);
  const tailStart = Math.max(headEnd, total - tailKeep);

  const head: Message[] = [];
  for (let i = 0; i < headEnd; i += 1) {
    const m = messages[i];
    if (m) head.push(m);
  }

  const middle: Message[] = [];
  const promoted: Message[] = [];
  for (let i = headEnd; i < tailStart; i += 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'tool' && isMutatingTool(m.toolName)) {
      promoted.push(m);
      continue;
    }
    // Assistant messages that issued a mutating tool_call are also
    // promoted so the call+result pair stays grouped — the wire-
    // payload validator in the adapter requires both halves to ride
    // together.
    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      const hasMutating = m.toolCalls.some((c) => isMutatingTool(c.name));
      if (hasMutating) {
        promoted.push(m);
        continue;
      }
    }
    middle.push(m);
  }

  const tail: Message[] = [];
  for (let i = tailStart; i < total; i += 1) {
    const m = messages[i];
    if (m) tail.push(m);
  }

  return { head, middle, tail, promoted };
}

/**
 * Summary marker — recognised by `applyRecentWindow` in
 * `context-manager.ts` (pinned alongside `[Compressed context]`
 * markers). We deliberately use a distinct prefix so the two
 * compression paths don't shadow each other in logs.
 */
export const SUMMARY_MARKER = '[auto-compressed summary]';

async function summarizeStrategy(
  messages: readonly Message[],
  summarizer: (messages: readonly Message[]) => Promise<string>,
): Promise<ApplyStrategyResult> {
  const split = splitForSummarize(messages, SUMMARIZE_TAIL_KEEP);

  // Nothing useful to summarise — return unchanged.
  if (split.middle.length === 0) {
    return {
      messages: messages.slice(),
      removedTokens: 0,
      applied: 'summarize',
    };
  }

  let summary: string;
  try {
    summary = (await summarizer(split.middle)).trim();
  } catch {
    // Summariser failed — fall back to truncate so we still make
    // forward progress. Avoids the user being stuck at 100% context.
    return truncateStrategy(messages);
  }

  if (summary.length === 0) {
    return truncateStrategy(messages);
  }

  const beforeChars = approxChars(messages);

  const now = Date.now();
  const summaryMsg: Message = {
    id: `compress-summary-${now.toString(36)}`,
    role: 'system',
    content: `${SUMMARY_MARKER}\n\n${summary}`,
    createdAt: now,
  };

  const out: Message[] = [
    ...split.head,
    ...split.promoted,
    summaryMsg,
    ...split.tail,
  ];

  const afterChars = approxChars(out);
  const removedTokens = Math.max(
    0,
    Math.ceil((beforeChars - afterChars) / CHARS_PER_TOKEN),
  );

  return {
    messages: out,
    removedTokens,
    applied: 'summarize',
    summary,
  };
}

function truncateStrategy(messages: readonly Message[]): ApplyStrategyResult {
  const total = messages.length;
  if (total <= HEAD_KEEP + TRUNCATE_TAIL_KEEP) {
    return {
      messages: messages.slice(),
      removedTokens: 0,
      applied: 'truncate',
    };
  }

  const headEnd = Math.min(HEAD_KEEP, total);
  const tailStart = Math.max(headEnd, total - TRUNCATE_TAIL_KEEP);

  const head: Message[] = [];
  for (let i = 0; i < headEnd; i += 1) {
    const m = messages[i];
    if (m) head.push(m);
  }

  // Promote mutating-tool messages from the dropped middle (same
  // contract as summarise: they must survive verbatim).
  const promoted: Message[] = [];
  for (let i = headEnd; i < tailStart; i += 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'tool' && isMutatingTool(m.toolName)) {
      promoted.push(m);
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      const hasMutating = m.toolCalls.some((c) => isMutatingTool(c.name));
      if (hasMutating) promoted.push(m);
    }
  }

  const tail: Message[] = [];
  for (let i = tailStart; i < total; i += 1) {
    const m = messages[i];
    if (m) tail.push(m);
  }

  const beforeChars = approxChars(messages);
  const out: Message[] = [...head, ...promoted, ...tail];
  const afterChars = approxChars(out);
  const removedTokens = Math.max(
    0,
    Math.ceil((beforeChars - afterChars) / CHARS_PER_TOKEN),
  );

  return {
    messages: out,
    removedTokens,
    applied: 'truncate',
  };
}

function approxChars(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') total += m.content.length;
    total += m.role.length;
    if (m.toolName) total += m.toolName.length;
    if (Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) {
        total += c.name.length;
        try {
          total += JSON.stringify(c.arguments).length;
        } catch {
          /* unstringifiable — skip */
        }
      }
    }
  }
  return total;
}
