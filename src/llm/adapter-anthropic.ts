/**
 * AnthropicAdapter — HTTP client for Anthropic's Messages API.
 *
 * The Messages API differs from the OpenAI Chat Completions surface in
 * several non-trivial ways:
 *
 *   - Endpoint: `POST {baseUrl}/messages` (NOT `/chat/completions`).
 *   - Auth:     `x-api-key: <key>` plus `anthropic-version` header
 *               (NOT `Authorization: Bearer ...`).
 *   - System:   the system prompt is a top-level `system` field, never
 *               a `role: "system"` message in the array.
 *   - Tools:    schema uses `input_schema` (not `function.parameters`),
 *               and there is no `function` wrapper. Tool calls in the
 *               response arrive as `tool_use` content blocks; tool
 *               results echo back inside a `user` message as
 *               `tool_result` content blocks.
 *   - Stream:   SSE event types are `message_start`, `content_block_start`,
 *               `content_block_delta`, `content_block_stop`,
 *               `message_delta`, `message_stop` (NOT `data: {choices...}`).
 *               The deltas split into `text_delta` (visible text) and
 *               `input_json_delta` (partial tool-use input JSON).
 *
 * The adapter exposes the SAME public surface as {@link LLMAdapter}
 * (`streamChat`, `getModels`, `ping`, `cancel`) so they're drop-in
 * interchangeable. The factory in `src/config/defaults.ts` (Agent F's
 * round) picks one based on `BackendConfig.type`.
 *
 * Streaming is implemented with native `fetch` + `ReadableStream`; we
 * reuse `splitSSEFrames` from {@link ./streaming.ts} for frame
 * extraction, but parse Anthropic's event payloads with a custom Zod
 * schema set since the wire shape diverges fully from OpenAI.
 *
 * Cancellation, stall detection, and retry semantics mirror
 * {@link LLMAdapter} — same callback contract, same finish-reason
 * universe, same once-only `onDone` discipline.
 */

import { z } from 'zod';
import type {
  GenerationConfig,
  Message,
  ToolCall,
} from '@/types/global';
import { splitSSEFrames } from '@/llm/streaming';
import {
  BackendCircuitOpenError,
  globalBreakerRegistry,
} from '@/llm/circuit-breaker';
import type {
  MessageContentPart,
  StreamChatParams,
  StreamDoneResult,
  StreamUsage,
  ToolSchema,
} from '@/types/message';
import { isMessageContentPartArray } from '@/types/message';

// ---------- Config ----------

export interface AnthropicAdapterOptions {
  /** Base URL. Defaults to `https://api.anthropic.com/v1`. */
  baseUrl?: string;
  /** Model identifier, e.g. `claude-3-5-sonnet-20241022`. Required. */
  model: string;
  /**
   * Anthropic API key. REQUIRED — Anthropic's API has no anonymous
   * mode. Sent verbatim in the `x-api-key` header.
   */
  apiKey: string;
  /**
   * Optional ceiling for the model's context. Forwarded as
   * `max_tokens` ON the request body — Anthropic uses `max_tokens`
   * for "max output tokens", but we also rely on it for the cap.
   */
  contextMaxTokens?: number;
  /** Generation knobs (temperature, top_p, max tokens). */
  generation?: GenerationConfig;
  /**
   * Abort the stream if no visible-content chunk arrives for this many
   * milliseconds. Defaults to 180_000 (180s). Heartbeats and
   * non-content events do NOT reset the clock — same semantics as
   * {@link LLMAdapter#stallTimeoutMs}.
   */
  stallTimeoutMs?: number;
  /** Connect timeout in ms. Default 120_000. */
  requestTimeoutMs?: number;
  /** Max retry attempts on retryable errors. Default 3. */
  maxAttempts?: number;
  /** Initial backoff in ms. Doubles each attempt. Default 1000. */
  initialBackoffMs?: number;
  /**
   * Anthropic API version pin. Default `'2023-06-01'` (the latest
   * stable as of writing — Anthropic guarantees backward compatibility
   * for a pinned version).
   */
  anthropicVersion?: string;
  /**
   * Optional `anthropic-beta` header values. The adapter does NOT
   * default any beta flags — modern Messages API tools are GA. Pass
   * an array if you need extended thinking, prompt caching beta, etc.
   */
  anthropicBeta?: readonly string[];
  /** Extra request headers, merged after the canonical ones. */
  customHeaders?: Record<string, string>;
}

/**
 * L3 — ping result cache TTL in ms. 30s matches the typical health
 * checker interval; longer would mask a real outage, shorter would
 * defeat the cache.
 */
const PING_CACHE_TTL_MS = 30_000;

// ---------- Hardcoded model list ----------

/**
 * Anthropic does not expose a public `/models` endpoint. We surface a
 * hand-curated list (newest first) so the model-picker UI has
 * something to show; users can always type any model id verbatim into
 * `/model` and it'll be forwarded as-is.
 */
const ANTHROPIC_MODELS: readonly string[] = [
  'claude-opus-4-7-20250101',
  'claude-sonnet-4-6-20251001',
  'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
] as const;

// ---------- Wire-type Zod schemas ----------

/**
 * Anthropic content blocks come in three shapes for SSE deltas:
 *   - `text_delta`         → incremental text (visible reply)
 *   - `input_json_delta`   → incremental tool_use.input JSON string
 *   - `thinking_delta`     → incremental extended-thinking content
 *                            (extended-thinking beta only — routed via
 *                            `onThinkingChunk` for parity with OpenAI
 *                            adapter's thinking channel).
 *
 * Unknown delta types are ignored — Anthropic adds new ones over time
 * (e.g. `signature_delta`) and we want forward compatibility, not a
 * crash on first contact.
 */
/**
 * `delta` payload schema. Note that `type` is OPTIONAL because Anthropic
 * uses two distinct delta shapes:
 *
 *   1. Inside `content_block_delta` events, the delta carries a `type`
 *      field (`text_delta`, `input_json_delta`, `thinking_delta`).
 *   2. Inside `message_delta` events, the delta carries `stop_reason`
 *      and `stop_sequence` only — NO `type` field.
 *
 * Marking `type` required would silently drop every `message_delta`
 * payload at parse time and the adapter would never observe a
 * `stop_reason` (so `max_tokens` truncation would surface as a generic
 * `'stop'` instead of `'length'`). R7 fix: `type` is now optional.
 */
const deltaSchema = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
    partial_json: z.string().optional(),
    thinking: z.string().optional(),
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
  })
  .passthrough();

const contentBlockSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    text: z.string().optional(),
    thinking: z.string().optional(),
  })
  .passthrough();

const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  })
  .passthrough();

/** Top-level event payload shape — discriminated by `type`. */
const messageEventSchema = z
  .object({
    type: z.string(),
    message: z
      .object({
        id: z.string().optional(),
        role: z.string().optional(),
        model: z.string().optional(),
        usage: usageSchema.optional(),
        stop_reason: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    index: z.number().int().nonnegative().optional(),
    content_block: contentBlockSchema.optional(),
    delta: deltaSchema.optional(),
    usage: usageSchema.optional(),
    error: z
      .object({
        type: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type AnthropicEvent = z.infer<typeof messageEventSchema>;

// ---------- Internal stream-state shapes ----------

/**
 * State accumulated for a single in-flight `tool_use` content block as
 * its `input_json_delta` chunks arrive. The full input JSON is parsed
 * once `content_block_stop` fires for that block's index.
 */
interface PendingToolUse {
  /** Anthropic-assigned tool_use id (`toolu_…`). */
  id: string;
  /** Tool name, e.g. `read_file`. */
  name: string;
  /** Concatenated `partial_json` deltas — parsed at block stop. */
  partialInput: string;
}

/**
 * Anthropic content blocks have one of these types in our pipeline.
 * `text` and `thinking` blocks are routed to the visible / thinking
 * callbacks; `tool_use` blocks accumulate into a `PendingToolUse`.
 */
type ContentBlockKind = 'text' | 'tool_use' | 'thinking' | 'unknown';

interface StreamState {
  startTime: number;
  /** Last-content timestamp; only refreshed on text/tool_use/thinking deltas. */
  lastContentChunkAt: number;
  usage: StreamUsage | null;
  streamedTextLength: number;
  stalled: boolean;
  /** Server-reported `stop_reason` (e.g. `'end_turn'`, `'max_tokens'`, `'tool_use'`). */
  stopReason: string | null;
  /** Per-content-block-index map of in-flight tool_use accumulators. */
  pendingToolUses: Map<number, PendingToolUse>;
  /** Accumulated finished tool calls in stream order. */
  finishedToolCalls: ToolCall[];
  /** Per-index block kind, set on `content_block_start`. */
  blockKinds: Map<number, ContentBlockKind>;
  /** True if any text/tool_use/thinking content arrived. */
  sawAnyContent: boolean;
  sawToolUse: boolean;
  sawThinkingContent: boolean;
  /** Whether the stream emitted a server-reported error event. */
  serverErrorMessage: string | null;
}

/**
 * C3 — produce a freshly-zeroed Anthropic {@link StreamState} anchored
 * at `startedAt`. Used at the top of `streamChat`; mirrored by
 * `resetAnthropicStreamState` before each retry iteration so a partial
 * first attempt cannot leak `pendingToolUses` / `finishedToolCalls`
 * into the next attempt.
 */
function freshAnthropicStreamState(startedAt: number): StreamState {
  return {
    startTime: startedAt,
    lastContentChunkAt: startedAt,
    usage: null,
    streamedTextLength: 0,
    stalled: false,
    stopReason: null,
    pendingToolUses: new Map(),
    finishedToolCalls: [],
    blockKinds: new Map(),
    sawAnyContent: false,
    sawToolUse: false,
    sawThinkingContent: false,
    serverErrorMessage: null,
  };
}

/**
 * C3 — wipe every per-attempt field in `state` so the retry starts
 * clean. `startTime` is preserved (cumulative anchor); everything
 * else resets. Tool-state Maps and Arrays get fresh instances (we
 * do NOT call `.clear()` because external callers might still hold
 * references to the old objects for telemetry — the new attempt's
 * state should be unobservable to them).
 */
function resetAnthropicStreamState(
  state: StreamState,
  startedAt: number,
): void {
  state.lastContentChunkAt = startedAt;
  state.usage = null;
  state.streamedTextLength = 0;
  state.stalled = false;
  state.stopReason = null;
  state.pendingToolUses = new Map();
  state.finishedToolCalls = [];
  state.blockKinds = new Map();
  state.sawAnyContent = false;
  state.sawToolUse = false;
  state.sawThinkingContent = false;
  state.serverErrorMessage = null;
}

// ---------- Adapter ----------

export class AnthropicAdapter {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly contextMaxTokens: number | undefined;
  private readonly generation: GenerationConfig | undefined;
  private readonly stallTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly anthropicVersion: string;
  private readonly anthropicBeta: readonly string[];
  private readonly customHeaders: Record<string, string>;

  /**
   * C2 — set of every in-flight stream's abort controller. Mirrors
   * the same fix in `LLMAdapter`: a single-slot field was overwritten
   * when two `streamChat` calls ran in parallel (web frontend now has
   * concurrent session support), so an earlier stream's controller
   * was orphaned and `cancel()` could not abort it.
   */
  private readonly activeControllers = new Set<AbortController>();

  /**
   * L3 — ping result cache. `ping()` hits Anthropic's `POST /messages`
   * with `max_tokens: 1`, which costs tokens AND counts against the
   * per-key rate limit. A health checker firing every 30s racks up
   * thousands of pings per day. We cache the boolean result for
   * {@link PING_CACHE_TTL_MS} keyed by `${baseUrl}::${apiKeyFingerprint}`
   * so back-to-back probes within the TTL share one HTTP round-trip.
   *
   * Cache is per-instance — adapters with different keys / endpoints
   * never collide. Re-probes happen on staleness or explicit cache
   * eviction (currently no public eviction API; callers that need a
   * fresh probe should construct a new adapter).
   */
  private pingCache: { key: string; result: boolean; expiresAt: number } | null =
    null;

  constructor(opts: AnthropicAdapterOptions) {
    if (!opts.apiKey || opts.apiKey.length === 0) {
      throw new Error('AnthropicAdapter requires `apiKey`');
    }
    if (!opts.model || opts.model.length === 0) {
      throw new Error('AnthropicAdapter requires `model`');
    }
    this.baseUrl = stripTrailingSlash(
      opts.baseUrl ?? 'https://api.anthropic.com/v1',
    );
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.contextMaxTokens =
      typeof opts.contextMaxTokens === 'number' && opts.contextMaxTokens > 0
        ? Math.floor(opts.contextMaxTokens)
        : undefined;
    this.generation = opts.generation;
    this.stallTimeoutMs = Math.max(1000, opts.stallTimeoutMs ?? 180_000);
    this.requestTimeoutMs = Math.max(1000, opts.requestTimeoutMs ?? 120_000);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.initialBackoffMs = Math.max(0, opts.initialBackoffMs ?? 1000);
    this.anthropicVersion = opts.anthropicVersion ?? '2023-06-01';
    this.anthropicBeta = opts.anthropicBeta ?? [];
    this.customHeaders = { ...(opts.customHeaders ?? {}) };
  }

  // ---------- Cancellation ----------

  /**
   * Abort EVERY in-flight stream. Safe to call when no stream is active.
   *
   * C2 — iterates over `activeControllers`; the try/finally in
   * `runStreamOnce` is what removes them from the set via
   * `clearController`. We don't mutate here.
   */
  cancel(): void {
    for (const c of this.activeControllers) {
      try {
        c.abort();
      } catch {
        // Defensive — should never throw in any runtime we support.
      }
    }
  }

  // MODEL-SWAP-SECTION — alias for `cancel()` used by the live
  // model-swap path. Mirrors the same seam in `LLMAdapter`. See the
  // comment there for the full contract.
  interruptStream(): void {
    this.cancel();
  }

  // ---------- Models ----------

  /**
   * Anthropic does not expose a discoverable `/models` endpoint, so we
   * return a hardcoded list (newest first). Users can override at the
   * call site via `/model <id>` — any string is forwarded verbatim, so
   * brand-new releases work the day they ship without a code update.
   */
  async getModels(): Promise<string[]> {
    return [...ANTHROPIC_MODELS];
  }

  // ---------- Liveness ----------

  /**
   * Quick liveness check. Anthropic has no `GET /v1/models`; we issue
   * a 1-token `POST /messages` and treat any 2xx (or 4xx other than
   * 401/403) as "the API answered". 401/403 → key invalid → not live.
   *
   * L3 — results are cached for {@link PING_CACHE_TTL_MS} per
   * `(baseUrl, apiKey)` tuple. Anthropic's `POST /messages` costs
   * tokens AND counts against the per-key rate limit, so a health
   * checker firing every 30s would generate thousands of probes per
   * day. With the cache, back-to-back pings within the TTL window
   * return the previous result without a network round-trip.
   *
   * The cache key uses a short hash of the apiKey (NOT the raw key)
   * so a future logger / debug snapshot of `pingCache` would never
   * leak the secret. The fingerprint is stable per-instance because
   * the apiKey is set once at construction.
   */
  async ping(): Promise<boolean> {
    const cacheKey = `${this.baseUrl}::${shortApiKeyFingerprint(this.apiKey)}`;
    const now = Date.now();
    if (
      this.pingCache &&
      this.pingCache.key === cacheKey &&
      this.pingCache.expiresAt > now
    ) {
      return this.pingCache.result;
    }
    const result = await this.runPingProbe();
    this.pingCache = {
      key: cacheKey,
      result,
      expiresAt: now + PING_CACHE_TTL_MS,
    };
    return result;
  }

  /** L3 — the actual `POST /messages` probe, called by the cached `ping()`. */
  private async runPingProbe(): Promise<boolean> {
    const url = this.joinUrl('/messages');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: controller.signal,
      });
      // 4xx like `invalid_request_error` still proves the endpoint is
      // alive and the key works (the key was accepted; only the body
      // was rejected). 401/403 are authentication failures → not live.
      if (res.ok) return true;
      if (res.status === 401 || res.status === 403) return false;
      return res.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- Streaming ----------

  /**
   * Stream a Messages API completion. The callback contract matches
   * {@link LLMAdapter#streamChat}:
   *   - `onChunk(text)`           — visible text deltas.
   *   - `onThinkingChunk(text)`   — extended-thinking deltas (when
   *                                  the model emits a thinking block).
   *   - `onToolCalls(calls)`      — fired ONCE with the fully assembled
   *                                  batch when `message_stop` arrives
   *                                  and any tool_use blocks completed.
   *   - `onDone(result)`          — fired exactly once at the end.
   *
   * The method never throws post-connection — every error path
   * surfaces through `onDone({ error })`.
   */
  async streamChat(params: StreamChatParams): Promise<void> {
    const done = onceDone(params.onDone);
    const startedAt = Date.now();

    // Circuit breaker — fail fast when Anthropic's endpoint is OPEN.
    // Keyed by `anthropic::<baseUrl>` so a custom proxy gets its own
    // breaker even when the type field is the same.
    const breaker = globalBreakerRegistry.get('anthropic', this.baseUrl);
    const breakerCheck = breaker.check();
    if (!breakerCheck.allowed) {
      done({
        finishReason: 'error',
        error: breakerCheck.reason ?? 'Backend circuit open',
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    // C3 — `state` is re-initialised per retry iteration by
    // `resetAnthropicStreamState`. Without this, a partial first
    // attempt could leak `finishedToolCalls`, `pendingToolUses`,
    // `blockKinds`, and `serverErrorMessage` into the next attempt
    // — manifesting as phantom tool_use accumulation (the model
    // appears to "remember" a tool call it never finished sending)
    // and double-emitted `onToolCalls` on the retry path. Only
    // `startTime` survives across retries; everything else resets.
    const state: StreamState = freshAnthropicStreamState(startedAt);

    let attempt = 0;
    let lastError: unknown = null;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      // C3 — wipe per-attempt fields before each try. Mirrors C1 in
      // the OpenAI-compat adapter for the same reasons.
      if (attempt > 1) resetAnthropicStreamState(state, startedAt);
      try {
        await this.runStreamOnce(params, state);
        const result = this.buildSuccessDoneResult(state);
        // Circuit breaker — error finish counts as failure (server may
        // be misbehaving even when fetch resolved 2xx).
        breaker.record(result.finishReason === 'error' ? 'failure' : 'success');
        done(result);
        return;
      } catch (error) {
        lastError = error;
        if (isAbortError(error)) {
          if (state.stalled) {
            done({
              finishReason: 'error',
              error: `Connection stalled (no content for ${Math.round(
                this.stallTimeoutMs / 1000,
              )}s).`,
              ...(state.usage ? { usage: state.usage } : {}),
              durationMs: Date.now() - state.startTime,
            });
            return;
          }
          done({
            finishReason: 'aborted',
            error: 'Request cancelled',
            ...(state.usage ? { usage: state.usage } : {}),
            durationMs: Date.now() - state.startTime,
          });
          return;
        }
        if (!isRetryableError(error) || attempt >= this.maxAttempts) {
          if (isAnthropicTransientForBreaker(error)) {
            breaker.record('failure');
          }
          done({
            finishReason: 'error',
            error: errorMessage(error),
            ...(state.usage ? { usage: state.usage } : {}),
            durationMs: Date.now() - state.startTime,
          });
          return;
        }
        // Mid-loop failures intentionally not recorded — the breaker
        // sees one outcome per `streamChat` call (final), keeping the
        // per-call retry budget intact for tests and existing users.
        await sleep(this.initialBackoffMs * Math.pow(2, attempt - 1));
      }
    }

    // Defensive fall-through (loop already returns above).
    done({
      finishReason: 'error',
      error: errorMessage(lastError),
      ...(state.usage ? { usage: state.usage } : {}),
      durationMs: Date.now() - state.startTime,
    });
  }

  // ---------- internals ----------

  private async runStreamOnce(
    params: StreamChatParams,
    state: StreamState,
  ): Promise<void> {
    const controller = new AbortController();
    // C2 — register in the active-controller set; removed in every
    // exit path (catch + finally) via `clearController`.
    this.activeControllers.add(controller);

    const externalSignal = params.signal;
    const externalAbort = (): void => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', externalAbort, { once: true });
      }
    }

    const url = this.joinUrl('/messages');
    const body = this.buildRequestBody(params);

    let connectTimeoutId: ReturnType<typeof setTimeout> | null = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );
    const clearConnectTimeout = (): void => {
      if (connectTimeoutId !== null) {
        clearTimeout(connectTimeoutId);
        connectTimeoutId = null;
      }
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearConnectTimeout();
      this.clearController(controller);
      if (externalSignal) externalSignal.removeEventListener('abort', externalAbort);
      throw error;
    }

    if (!response.ok) {
      clearConnectTimeout();
      this.clearController(controller);
      if (externalSignal) externalSignal.removeEventListener('abort', externalAbort);
      const detail = await safeReadText(response);
      throw new HttpError(
        `Anthropic API returned ${response.status} ${response.statusText}${
          detail ? `: ${parseAnthropicError(detail)}` : ''
        }`,
        response.status,
      );
    }

    if (!response.body) {
      clearConnectTimeout();
      this.clearController(controller);
      if (externalSignal) externalSignal.removeEventListener('abort', externalAbort);
      throw new Error('Anthropic API returned no response body');
    }

    clearConnectTimeout();

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    // Stall watchdog. Trip condition mirrors LLMAdapter: gap between
    // `Date.now()` and `state.lastContentChunkAt` exceeding
    // `stallTimeoutMs`. `lastContentChunkAt` is refreshed only on
    // text_delta / tool_use / thinking_delta — heartbeats / metadata
    // (`message_start`, `message_delta` carrying only stop_reason) do
    // NOT reset the clock.
    let watchdog: ReturnType<typeof setInterval> | null = setInterval(() => {
      const idle = Date.now() - state.lastContentChunkAt;
      if (idle > this.stallTimeoutMs) {
        state.stalled = true;
        controller.abort();
      }
    }, 1_000);
    const disarmWatchdog = (): void => {
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
      }
    };

    try {
      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = splitSSEFrames(buffer);
        buffer = rest;

        for (const frame of frames) {
          const event = parseAnthropicSSEFrame(frame);
          if (!event) continue;
          this.handleEvent(event, params, state);
        }
      }

      // Drain trailing partial frame if any.
      if (buffer.length > 0) {
        const event = parseAnthropicSSEFrame(buffer);
        if (event) this.handleEvent(event, params, state);
      }

      // If the stream ended cleanly but we accumulated tool uses that
      // never received a `content_block_stop` (server closed mid-block),
      // try to finalise them now from whatever JSON has accumulated.
      this.finaliseHangingToolUses(state);

      // Fire onToolCalls once if any tool calls completed.
      if (state.finishedToolCalls.length > 0 && params.onToolCalls) {
        try {
          params.onToolCalls([...state.finishedToolCalls]);
        } catch {
          // Defensive — caller's onToolCalls must not break the stream.
        }
      }

      // Surface server-side error events as a thrown error so the
      // retry/error path in streamChat can convert them to onDone.
      if (state.serverErrorMessage) {
        throw new Error(state.serverErrorMessage);
      }
    } finally {
      disarmWatchdog();
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
      clearConnectTimeout();
      this.clearController(controller);
      if (externalSignal) externalSignal.removeEventListener('abort', externalAbort);
    }
  }

  /**
   * Dispatch a parsed Anthropic SSE event to the right state-mutation
   * branch. Keeps `runStreamOnce` short and the per-event handling
   * unit-testable in isolation (Agent 9 will mock by sending a sequence
   * of events through this method).
   */
  private handleEvent(
    event: AnthropicEvent,
    params: StreamChatParams,
    state: StreamState,
  ): void {
    switch (event.type) {
      case 'message_start': {
        const msg = event.message;
        if (msg?.usage) {
          // Capture initial input_tokens (cache_creation/read may be
          // present too — sum into prompt tokens).
          const u = msg.usage;
          const cacheRead = u.cache_read_input_tokens ?? 0;
          const cacheCreate = u.cache_creation_input_tokens ?? 0;
          const promptTokens =
            (u.input_tokens ?? 0) + cacheCreate + cacheRead;
          if (promptTokens > 0) {
            const next: StreamUsage = {
              ...(state.usage ?? {}),
              promptTokens,
            };
            if (cacheRead > 0) {
              next.cachedInputTokens = cacheRead;
              next.freshInputTokens = Math.max(0, promptTokens - cacheRead);
            }
            if (cacheCreate > 0) {
              next.cacheCreationTokens = cacheCreate;
            }
            state.usage = next;
          }
        }
        return;
      }

      case 'content_block_start': {
        if (typeof event.index !== 'number') return;
        const block = event.content_block;
        if (!block) return;
        const kind = mapContentBlockKind(block.type);
        state.blockKinds.set(event.index, kind);
        if (kind === 'tool_use') {
          // The block carries `id` + `name` up-front; subsequent
          // `input_json_delta` events fill in `input`.
          const id = typeof block.id === 'string' && block.id.length > 0
            ? block.id
            : `toolu-${event.index}-${Date.now().toString(36)}`;
          const name = typeof block.name === 'string' ? block.name : '';
          state.pendingToolUses.set(event.index, {
            id,
            name,
            partialInput: '',
          });
          state.sawToolUse = true;
          state.sawAnyContent = true;
          state.lastContentChunkAt = Date.now();
        }
        return;
      }

      case 'content_block_delta': {
        if (typeof event.index !== 'number') return;
        const delta = event.delta;
        if (!delta) return;
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          state.streamedTextLength += delta.text.length;
          state.lastContentChunkAt = Date.now();
          state.sawAnyContent = true;
          try {
            params.onChunk?.(delta.text);
          } catch {
            // Defensive — caller's onChunk must not break the stream.
          }
          return;
        }
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const pending = state.pendingToolUses.get(event.index);
          if (pending) {
            pending.partialInput += delta.partial_json;
            state.lastContentChunkAt = Date.now();
            state.sawAnyContent = true;
          }
          return;
        }
        if (
          delta.type === 'thinking_delta' &&
          typeof delta.thinking === 'string' &&
          delta.thinking.length > 0
        ) {
          state.lastContentChunkAt = Date.now();
          state.sawAnyContent = true;
          state.sawThinkingContent = true;
          try {
            params.onThinkingChunk?.(delta.thinking);
          } catch {
            // Defensive.
          }
          return;
        }
        // Unknown delta types (e.g. `signature_delta` for verified
        // thinking) are intentionally ignored — they don't carry user
        // visible content.
        return;
      }

      case 'content_block_stop': {
        if (typeof event.index !== 'number') return;
        const pending = state.pendingToolUses.get(event.index);
        if (pending) {
          state.finishedToolCalls.push(buildToolCallFromPending(pending));
          state.pendingToolUses.delete(event.index);
        }
        return;
      }

      case 'message_delta': {
        // Carries final stop_reason and updated output_tokens.
        const delta = event.delta;
        if (delta && typeof delta.stop_reason === 'string') {
          state.stopReason = delta.stop_reason;
        }
        if (event.usage) {
          const u = event.usage;
          const next: StreamUsage = { ...(state.usage ?? {}) };
          if (typeof u.output_tokens === 'number') {
            next.completionTokens = u.output_tokens;
          }
          // Recompute total whenever we have at least one side.
          if (
            typeof next.promptTokens === 'number' ||
            typeof next.completionTokens === 'number'
          ) {
            next.totalTokens =
              (next.promptTokens ?? 0) + (next.completionTokens ?? 0);
          }
          state.usage = next;
        }
        return;
      }

      case 'message_stop': {
        // No payload semantics beyond "stream is done". Loop exits on
        // the reader's `done`; we don't need to act here.
        return;
      }

      case 'ping': {
        // Anthropic emits these periodically as keep-alive. Do NOT
        // refresh `lastContentChunkAt` — same rule as OpenAI heartbeats.
        return;
      }

      case 'error': {
        // Server-side error mid-stream. Capture and surface via the
        // post-loop throw so the retry/onDone machinery handles it.
        const err = event.error;
        const message = err?.message ?? 'Anthropic stream error';
        const errType = err?.type ?? 'error';
        state.serverErrorMessage = `Anthropic ${errType}: ${message}`;
        return;
      }

      default:
        // Unknown event type — forward-compat: skip silently.
        return;
    }
  }

  /**
   * Tool-use blocks that never received `content_block_stop` (server
   * closed mid-block). Try to parse whatever JSON has accumulated; if
   * it parses, push as a finished tool call. Otherwise, drop it — a
   * partial call is worse than no call.
   */
  private finaliseHangingToolUses(state: StreamState): void {
    if (state.pendingToolUses.size === 0) return;
    const indices = [...state.pendingToolUses.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const pending = state.pendingToolUses.get(idx);
      if (!pending) continue;
      // Only finalise if we have at least a name; a tool call with no
      // name is unusable.
      if (pending.name.length === 0) {
        state.pendingToolUses.delete(idx);
        continue;
      }
      const trimmed = pending.partialInput.trim();
      if (trimmed.length === 0 || isPossiblyValidJson(trimmed)) {
        state.finishedToolCalls.push(buildToolCallFromPending(pending));
      }
      state.pendingToolUses.delete(idx);
    }
  }

  /**
   * Build the final {@link StreamDoneResult} after a successful
   * streaming run. Mapping from Anthropic stop reasons to our canonical
   * finish-reason universe:
   *   - `'end_turn'`         → `'stop'`
   *   - `'tool_use'`         → `'stop'` (tool calls collapsed into stop)
   *   - `'max_tokens'`       → `'length'`
   *   - `'stop_sequence'`    → `'stop'`
   *   - any other / null     → `'stop'`
   * No-content + no-tool-use + no error → `'error'` empty-response.
   */
  private buildSuccessDoneResult(state: StreamState): StreamDoneResult {
    const usage = state.usage ?? this.estimateUsage(state);
    const durationMs = Date.now() - state.startTime;
    const usagePart = usage ? { usage } : {};

    if (state.stalled) {
      return {
        finishReason: 'error',
        error: `Connection stalled (no content for ${Math.round(
          this.stallTimeoutMs / 1000,
        )}s).`,
        ...usagePart,
        durationMs,
      };
    }

    if (state.serverErrorMessage) {
      return {
        finishReason: 'error',
        error: state.serverErrorMessage,
        ...usagePart,
        durationMs,
      };
    }

    if (state.stopReason === 'max_tokens') {
      return {
        finishReason: 'length',
        error:
          'Response cut off due to max_tokens limit. Increase via /ctxsize or /settings.',
        ...usagePart,
        durationMs,
      };
    }

    if (
      !state.sawAnyContent &&
      state.streamedTextLength === 0 &&
      state.finishedToolCalls.length === 0 &&
      !state.sawToolUse
    ) {
      // Thinking-only path: model emitted only `thinking` and no
      // visible text or tool use.
      if (state.sawThinkingContent) {
        return {
          finishReason: 'thinking-only',
          error:
            'Model produced thinking but no actual reply. Read the thinking above for context, or retry with a more specific prompt.',
          ...usagePart,
          durationMs,
        };
      }
      return {
        finishReason: 'error',
        error:
          'Empty response from model. The server may have closed the connection prematurely.',
        ...usagePart,
        durationMs,
      };
    }

    return {
      finishReason: 'stop',
      ...usagePart,
      durationMs,
    };
  }

  /**
   * If the server didn't surface a usage block (rare), estimate
   * completionTokens from the streamed text length so callers still
   * see something. Mirrors `LLMAdapter#finaliseUsage`.
   */
  private estimateUsage(state: StreamState): StreamUsage | undefined {
    if (state.streamedTextLength <= 0) return undefined;
    // Crude 1 token ≈ 4 chars heuristic — same as context-manager's.
    const completionTokens = Math.max(
      1,
      Math.floor(state.streamedTextLength / 4),
    );
    return {
      completionTokens,
      totalTokens: completionTokens,
      estimated: true,
    };
  }

  // ---------- Request-body construction ----------

  /**
   * Translate our internal {@link Message[]} + {@link ToolSchema[]}
   * pair into Anthropic's request body shape. The major translations:
   *
   *   1. Concatenate all `system` role messages into a single
   *      top-level `system` field (newline-joined). System messages
   *      are removed from the wire `messages` array.
   *   2. Convert assistant `toolCalls` into `tool_use` content blocks
   *      inside the assistant message's `content` array.
   *   3. Convert `tool` role messages (which carry `toolCallId` +
   *      content) into `user` role messages whose `content` is a
   *      single `tool_result` block.
   *   4. Plain user / assistant messages keep simple string content.
   *   5. Tool schemas: unwrap the OpenAI `function` envelope and
   *      rename `parameters` → `input_schema`.
   *   6. Coalesce consecutive same-role messages where Anthropic
   *      would otherwise reject the request (it accepts only
   *      strict alternation user→assistant→user→…).
   */
  private buildRequestBody(params: StreamChatParams): Record<string, unknown> {
    const { systemPrompt, messages } = splitSystemAndMessages(params.messages);
    const wireMessages = coalesceConsecutive(
      messages.map(toAnthropicMessage),
    );

    const generation = this.generation;
    const maxTokensFromGen =
      typeof generation?.maxTokens === 'number' &&
      Number.isFinite(generation.maxTokens) &&
      generation.maxTokens > 0
        ? Math.floor(generation.maxTokens)
        : undefined;
    // Anthropic requires `max_tokens`. Pick the first defined of:
    // generation.maxTokens, contextMaxTokens, then a safe default 4096.
    const maxTokens =
      maxTokensFromGen ?? this.contextMaxTokens ?? 4096;

    const body: Record<string, unknown> = {
      model: params.model ?? this.model,
      messages: wireMessages,
      max_tokens: maxTokens,
      stream: true,
    };

    if (systemPrompt.length > 0) {
      // PROMPT CACHING: emit `system` in array-of-content-blocks form
      // with a `cache_control: { type: 'ephemeral' }` marker on the
      // single text block. Anthropic accepts both the legacy string
      // form and the array form; the array form is REQUIRED for cache
      // markers (the spec attaches `cache_control` to a content block,
      // not to the top-level field). With the marker, every cache hit
      // gives a 90% discount on cached input tokens (5-min TTL); without
      // it, Anthropic does NOT auto-cache and the user pays full price
      // on every turn. Opt-out via `LOCALCODE_DISABLE_PROMPT_CACHE=1`
      // for callers that want the legacy string shape.
      const cacheDisabled =
        typeof process !== 'undefined' &&
        process.env?.LOCALCODE_DISABLE_PROMPT_CACHE === '1';
      if (cacheDisabled) {
        body.system = systemPrompt;
      } else {
        body.system = [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ];
      }
    }

    if (generation) {
      if (
        typeof generation.temperature === 'number' &&
        Number.isFinite(generation.temperature)
      ) {
        body.temperature = generation.temperature;
      }
      if (
        typeof generation.topP === 'number' &&
        Number.isFinite(generation.topP)
      ) {
        body.top_p = generation.topP;
      }
      // No direct mapping for repeat_penalty on Anthropic — it has
      // `top_k` instead, which we don't expose. Skip silently.
    }

    if (params.tools && params.tools.length > 0) {
      // PROMPT CACHING: tag the LAST tool with `cache_control:
      // {type:'ephemeral'}`. Anthropic's cache semantics are
      // "everything before-and-including a cache_control block is
      // cached", so marking only the final tool causes the entire
      // tools array (plus the system prompt above) to ride the cache
      // together — 90% discount on cached input tokens. Earlier tools
      // do NOT need their own marker (would just create extra cache
      // breakpoints, which Anthropic limits to 4 per request).
      const cacheDisabled =
        typeof process !== 'undefined' &&
        process.env?.LOCALCODE_DISABLE_PROMPT_CACHE === '1';
      const wireTools = params.tools.map(toAnthropicTool);
      if (!cacheDisabled && wireTools.length > 0) {
        const lastIdx = wireTools.length - 1;
        const lastTool = wireTools[lastIdx];
        if (lastTool) {
          wireTools[lastIdx] = {
            ...lastTool,
            cache_control: { type: 'ephemeral' },
          };
        }
      }
      body.tools = wireTools;
    }

    // Pass-through extra options (e.g. caller wants to set top_k or a
    // beta-only field). Never overwrite something we already set.
    if (params.options) {
      for (const [k, v] of Object.entries(params.options)) {
        if (!(k in body)) body[k] = v;
      }
    }

    return body;
  }

  // ---------- HTTP helpers ----------

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion,
    };
    if (this.anthropicBeta.length > 0) {
      headers['anthropic-beta'] = this.anthropicBeta.join(',');
    }
    // Custom headers win over canonical ones — caller may need to
    // override `anthropic-version` for a specific request.
    for (const [k, v] of Object.entries(this.customHeaders)) {
      headers[k] = v;
    }
    return headers;
  }

  private joinUrl(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    const p = path.startsWith('/') ? path : `/${path}`;
    return this.baseUrl + p;
  }

  /**
   * C2 — remove this stream's controller from the active set. Always
   * called from `runStreamOnce`'s finally / catch paths so the set
   * stays bounded even if the stream errors out.
   */
  private clearController(controller: AbortController): void {
    this.activeControllers.delete(controller);
  }
}

// ---------- Free helpers (no this) ----------

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * L3 — derive a short, non-reversible fingerprint of the API key for
 * cache keying. NEVER returns the raw key (so a debug dump of the
 * `pingCache` object would not leak the secret) — uses a tiny FNV-1a
 * hash truncated to hex. Collisions across distinct keys are
 * acceptable here because cache hits are scoped to a single adapter
 * instance (each instance has exactly one apiKey).
 */
function shortApiKeyFingerprint(apiKey: string): string {
  // FNV-1a 32-bit. Deterministic, no crypto-strength needed.
  let hash = 0x811c9dc5;
  for (let i = 0; i < apiKey.length; i += 1) {
    hash ^= apiKey.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function mapContentBlockKind(type: string | undefined): ContentBlockKind {
  switch (type) {
    case 'text':
      return 'text';
    case 'tool_use':
      return 'tool_use';
    case 'thinking':
      return 'thinking';
    default:
      return 'unknown';
  }
}

function buildToolCallFromPending(pending: PendingToolUse): ToolCall {
  const args = safeParseJsonObject(pending.partialInput);
  return {
    id: pending.id,
    name: pending.name,
    arguments: args,
  };
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { _value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function isPossiblyValidJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a single Anthropic SSE frame. Anthropic frames are emitted in
 * the standard SSE form:
 *
 *     event: <type>
 *     data: <json>
 *
 * The `event:` field is REDUNDANT — Anthropic always includes the same
 * `type` field inside the JSON payload, and that's what we key on. We
 * therefore parse only the `data:` line(s), join them, and route the
 * JSON through the Zod schema. Unknown / malformed frames return
 * `null`.
 */
function parseAnthropicSSEFrame(raw: string): AnthropicEvent | null {
  if (raw.length === 0) return null;
  const lines = raw.split('\n');
  const dataParts: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue; // SSE comment
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      dataParts.push(value);
      continue;
    }
    // Other SSE fields (`event:`, `id:`, `retry:`) are ignored — we
    // discriminate on the JSON `type` field.
  }
  if (dataParts.length === 0) return null;
  const joined = dataParts.join('\n').trim();
  if (joined.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(joined);
  } catch {
    return null;
  }
  const parsed = messageEventSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Anthropic error responses follow the shape
 *   `{ "type": "error", "error": { "type": "...", "message": "..." } }`
 * Best-effort extract a human-readable message; fall back to the raw
 * text if we can't parse.
 */
function parseAnthropicError(detail: string): string {
  try {
    const parsed: unknown = JSON.parse(detail);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      const top = parsed as Record<string, unknown>;
      const inner = top.error;
      if (
        inner !== null &&
        typeof inner === 'object' &&
        !Array.isArray(inner)
      ) {
        const errObj = inner as Record<string, unknown>;
        const type =
          typeof errObj.type === 'string' ? errObj.type : 'error';
        const msg =
          typeof errObj.message === 'string' ? errObj.message : '';
        if (msg.length > 0) return `${type}: ${msg}`;
      }
    }
  } catch {
    // fall through
  }
  return detail;
}

/** Anthropic-shaped content block in our outgoing wire payload. */
// MULTIMODAL-SECTION start — image variant + url/base64 source types.
type AnthropicImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

type AnthropicWireContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'image'; source: AnthropicImageSource };
// MULTIMODAL-SECTION end

/** Anthropic-shaped message in our outgoing wire payload. */
interface AnthropicWireMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicWireContentBlock[];
}

/**
 * Pull `system` role messages out of the array and concatenate their
 * content (newline-joined) into a single top-level prompt. The
 * remaining messages are returned in original order.
 */
function splitSystemAndMessages(
  messages: ReadonlyArray<Message>,
): { systemPrompt: string; messages: Message[] } {
  const systemParts: string[] = [];
  const rest: Message[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const content =
        typeof m.content === 'string' ? m.content : safeStringify(m.content);
      if (content.length > 0) systemParts.push(content);
      continue;
    }
    rest.push(m);
  }
  return {
    systemPrompt: systemParts.join('\n\n'),
    messages: rest,
  };
}

/**
 * Stringify a non-string content payload defensively. Anthropic's
 * adapter doesn't (yet) support multimodal content the same way the
 * OpenAI adapter does; if a caller smuggled an array through
 * `Message.content`, fall back to JSON-stringify rather than crash.
 */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Translate one of our internal {@link Message} records into the
 * matching Anthropic wire shape. Branches on role:
 *
 *   - `user` (no toolCallId) → `{role: 'user', content: '<text>'}`.
 *   - `assistant` with toolCalls → `{role: 'assistant', content: [
 *       {type:'text',text:'…'}, {type:'tool_use',id,name,input}, …
 *     ]}`. Empty text blocks are omitted.
 *   - `assistant` without toolCalls → string content.
 *   - `tool` (toolCallId set) → `{role: 'user', content: [{type:
 *       'tool_result', tool_use_id, content}]}`. Anthropic does NOT
 *       have a `tool` role — tool results are echoed back as a user
 *       message with a single tool_result block.
 *   - `system` should have been peeled off upstream; if one slips in,
 *     we bury its content in a user message rather than crash.
 */
function toAnthropicMessage(m: Message): AnthropicWireMessage {
  // MULTIMODAL-SECTION start — detect MessageContentPart[] smuggled
  // through Message.content (typed as `string` in the public domain
  // type but populated as an array by `buildImageMessage` and similar
  // helpers). When present, translate each part into Anthropic's
  // content-block shape; `image_url` parts become `image` blocks with
  // a `source` of either `base64` (for `data:<mime>;base64,...` URIs)
  // or `url` (for `http(s)://...`).
  const rawContent: unknown = m.content;
  const multimodal: MessageContentPart[] | null = isMessageContentPartArray(
    rawContent,
  )
    ? rawContent
    : null;

  if (multimodal !== null && m.role !== 'tool') {
    const blocks = toAnthropicMessageContent(multimodal);
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
    }
    const role: 'user' | 'assistant' =
      m.role === 'assistant' ? 'assistant' : 'user';
    return { role, content: blocks };
  }
  // MULTIMODAL-SECTION end

  const text = typeof m.content === 'string' ? m.content : safeStringify(m.content);

  if (m.role === 'tool') {
    const toolUseId = m.toolCallId ?? '';
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: text,
        },
      ],
    };
  }

  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    const blocks: AnthropicWireContentBlock[] = [];
    if (text.length > 0) {
      blocks.push({ type: 'text', text });
    }
    for (const tc of m.toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      });
    }
    return { role: 'assistant', content: blocks };
  }

  // Plain user / assistant / (defensive) system → simple text content.
  const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
  return { role, content: text };
}

/**
 * MULTIMODAL-SECTION — translate OpenAI-shaped `MessageContentPart[]`
 * into Anthropic content blocks. `text` parts pass through unchanged.
 * `image_url` parts split on the URL scheme:
 *
 *   - `data:image/<mime>;base64,<payload>` → `{ type: 'image', source:
 *       { type: 'base64', media_type, data } }`. The `<mime>` segment
 *       is taken verbatim; if it is not in the Anthropic-supported
 *       set (`png | jpeg | gif | webp`), we still forward it — Anthropic
 *       will reject unknown types and the user can adjust.
 *   - `http://...` or `https://...` → `{ type: 'image', source:
 *       { type: 'url', url } }`. Anthropic's `url` source variant was
 *       added in late-2024 and is the official path for non-base64
 *       images.
 *
 * Malformed `image_url` entries (no URL, unrecognised scheme) are
 * skipped silently — Anthropic would 400 on the request otherwise and
 * the user would be left without a useful error.
 */
export function toAnthropicMessageContent(
  parts: ReadonlyArray<MessageContentPart>,
): AnthropicWireContentBlock[] {
  const blocks: AnthropicWireContentBlock[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.length > 0) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url') {
      const url = part.image_url.url;
      if (typeof url !== 'string' || url.length === 0) continue;
      const block = imageUrlToAnthropicBlock(url);
      if (block !== null) blocks.push(block);
      continue;
    }
  }
  return blocks;
}

const DATA_URI_RE = /^data:([^;,]+);base64,([\s\S]+)$/i;

function imageUrlToAnthropicBlock(
  url: string,
): AnthropicWireContentBlock | null {
  if (url.startsWith('data:')) {
    const match = DATA_URI_RE.exec(url);
    if (!match) return null;
    const mediaType = match[1]?.toLowerCase() ?? '';
    const data = match[2] ?? '';
    if (mediaType.length === 0 || data.length === 0) return null;
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data },
    };
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

/**
 * Collapse consecutive same-role messages into a single message.
 * Anthropic's API requires strict alternation (`user → assistant →
 * user → …`); two adjacent user messages cause a 400. We merge by:
 *   - If both contents are strings, join with a blank line.
 *   - If either is a content-block array, concatenate the block lists
 *     (after coercing the string content to a single text block).
 */
function coalesceConsecutive(
  messages: AnthropicWireMessage[],
): AnthropicWireMessage[] {
  if (messages.length <= 1) return messages;
  const out: AnthropicWireMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (!last || last.role !== m.role) {
      out.push(m);
      continue;
    }
    out[out.length - 1] = mergeMessages(last, m);
  }
  return out;
}

function mergeMessages(
  a: AnthropicWireMessage,
  b: AnthropicWireMessage,
): AnthropicWireMessage {
  if (typeof a.content === 'string' && typeof b.content === 'string') {
    const aTxt = a.content;
    const bTxt = b.content;
    if (aTxt.length === 0) return { role: a.role, content: bTxt };
    if (bTxt.length === 0) return { role: a.role, content: aTxt };
    return { role: a.role, content: `${aTxt}\n\n${bTxt}` };
  }
  const aBlocks = toBlockArray(a.content);
  const bBlocks = toBlockArray(b.content);
  return { role: a.role, content: [...aBlocks, ...bBlocks] };
}

function toBlockArray(
  content: string | AnthropicWireContentBlock[],
): AnthropicWireContentBlock[] {
  if (Array.isArray(content)) return content;
  if (content.length === 0) return [];
  return [{ type: 'text', text: content }];
}

/**
 * Translate an OpenAI-shaped {@link ToolSchema} into Anthropic's tool
 * wire shape:
 *   - Strip the `function` wrapper.
 *   - Rename `parameters` → `input_schema`.
 *   - Pass `name` and `description` through unchanged.
 */
/**
 * Anthropic tool wire shape. `cache_control` is OPTIONAL — only the
 * last tool in the array gets it (see {@link buildRequestBody}); the
 * marker tells Anthropic to cache everything before-and-including the
 * tagged block.
 */
interface AnthropicWireTool {
  name: string;
  description: string;
  input_schema: ToolSchema['function']['parameters'];
  cache_control?: { type: 'ephemeral' };
}

function toAnthropicTool(tool: ToolSchema): AnthropicWireTool {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  };
}

// ---------- Error utilities ----------

export class HttpError extends Error {
  public readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  ) {
    return true;
  }
  return false;
}

/**
 * Same classification as the OpenAI-compat adapter: count network /
 * 5xx / generic errors as transient backend failures for the circuit
 * breaker. AbortError and circuit-open rejections do NOT count.
 */
function isAnthropicTransientForBreaker(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof BackendCircuitOpenError) return false;
  if (error instanceof HttpError) {
    if (error.status === 429) return true;
    return error.status >= 500;
  }
  if (error instanceof TypeError) return true;
  if (error instanceof Error) return true;
  return false;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof HttpError) {
    // 4xx → caller error; retry won't help. 5xx and unknowns retry.
    // 429 (rate limit) IS retryable.
    if (error.status === 429) return true;
    return error.status >= 500;
  }
  if (isAbortError(error)) return false;
  if (error instanceof TypeError) return true;
  if (error instanceof Error) return true;
  return false;
}

function errorMessage(error: unknown): string {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
  } catch {
    return '';
  }
}

function onceDone(
  onDone: ((result: StreamDoneResult) => void) | undefined,
): (result: StreamDoneResult) => void {
  let fired = false;
  return (result): void => {
    if (fired) return;
    fired = true;
    onDone?.(result);
  };
}
