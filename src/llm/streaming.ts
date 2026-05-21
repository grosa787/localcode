/**
 * SSE (Server-Sent Events) parsing utilities for the OpenAI-compatible
 * Chat Completions streaming protocol.
 *
 * The wire format is a sequence of frames separated by a blank line. Each
 * frame is one or more `data: <payload>` lines (optionally preceded by
 * event fields like `event:` or `id:` which we ignore for chat completions).
 *
 * Payload semantics:
 *   - `data: [DONE]`     → stream finished, no more chunks
 *   - `data: {json...}`  → one `ChatCompletionChunk`
 *   - empty / comment    → heartbeat / keep-alive, ignored
 *
 * Also exports `HarmonyFilter` — a stateful stripper that removes the
 * `<|channel|>…<|message|>` control tokens some open-weights models (notably
 * the Harmony family / GPT-OSS) leak into their stream output. The filter
 * is designed to survive arbitrary chunk boundaries without ever swallowing
 * legitimate text.
 */

import { z } from 'zod';
import type {
  ChatCompletionChoiceDelta,
  ChatCompletionChunk,
  SSEChunk,
  ToolCallDelta,
} from '@/types/message';

// ---------- Zod schemas for runtime validation ----------

const toolCallDeltaSchema: z.ZodType<ToolCallDelta> = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

const choiceDeltaSchema: z.ZodType<ChatCompletionChoiceDelta> = z.object({
  index: z.number().int().nonnegative(),
  delta: z.object({
    role: z.enum(['assistant', 'user', 'system', 'tool']).optional(),
    content: z.string().nullable().optional(),
    tool_calls: z.array(toolCallDeltaSchema).optional(),
  }),
  finish_reason: z.string().nullable().optional(),
});

const usageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    // Ollama native fields (some versions surface these alongside the
    // OpenAI-shaped payload).
    prompt_eval_count: z.number().optional(),
    eval_count: z.number().optional(),
  })
  .passthrough()
  .nullish();

const chatCompletionChunkSchema: z.ZodType<ChatCompletionChunk> = z.object({
  id: z.string().optional(),
  object: z.string().optional(),
  created: z.number().optional(),
  model: z.string().optional(),
  // OpenAI allows `choices` to be an empty array on the final usage-only
  // chunk — don't require a minimum length.
  choices: z.array(choiceDeltaSchema),
  usage: usageSchema,
}) as unknown as z.ZodType<ChatCompletionChunk>;

// ---------- Parsers ----------

/**
 * Parse a single SSE frame (one or more lines, separated by newlines).
 *
 * Returns:
 *   - `{ kind: 'done' }` when the frame is `data: [DONE]`
 *   - `{ kind: 'data', payload }` when the frame carries a chat chunk
 *   - `{ kind: 'heartbeat' }` for empty frames, comments, or non-data events
 *   - `null` when the frame is malformed or fails schema validation
 */
export function parseSSEChunk(raw: string): SSEChunk | null {
  if (raw.length === 0) {
    return { kind: 'heartbeat' };
  }

  const lines = raw.split('\n');
  const dataParts: string[] = [];

  for (const rawLine of lines) {
    // Strip a trailing CR (handles CRLF without mangling mid-string content).
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line.length === 0) continue;
    if (line.startsWith(':')) continue; // SSE comment / keep-alive

    if (line.startsWith('data:')) {
      // Per spec, a single leading space after the colon is trimmed.
      const value = line.slice(5).replace(/^ /, '');
      dataParts.push(value);
      continue;
    }

    // Other SSE fields (event:, id:, retry:) are not used by OpenAI chat
    // completions — skip them silently.
  }

  if (dataParts.length === 0) {
    return { kind: 'heartbeat' };
  }

  // Multi-line data values are joined with a single "\n" per the SSE spec.
  const joined = dataParts.join('\n');

  if (joined.trim() === '[DONE]') {
    return { kind: 'done' };
  }

  // Heartbeat shapes that some servers (notably LM Studio) emit between
  // real chunks while the model is busy:
  //   - `data: `       → empty payload, joined === '' (or pure whitespace)
  //   - `data: {}`     → empty JSON object, no `choices` field
  // These are NOT real chunks; if we treated them as malformed (returning
  // `null`), the adapter loop would still see them as "frames arrived"
  // but parseSSEChunk would yield no `kind`. Returning `heartbeat`
  // explicitly lets the adapter distinguish between "alive but idle"
  // and "actually delivering content" — important for the stricter
  // stall-detector in `streamChat`.
  if (joined.trim().length === 0) {
    return { kind: 'heartbeat' };
  }

  let json: unknown;
  try {
    json = JSON.parse(joined);
  } catch {
    return null;
  }

  // Empty-object heartbeat: `data: {}` with no choices/usage. We
  // recognise it as alive-but-idle rather than a malformed chunk.
  if (
    typeof json === 'object' &&
    json !== null &&
    !Array.isArray(json) &&
    Object.keys(json as Record<string, unknown>).length === 0
  ) {
    return { kind: 'heartbeat' };
  }

  const parsed = chatCompletionChunkSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  return { kind: 'data', payload: parsed.data };
}

/**
 * Split a raw stream buffer into complete SSE frames plus a residual
 * tail (which may contain the start of the next, still-incomplete frame).
 *
 * A frame boundary is any blank line (`\n\n`, `\r\n\r\n`, or `\r\r`).
 */
export function splitSSEFrames(buffer: string): {
  frames: string[];
  rest: string;
} {
  const frames: string[] = [];
  let rest = buffer;

  // Normalise CRLF → LF for frame-splitting only.
  const normalised = rest.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const parts = normalised.split(/\n\n/);
  // If the original buffer doesn't end with a blank line, the final part
  // is incomplete and should be carried over to the next read.
  const isComplete = /\n\n$/.test(normalised);

  const completeParts = isComplete ? parts : parts.slice(0, -1);
  const tail = isComplete ? '' : (parts[parts.length - 1] ?? '');

  for (const part of completeParts) {
    if (part.length > 0) frames.push(part);
  }
  rest = tail;

  return { frames, rest };
}

// ---------- Harmony filter ----------

/**
 * Harmony / GPT-OSS style models leak control tokens into their text
 * stream. The canonical form has matching pipes on both sides
 * (`<|channel|>`, `<|message|>`, `<|start|>`, `<|end|>`, `<|return|>`,
 * `<|constrain|>`) but in practice the model also emits asymmetric
 * variants where one or both pipes are missing:
 *   `<|channel>`, `<channel|>`, `<channel>`, etc.
 *
 * The keywords are uncommon enough as bare-word HTML tags that we treat
 * any `<[|]?(channel|message|start|end|return|constrain)[|]?>` as a
 * Harmony control token and strip it.
 */
const HARMONY_KEYWORDS = ['channel', 'message', 'start', 'end', 'return', 'constrain'] as const;

/**
 * Matches a single Harmony control token in any of its four asymmetric
 * forms. Anchored case-insensitively. Used in two places:
 *   1. Find the earliest token in the buffer (regex.exec from index 0).
 *   2. Test whether a fully-resolved token at a specific position is a
 *      channel-open / message-close.
 *
 * IMPORTANT: this regex is built fresh inside helpers so its `lastIndex`
 * never leaks across invocations.
 */
function buildTokenRegex(): RegExp {
  return new RegExp(`<\\|?(?:${HARMONY_KEYWORDS.join('|')})\\|?>`, 'gi');
}

/**
 * Match an optional channel label that immediately follows a stripped
 * channel-open token (e.g. `<|channel>thought` → also strip `thought`).
 * The Harmony spec defines a closed set of label keywords plus the
 * `to=<recipient>` form for tool-routed messages.
 */
const HARMONY_CHANNEL_LABEL = /^[ \t]*(?:thought|final|analysis|commentary|to=[^\s<]+)/i;

/**
 * Maximum length of the longest possible Harmony token. The longest
 * canonical form is `<|constrain|>` at 13 chars; allow a little slack
 * to cover any future variants. This is the safety margin used when
 * deciding whether a trailing buffer might still grow into a token.
 */
const HARMONY_MAX_TOKEN_LEN = 16;

/**
 * When we see a `<|channel|>` opener in canonical form we wait for the
 * matching `<|message...>` closer. If the gap exceeds this many
 * characters we give up and surface the buffered text so we never
 * silently swallow a large amount of legitimate output.
 */
const HARMONY_CHANNEL_MAX_SPAN = 256;

/**
 * Result of matching a Harmony token against the buffer.
 */
type TokenMatch = {
  /** Index into the buffer where the token starts. */
  index: number;
  /** Length of the matched token (e.g. 11 for `<|channel|>`). */
  length: number;
  /** Lower-cased keyword inside the token (e.g. `channel`). */
  keyword: (typeof HARMONY_KEYWORDS)[number];
  /** True iff both pipes are present (canonical form `<|kw|>`). */
  canonical: boolean;
};

/**
 * Locate the earliest Harmony control token in `buffer`, in any of its
 * four pipe-asymmetric forms. Returns `null` if no complete token is
 * present.
 */
function findEarliestHarmonyToken(buffer: string): TokenMatch | null {
  const re = buildTokenRegex();
  const m = re.exec(buffer);
  if (!m) return null;
  const text = m[0];
  // Extract the keyword between the optional `<|` / `<` opener and the
  // optional `|>` / `>` closer. Easier to do with a second regex than to
  // unpack the alternation match.
  const inner = text.replace(/^<\|?/, '').replace(/\|?>$/, '').toLowerCase();
  const canonical = text.startsWith('<|') && text.endsWith('|>');
  return {
    index: m.index,
    length: text.length,
    keyword: inner as (typeof HARMONY_KEYWORDS)[number],
    canonical,
  };
}

/**
 * Locate the earliest Harmony token (any keyword, any pipe asymmetry)
 * starting at or after `from`. Used to scan for the closing
 * `<|message...>` (or any other token that should terminate a channel
 * block) when we're inside a channel block.
 */
function findHarmonyTokenFrom(
  buffer: string,
  from: number,
): TokenMatch | null {
  if (from >= buffer.length) return null;
  const re = buildTokenRegex();
  re.lastIndex = from;
  const m = re.exec(buffer);
  if (!m) return null;
  const text = m[0];
  const inner = text.replace(/^<\|?/, '').replace(/\|?>$/, '').toLowerCase();
  const canonical = text.startsWith('<|') && text.endsWith('|>');
  return {
    index: m.index,
    length: text.length,
    keyword: inner as (typeof HARMONY_KEYWORDS)[number],
    canonical,
  };
}

/**
 * Strip an optional channel label that immediately follows a
 * just-consumed channel-open token. Returns the buffer slice with any
 * matching label removed from the start, plus the number of consumed
 * label characters. Whitespace between the token and label is consumed
 * along with the label so spacing reads correctly afterwards.
 */
function consumeChannelLabel(text: string): { rest: string; consumed: number } {
  const m = HARMONY_CHANNEL_LABEL.exec(text);
  if (!m) return { rest: text, consumed: 0 };
  return { rest: text.slice(m[0].length), consumed: m[0].length };
}

/**
 * Incremental stripper for Harmony control tokens across chunk boundaries.
 *
 * Usage:
 *   const filter = new HarmonyFilter();
 *   for each streamed delta t: emit(filter.push(t));
 *   emit(filter.flush()); // final drain
 *
 * Guarantees:
 *   - Canonical paired blocks `<|channel|>label<|message|>` are removed
 *     in full (tags included).
 *   - Asymmetric variants like `<|channel>thought` or `<channel|>final`
 *     are also stripped; an immediately-following channel label keyword
 *     (`thought` / `final` / `analysis` / `commentary` / `to=…`) is
 *     consumed too so the model's unstructured leak vanishes.
 *   - Standalone control tokens (any keyword, any pipe asymmetry) are
 *     dropped wherever they appear.
 *   - Legitimate text is never lost. The only text that may be held back
 *     between calls is a trailing prefix that *could* still grow into a
 *     token (e.g. `<|` or `<chann`); `flush()` releases any residue.
 *   - When the tail grows longer than the longest token without matching,
 *     the non-matching portion is emitted (prevents an unbounded buffer).
 */
export class HarmonyFilter {
  private buffer = '';
  private insideChannel = false;
  /**
   * True when we have already stripped an asymmetric channel-open token
   * from a previous push and are now buffering the suffix to determine
   * whether a channel-label keyword (`thought`, `final`, `analysis`,
   * `commentary`, `to=...`) follows. Without this flag we'd re-emit the
   * prefix-bytes that came BEFORE the token on every subsequent push,
   * because the buffer would still contain the original token text.
   */
  private pendingLabelStrip = false;

  /**
   * Feed the next raw delta and return the safe-to-emit portion.
   */
  push(chunk: string): string {
    if (chunk.length === 0) return '';
    this.buffer += chunk;
    return this.drain(false);
  }

  /**
   * Call once at stream end to release any held-back tail that can't still
   * become a token.
   */
  flush(): string {
    return this.drain(true);
  }

  /** Reset to an initial state (for reuse across requests). */
  reset(): void {
    this.buffer = '';
    this.insideChannel = false;
    this.pendingLabelStrip = false;
  }

  private drain(final: boolean): string {
    let out = '';

    for (;;) {
      if (this.pendingLabelStrip) {
        // We previously stripped an asymmetric channel-open token and
        // are now waiting to disambiguate whether a channel-label
        // keyword follows. The buffer holds only the suffix that came
        // AFTER the token (no prefix bytes — those were already
        // emitted on the prior push). Re-evaluate now that more bytes
        // may have arrived.
        if (!final && couldBeLabelPrefix(this.buffer)) {
          // Still ambiguous — wait for more bytes.
          return out;
        }
        const { rest } = consumeChannelLabel(this.buffer);
        this.buffer = rest;
        this.pendingLabelStrip = false;
        continue;
      }

      if (this.insideChannel) {
        // We're between a canonical `<|channel|>` and the next token.
        // Look for the earliest Harmony token in any variant; if it's a
        // `message` keyword, strip the entire span up to and including
        // it. Any other keyword inside means the channel block was
        // malformed — close the block at that point and let the outer
        // loop process the new token from scratch.
        const tok = findHarmonyTokenFrom(this.buffer, 0);
        if (tok === null) {
          if (final) {
            // Stream ended inside an unmatched channel — surface the
            // buffered text rather than silently losing it.
            out += this.buffer;
            this.buffer = '';
            this.insideChannel = false;
            return out;
          }
          if (this.buffer.length > HARMONY_CHANNEL_MAX_SPAN) {
            // Too long to plausibly be channel metadata — bail out so
            // we never swallow real output unbounded.
            out += this.buffer;
            this.buffer = '';
            this.insideChannel = false;
            continue;
          }
          // Wait for more.
          return out;
        }

        if (tok.keyword === 'message') {
          // Drop everything up to *and including* the closing token.
          this.buffer = this.buffer.slice(tok.index + tok.length);
          this.insideChannel = false;
          continue;
        }

        // Some other Harmony keyword appeared inside a channel block —
        // model output is malformed. Close the block at this point;
        // the outer loop will process this token afresh.
        this.insideChannel = false;
        continue;
      }

      // Not inside a channel block — scan for the earliest control token.
      const next = findEarliestHarmonyToken(this.buffer);

      if (next === null) {
        // No complete token in buffer. Emit everything that can't still
        // become a token prefix.
        if (final) {
          out += this.buffer;
          this.buffer = '';
          return out;
        }
        const safeEmit = this.buffer.length - HARMONY_MAX_TOKEN_LEN;
        if (safeEmit > 0) {
          // Only emit up to the last byte that can't still grow into a
          // token — i.e. leave a tail of HARMONY_MAX_TOKEN_LEN bytes.
          // But shrink further if that tail clearly cannot be a prefix.
          const tail = this.buffer.slice(safeEmit);
          if (!couldBeHarmonyPrefix(tail)) {
            out += this.buffer;
            this.buffer = '';
            return out;
          }
          out += this.buffer.slice(0, safeEmit);
          this.buffer = tail;
        } else if (!couldBeHarmonyPrefix(this.buffer)) {
          // Short buffer but clearly not a prefix — flush it.
          out += this.buffer;
          this.buffer = '';
        }
        return out;
      }

      // Emit everything before the matched token.
      if (next.index > 0) {
        out += this.buffer.slice(0, next.index);
      }

      const afterToken = this.buffer.slice(next.index + next.length);

      if (next.keyword === 'channel') {
        if (next.canonical) {
          // Canonical paired form. Switch to insideChannel; drop the
          // open marker now and let the inner loop find the closer.
          this.buffer = afterToken;
          this.insideChannel = true;
          continue;
        }
        // Asymmetric `<|channel>` / `<channel|>` / `<channel>`. We
        // can't reliably wait for a matching `<|message...>` (the model
        // may not emit one), so treat the open as a standalone token
        // and additionally strip any immediately-following channel
        // label keyword like `thought` / `final` / `to=foo`.
        //
        // If the buffer ends right after the token and `final` is
        // false, we can't tell yet whether a label follows — hold on
        // to the suffix until more arrives or flush is called.
        if (!final && afterToken.length > 0 && couldBeLabelPrefix(afterToken)) {
          // Token already stripped; remember the suffix in the buffer
          // and set the pending-label-strip flag so subsequent pushes
          // don't re-process the (already-emitted) prefix bytes.
          this.buffer = afterToken;
          this.pendingLabelStrip = true;
          return out;
        }
        const { rest } = consumeChannelLabel(afterToken);
        this.buffer = rest;
        continue;
      }

      // Any other Harmony keyword (message, start, end, return, constrain)
      // is a standalone token — drop it and keep scanning.
      this.buffer = afterToken;
    }
  }
}

/**
 * True iff `s` could still become the prefix of one of the Harmony control
 * tokens once more characters arrive. Only the portion of `s` after its
 * last `<` is considered — a `<` earlier in the string was already
 * determined not to start a token (otherwise it'd have been matched).
 *
 * Handles all four pipe-asymmetric forms: `<|kw|>`, `<|kw>`, `<kw|>`, `<kw>`.
 */
function couldBeHarmonyPrefix(s: string): boolean {
  if (s.length === 0) return false;
  const lt = s.lastIndexOf('<');
  if (lt === -1) return false;
  const tail = s.slice(lt).toLowerCase();
  // Try each keyword and each pipe variant.
  for (const kw of HARMONY_KEYWORDS) {
    for (const opener of ['<|', '<']) {
      for (const closer of ['|>', '>']) {
        const full = opener + kw + closer;
        if (full.startsWith(tail)) return true;
      }
    }
  }
  return false;
}

/**
 * True iff `text` (the buffer suffix immediately after a stripped
 * asymmetric channel-open token) could still grow into a recognizable
 * channel label keyword. Used to defer label-consumption until enough
 * bytes have arrived.
 *
 * The recognized labels are `thought`, `final`, `analysis`, `commentary`,
 * and the `to=…` form. We approximate "could be a label" by checking
 * whether the leading word so far is a strict prefix of any of those.
 */
function couldBeLabelPrefix(text: string): boolean {
  // Skip leading horizontal whitespace.
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  if (i >= text.length) return true; // pure whitespace so far — wait
  const word = text.slice(i).toLowerCase();
  // If the next char isn't even plausibly the start of a label, bail.
  const labels = ['thought', 'final', 'analysis', 'commentary', 'to='];
  for (const lbl of labels) {
    if (lbl.startsWith(word) || word.startsWith(lbl)) {
      // word is a prefix of lbl (still growing) or word starts with lbl
      // (we already have the full label). In either case there's nothing
      // more to wait for once `final` is reached — but since we only call
      // this with `final===false`, we want to wait when the word is a
      // strict prefix of a label, and proceed when we already have the
      // full match (no point waiting longer).
      if (lbl.startsWith(word) && word.length < lbl.length) {
        return true;
      }
    }
  }
  return false;
}

// ---------- Thinking-block splitter (Qwen / DeepSeek / R1-style) ----------

/**
 * Many open-weights models — Qwen 2.5/3, DeepSeek R1, glm-zero, and
 * various chain-of-thought distillations — emit a private "reasoning"
 * scratchpad inside `<think>...</think>` (or, less commonly,
 * `<thinking>...</thinking>` / `<|think|>...<|/think|>`) tokens. Until
 * R10 we treated this content as runaway garbage and SILENTLY DROPPED
 * it. R13 changes direction: thinking is a first-class feature (think
 * Claude Code's "thinking" panel, or OpenAI o1's reasoning surface).
 * The new {@link ThinkingBlockSplitter} routes the two streams
 * separately — visible text outside thinking blocks goes to one
 * channel, the reasoning bytes inside go to another — and the adapter
 * forwards them via two distinct callbacks (`onChunk` for visible,
 * `onThinkingChunk` for reasoning).
 *
 * The splitter is streaming and chunk-boundary-safe:
 *
 *   - While outside a thinking block, content accumulates into the
 *     `visible` channel of each push's return value.
 *   - When an opening tag appears (`<think>`, `<thinking>`,
 *     `<|think|>`, `<|thinking|>`), subsequent content accumulates into
 *     the `thinking` channel until the matching closer.
 *   - When the matching closing tag appears (`</think>`, `</thinking>`,
 *     `<|/think|>`, `<|/thinking|>`), the splitter resumes routing to
 *     `visible`. The tags themselves are consumed (never surfaced).
 *   - If thinking content grows past 50,000 chars without closing, a
 *     `[thinking truncated — exceeded 50K chars]` marker is appended
 *     to the thinking channel and the splitter exits thinking mode so
 *     any subsequent visible output reaches the user.
 *   - At stream end (`flush()`), any held tail (which may include a
 *     partial open or close tag) is released. Content that was inside
 *     an unclosed block goes out as thinking; outside content goes out
 *     as visible.
 */

/** Recognised opening tags, all lowercased and matched case-insensitively. */
const THINKING_OPEN_TAGS = [
  '<think>',
  '<thinking>',
  '<|think|>',
  '<|thinking|>',
] as const;
/** Recognised closing tags. Order parallels {@link THINKING_OPEN_TAGS}. */
const THINKING_CLOSE_TAGS = [
  '</think>',
  '</thinking>',
  '<|/think|>',
  '<|/thinking|>',
] as const;

/**
 * Maximum characters allowed inside an unclosed thinking block before
 * we treat the model as runaway and force-close. 50_000 chars is
 * roughly 12-13k tokens — long enough for legitimate deep reasoning
 * on hard prompts, short enough that an infinite loop is detected
 * within a few seconds of typical local-model output.
 */
const THINKING_MAX_BLOCK_LEN = 50_000;

/**
 * Maximum length of the longest closing tag (used as a safety margin
 * when buffering: keep at least this many trailing bytes back so a
 * close-tag split across chunk boundaries isn't missed).
 */
const THINKING_MAX_TAG_LEN = Math.max(
  ...THINKING_OPEN_TAGS.map((t) => t.length),
  ...THINKING_CLOSE_TAGS.map((t) => t.length),
);

/**
 * Result of a single {@link ThinkingBlockSplitter#push} call. Each
 * push returns the safe-to-emit portion routed onto two channels:
 *   - `visible` — text outside any thinking block (the model's actual
 *     reply).
 *   - `thinking` — text inside a thinking block (the model's private
 *     reasoning, intentionally surfaced for UI display).
 *
 * Either field may be empty (and frequently both are, when the
 * splitter is buffering the tail of a partial tag).
 */
export interface SplitChunk {
  visible: string;
  thinking: string;
}

/**
 * Streaming, chunk-boundary-safe SPLITTER for `<think>` / `<thinking>`
 * / `<|think|>` / `<|thinking|>` blocks. Unlike the legacy
 * {@link ThinkingBlockFilter}, which silently DROPS thinking content,
 * the splitter routes thinking onto a SEPARATE channel so the UI can
 * render it distinctly (collapsed pane, dimmed text, "model is
 * thinking…" indicator, etc).
 *
 * Behaviour summary:
 *   - Outside a thinking block, `push(chunk)` returns the safe-to-emit
 *     visible portion in `visible` (with `thinking === ''`).
 *   - Inside a thinking block, the splitter routes content to
 *     `thinking` (with `visible === ''`).
 *   - Tag bytes themselves are consumed and never surfaced on either
 *     channel — clean separation in both directions.
 *   - At stream end (`flush()`), any held tail (which may include a
 *     partial tag) is released. If we were inside a thinking block at
 *     end-of-stream, the residual goes out as thinking content; if we
 *     were outside, it goes out as visible.
 *   - Runaway protection: if the in-progress thinking block exceeds
 *     50_000 chars without closing, a `[thinking truncated — exceeded
 *     50K chars]` marker is appended to the thinking channel and the
 *     splitter exits thinking mode (so subsequent visible content can
 *     reach the user).
 */
export class ThinkingBlockSplitter {
  private buffer = '';
  private insideThinking = false;
  private thinkingTotal = 0;
  /**
   * True once the splitter has emitted the truncation marker for the
   * current/most-recent runaway block. Stays sticky for the rest of
   * the splitter's lifetime so two consecutive runaway blocks don't
   * each emit the marker.
   */
  private truncatedNoticeEmitted = false;

  /**
   * Feed the next raw delta. Returns the portion that's safe to emit
   * on each channel right now. The splitter holds back at most
   * {@link THINKING_MAX_TAG_LEN} trailing bytes per channel-flip
   * boundary so a tag split across chunks isn't misclassified.
   */
  push(chunk: string): SplitChunk {
    if (chunk.length === 0) {
      // Even an empty push may have something to emit if previous
      // pushes left a buffer that's now drainable — but in practice
      // empty pushes during normal operation are no-ops.
      return { visible: '', thinking: '' };
    }
    this.buffer += chunk;
    return this.drain(false);
  }

  /**
   * End-of-stream drain. Releases any buffered tail. If we were inside
   * a thinking block, the buffered content goes out on the `thinking`
   * channel; otherwise on `visible`.
   */
  flush(): SplitChunk {
    return this.drain(true);
  }

  /** Reset to initial state (for reuse across requests). */
  reset(): void {
    this.buffer = '';
    this.insideThinking = false;
    this.thinkingTotal = 0;
    this.truncatedNoticeEmitted = false;
  }

  /** True iff the splitter is currently inside an open thinking block. */
  isInsideThinking(): boolean {
    return this.insideThinking;
  }

  private drain(final: boolean): SplitChunk {
    let visible = '';
    let thinking = '';

    for (;;) {
      if (this.insideThinking) {
        // Look for the earliest closing tag.
        const closeIdx = findEarliestThinkingTag(
          this.buffer,
          THINKING_CLOSE_TAGS,
        );
        if (closeIdx === null) {
          // No closer yet. Account against the runaway limit and
          // either emit/truncate or hold for more input.
          if (final) {
            // Stream ended inside an unclosed thinking block. Emit
            // whatever's buffered as thinking content rather than
            // dropping it silently — the user wanted to see thinking.
            thinking += this.buffer;
            this.thinkingTotal += this.buffer.length;
            this.buffer = '';
            this.insideThinking = false;
            return { visible, thinking };
          }
          // Hold back THINKING_MAX_TAG_LEN bytes so a closer split
          // across chunks isn't missed; emit the rest as thinking.
          if (this.buffer.length > THINKING_MAX_TAG_LEN) {
            const safeLen = this.buffer.length - THINKING_MAX_TAG_LEN;
            const slice = this.buffer.slice(0, safeLen);
            thinking += slice;
            this.thinkingTotal += slice.length;
            this.buffer = this.buffer.slice(safeLen);
          }
          // Runaway protection — fire the truncation marker once,
          // then exit thinking mode so future visible output reaches
          // the user.
          if (
            this.thinkingTotal > THINKING_MAX_BLOCK_LEN &&
            !this.truncatedNoticeEmitted
          ) {
            const marker = '\n[thinking truncated — exceeded 50K chars]';
            thinking += marker;
            this.truncatedNoticeEmitted = true;
            this.insideThinking = false;
            // Drop the buffered residue so we don't keep emitting bytes
            // from this runaway block as visible content.
            this.buffer = '';
            return { visible, thinking };
          }
          return { visible, thinking };
        }

        // Found the closer. Emit everything up to it as thinking,
        // consume the tag, and resume visible mode.
        const tag = identifyTagAt(this.buffer, closeIdx, THINKING_CLOSE_TAGS);
        const tagLen = tag?.length ?? 0;
        const inner = this.buffer.slice(0, closeIdx);
        thinking += inner;
        this.thinkingTotal += inner.length;
        this.buffer = this.buffer.slice(closeIdx + tagLen);
        this.insideThinking = false;
        // Reset the per-block counter so the next thinking block
        // starts with a fresh budget.
        this.thinkingTotal = 0;
        // Don't reset truncatedNoticeEmitted — see comment above.
        continue;
      }

      // Outside a thinking block — scan for the next opener.
      const openIdx = findEarliestThinkingTag(this.buffer, THINKING_OPEN_TAGS);

      if (openIdx === null) {
        // No opener in buffer. Emit everything that can't still grow
        // into an opener prefix.
        if (final) {
          visible += this.buffer;
          this.buffer = '';
          return { visible, thinking };
        }
        const safeEmit = this.buffer.length - THINKING_MAX_TAG_LEN;
        if (safeEmit > 0) {
          const tail = this.buffer.slice(safeEmit);
          if (!couldBeThinkingPrefix(tail)) {
            visible += this.buffer;
            this.buffer = '';
            return { visible, thinking };
          }
          visible += this.buffer.slice(0, safeEmit);
          this.buffer = tail;
        } else if (!couldBeThinkingPrefix(this.buffer)) {
          visible += this.buffer;
          this.buffer = '';
        }
        return { visible, thinking };
      }

      // Found an opener. Emit everything before it as visible, then
      // enter thinking mode and consume the tag.
      if (openIdx > 0) {
        visible += this.buffer.slice(0, openIdx);
      }
      const openTag = identifyTagAt(this.buffer, openIdx, THINKING_OPEN_TAGS);
      const openTagLen = openTag?.length ?? 0;
      this.buffer = this.buffer.slice(openIdx + openTagLen);
      this.insideThinking = true;
      this.thinkingTotal = 0;
      // Loop back to handle whatever follows in the buffer.
    }
  }
}

/**
 * @deprecated Use {@link ThinkingBlockSplitter} instead. R13 reframes
 * thinking content as a first-class feature (routed via a separate
 * `onThinkingChunk` callback) rather than runaway garbage to be
 * stripped. This filter is retained for backward compatibility — its
 * `push()` returns only the visible portion, which matches the legacy
 * "strip thinking" behaviour. New code should use
 * {@link ThinkingBlockSplitter} so the user sees the model's
 * reasoning in a dedicated UI channel.
 */
export class ThinkingBlockFilter {
  /** Buffer for input we haven't emitted yet (or that we're still scanning). */
  private buffer = '';
  /** True iff we're currently inside an open thinking block. */
  private insideThink = false;
  /**
   * Bytes accumulated inside the CURRENT thinking block (cleared on
   * exit). Used to enforce `THINKING_MAX_BLOCK_LEN`.
   */
  private thinkBlockChars = 0;
  /**
   * Total bytes emitted as visible (i.e. NOT inside a thinking block)
   * across the lifetime of this filter instance. The adapter reads
   * this to detect "thinking-only" hangs.
   */
  private visibleByteCount = 0;
  /**
   * Set to true once we've emitted a `[thinking truncated]` placeholder
   * for the current runaway block. Prevents repeated placeholders if
   * the block keeps growing within a single stream.
   */
  private truncatedNoticeEmitted = false;

  /** Number of visible bytes emitted so far. */
  visibleBytes(): number {
    return this.visibleByteCount;
  }

  /** True iff the filter is currently inside an open thinking block. */
  isInsideThinking(): boolean {
    return this.insideThink;
  }

  /** Feed the next raw delta and return the safe-to-emit visible portion. */
  push(chunk: string): string {
    if (chunk.length === 0) return '';
    this.buffer += chunk;
    return this.drain(false);
  }

  /** Call once at stream end. Releases any visible tail; drops unclosed thinking. */
  flush(): string {
    return this.drain(true);
  }

  /** Reset to initial state (for reuse across requests). */
  reset(): void {
    this.buffer = '';
    this.insideThink = false;
    this.thinkBlockChars = 0;
    this.visibleByteCount = 0;
    this.truncatedNoticeEmitted = false;
  }

  private drain(final: boolean): string {
    let out = '';

    for (;;) {
      if (this.insideThink) {
        // Look for the earliest closing tag in the buffer.
        const closeIdx = findEarliestThinkingTag(this.buffer, THINKING_CLOSE_TAGS);
        if (closeIdx === null) {
          // No closer yet. Account for the buffered bytes against the
          // runaway limit, then either truncate or hold for more input.
          this.thinkBlockChars += this.buffer.length;
          if (this.thinkBlockChars > THINKING_MAX_BLOCK_LEN) {
            // Runaway. Drop everything we've buffered so far, emit a
            // one-shot placeholder, and exit thinking-mode so any
            // future visible output reaches the user.
            if (!this.truncatedNoticeEmitted) {
              out += '[thinking truncated]';
              this.visibleByteCount += '[thinking truncated]'.length;
              this.truncatedNoticeEmitted = true;
            }
            this.buffer = '';
            this.insideThink = false;
            this.thinkBlockChars = 0;
            // Do not flip truncatedNoticeEmitted back to false here —
            // it stays true for the rest of this filter's lifetime so
            // a subsequent malformed block doesn't repeat the notice.
            continue;
          }
          if (final) {
            // Stream ended inside an unclosed thinking block. Drop
            // silently — the model never produced a real answer.
            this.buffer = '';
            this.insideThink = false;
            this.thinkBlockChars = 0;
            return out;
          }
          // Hold back at least THINKING_MAX_TAG_LEN bytes so a closer
          // split across chunks isn't missed. The held tail counts
          // toward thinkBlockChars on the next push.
          this.thinkBlockChars -= this.buffer.length; // unaccount; will re-account next time
          if (this.buffer.length > THINKING_MAX_TAG_LEN) {
            const safeDrop = this.buffer.length - THINKING_MAX_TAG_LEN;
            this.thinkBlockChars += safeDrop;
            this.buffer = this.buffer.slice(safeDrop);
          }
          return out;
        }

        // Found the closer. Drop everything up to AND INCLUDING the
        // close tag (no visible emit). Also reset the per-block
        // counter so the next thinking block starts fresh.
        const closeTag = identifyTagAt(this.buffer, closeIdx, THINKING_CLOSE_TAGS);
        const consumed = closeIdx + (closeTag?.length ?? 0);
        this.buffer = this.buffer.slice(consumed);
        this.insideThink = false;
        this.thinkBlockChars = 0;
        // Don't reset truncatedNoticeEmitted — see comment above.
        continue;
      }

      // Outside a thinking block — scan for the next opener.
      const openIdx = findEarliestThinkingTag(this.buffer, THINKING_OPEN_TAGS);

      if (openIdx === null) {
        // No opener in buffer. Emit everything that can't still grow
        // into an opener prefix.
        if (final) {
          out += this.buffer;
          this.visibleByteCount += this.buffer.length;
          this.buffer = '';
          return out;
        }
        // Hold back at most THINKING_MAX_TAG_LEN trailing bytes; only
        // hold them if they could plausibly start an opener.
        const safeEmit = this.buffer.length - THINKING_MAX_TAG_LEN;
        if (safeEmit > 0) {
          const tail = this.buffer.slice(safeEmit);
          if (!couldBeThinkingPrefix(tail)) {
            out += this.buffer;
            this.visibleByteCount += this.buffer.length;
            this.buffer = '';
            return out;
          }
          out += this.buffer.slice(0, safeEmit);
          this.visibleByteCount += safeEmit;
          this.buffer = tail;
        } else if (!couldBeThinkingPrefix(this.buffer)) {
          // Short buffer but clearly not a prefix — flush it.
          out += this.buffer;
          this.visibleByteCount += this.buffer.length;
          this.buffer = '';
        }
        return out;
      }

      // Found an opener. Emit everything before it as visible text,
      // then enter thinking-mode and drop the opener.
      if (openIdx > 0) {
        const visible = this.buffer.slice(0, openIdx);
        out += visible;
        this.visibleByteCount += visible.length;
      }
      const openTag = identifyTagAt(this.buffer, openIdx, THINKING_OPEN_TAGS);
      const consumed = openIdx + (openTag?.length ?? 0);
      this.buffer = this.buffer.slice(consumed);
      this.insideThink = true;
      this.thinkBlockChars = 0;
      // Loop back to handle whatever follows in the buffer.
    }
  }
}

/**
 * Find the earliest index where any of the given tags begins in the
 * buffer. Match is case-insensitive. Returns `null` if no tag is
 * fully present.
 */
function findEarliestThinkingTag(
  buffer: string,
  tags: readonly string[],
): number | null {
  let earliest: number | null = null;
  const lower = buffer.toLowerCase();
  for (const tag of tags) {
    const idx = lower.indexOf(tag);
    if (idx !== -1 && (earliest === null || idx < earliest)) {
      earliest = idx;
    }
  }
  return earliest;
}

/**
 * Return the actual matched tag at the given index, or `null` if no
 * tag from the set matches there. Length-aware so callers know how
 * many bytes to consume.
 */
function identifyTagAt(
  buffer: string,
  index: number,
  tags: readonly string[],
): string | null {
  const slice = buffer.slice(index, index + THINKING_MAX_TAG_LEN + 4).toLowerCase();
  for (const tag of tags) {
    if (slice.startsWith(tag)) return tag;
  }
  return null;
}

/**
 * True iff `s` could still grow into the prefix of one of the
 * thinking-tag openers once more characters arrive. Approximate but
 * conservative: any string ending in `<` or that's a strict prefix of
 * a known opener tag is "maybe still becoming a tag".
 */
function couldBeThinkingPrefix(s: string): boolean {
  if (s.length === 0) return false;
  const lt = s.lastIndexOf('<');
  if (lt === -1) return false;
  const tail = s.slice(lt).toLowerCase();
  for (const tag of THINKING_OPEN_TAGS) {
    if (tag.startsWith(tail)) return true;
  }
  return false;
}

// ---------- Inline smoke tests ----------
//
// Run with: `bun src/llm/streaming.ts`
// Validates the most important Harmony-filter behaviours at the
// command-line so the implementation can be smoke-checked without
// firing up the full bun-test runner.
if (import.meta.main) {
  function assertEq(a: string, b: string, label: string): void {
    if (a !== b) {
      // eslint-disable-next-line no-console
      console.error('FAIL', label, JSON.stringify({ got: a, want: b }));
      process.exit(1);
    }
  }

  // 1. Canonical paired block.
  const f1 = new HarmonyFilter();
  assertEq(
    f1.push('hello <|channel|>thought<|message|>world') + f1.flush(),
    'hello world',
    'paired',
  );

  // 2. Asymmetric channel-open with pipe on left only.
  const f2 = new HarmonyFilter();
  assertEq(
    f2.push('hello <|channel>thought world') + f2.flush(),
    'hello  world',
    'asymmetric channel close-only',
  );

  // 3. Asymmetric channel-open with pipe on right only.
  const f3 = new HarmonyFilter();
  assertEq(
    f3.push('hello <channel|>final world') + f3.flush(),
    'hello  world',
    'asymmetric channel open-only',
  );

  // 4. Token split across two pushes.
  const f4 = new HarmonyFilter();
  let out = f4.push('hello <|chan');
  out += f4.push('nel|>thought<|message|>world');
  out += f4.flush();
  assertEq(out, 'hello world', 'split paired');

  // 5. Legitimate `<` followed by non-keyword text must not be eaten.
  const f5 = new HarmonyFilter();
  assertEq(
    f5.push('here is < 5 elements') + f5.flush(),
    'here is < 5 elements',
    'legitimate <',
  );

  // 6. User-reported leakage shapes from the screenshot.
  // Two adjacent token+label pairs are both stripped; the original
  // surrounding spaces survive (one before each token's leading space,
  // one between the trailing label and `ready`).
  const f6 = new HarmonyFilter();
  assertEq(
    f6.push('answer is <|channel>thought<channel|>final ready') + f6.flush(),
    'answer is  ready',
    'mixed asymmetric leakage',
  );

  // eslint-disable-next-line no-console
  console.log('Harmony filter tests OK');

  // ---------- ThinkingBlockSplitter smoke tests ----------
  function assertSplit(
    got: SplitChunk,
    want: SplitChunk,
    label: string,
  ): void {
    if (got.visible !== want.visible || got.thinking !== want.thinking) {
      // eslint-disable-next-line no-console
      console.error('FAIL', label, JSON.stringify({ got, want }));
      process.exit(1);
    }
  }
  function concatSplits(...splits: SplitChunk[]): SplitChunk {
    return {
      visible: splits.map((s) => s.visible).join(''),
      thinking: splits.map((s) => s.thinking).join(''),
    };
  }

  // S1: plain content stays on the visible channel.
  const s1 = new ThinkingBlockSplitter();
  assertSplit(
    concatSplits(s1.push('hello world, plain text'), s1.flush()),
    { visible: 'hello world, plain text', thinking: '' },
    'splitter: plain visible',
  );

  // S2: a complete <think>...</think> block routes the inner content
  // to the thinking channel and the surrounding text to visible.
  const s2 = new ThinkingBlockSplitter();
  assertSplit(
    concatSplits(s2.push('before <think>secret reasoning</think> after'), s2.flush()),
    {
      visible: 'before  after',
      thinking: 'secret reasoning',
    },
    'splitter: paired think block',
  );

  // S3: a <thinking>...</thinking> alternative is recognised too.
  const s3 = new ThinkingBlockSplitter();
  assertSplit(
    concatSplits(s3.push('A<thinking>R</thinking>B padding padding padding'), s3.flush()),
    {
      visible: 'AB padding padding padding',
      thinking: 'R',
    },
    'splitter: <thinking> alternative',
  );

  // S4: tag split across multiple pushes.
  const s4 = new ThinkingBlockSplitter();
  const a = s4.push('keep <thi');
  const b = s4.push('nk>plan</thi');
  const c = s4.push('nk>going more padding for length');
  const d = s4.flush();
  assertSplit(
    concatSplits(a, b, c, d),
    {
      visible: 'keep going more padding for length',
      thinking: 'plan',
    },
    'splitter: tag split across pushes',
  );

  // S5: <|think|> ... <|/think|> pipe-form pair.
  const s5 = new ThinkingBlockSplitter();
  assertSplit(
    concatSplits(
      s5.push('hi <|think|>secret<|/think|> bye padding padding padding'),
      s5.flush(),
    ),
    {
      visible: 'hi  bye padding padding padding',
      thinking: 'secret',
    },
    'splitter: <|think|> pair',
  );

  // S6: unclosed thinking block at end-of-stream releases as thinking.
  const s6 = new ThinkingBlockSplitter();
  assertSplit(
    concatSplits(s6.push('start <think>still going'), s6.flush()),
    {
      visible: 'start ',
      thinking: 'still going',
    },
    'splitter: unclosed at flush emits thinking',
  );

  // eslint-disable-next-line no-console
  console.log('ThinkingBlockSplitter tests OK');
}
