/**
 * LLMAdapter — HTTP client for any OpenAI-compatible Chat Completions server.
 *
 * Primary targets: LM Studio (`http://localhost:1234/v1`) and Ollama
 * (`http://localhost:11434` — we try `/v1/models` first, fall back to
 * `/api/tags` for older builds). Only the OpenAI surface is required for
 * streaming chat completions.
 *
 * Streaming is implemented with native `fetch` + `ReadableStream`; no SSE
 * library dependency. Tool-call deltas arrive indexed; we accumulate per
 * index and emit the finished batch once `finish_reason === "tool_calls"`.
 *
 * Retry: 3 attempts with 1s/2s/4s exponential backoff, but *only* for
 * network / DNS / connection-reset errors. 4xx responses fail fast because
 * they almost always indicate a malformed request that retries won't fix.
 */

import { z } from 'zod';
import type { Backend, GenerationConfig, Message, ToolCall } from '@/types/global';
import {
  HarmonyFilter,
  ThinkingBlockSplitter,
  parseSSEChunk,
  splitSSEFrames,
} from '@/llm/streaming';
import {
  DEFAULT_TRIM_TOOL_RESULTS_AFTER,
  estimateTokens,
  trimOldToolResults,
} from '@/llm/context-manager';
import type {
  ChatCompletionChunk,
  MessageContentPart,
  StreamChatParams,
  StreamDoneResult,
  StreamUsage,
  ToolCallDelta,
  Usage,
  WireMessage,
} from '@/types/message';
import { isMessageContentPartArray } from '@/types/message';
import { captureFailure, type RequestTiming } from '@/llm/diagnostics';
import {
  BackendCircuitOpenError,
  globalBreakerRegistry,
  registryKey,
} from '@/llm/circuit-breaker';
// INFERENCE-CONTROL-SECTION
import type { CapabilityReport } from '@/llm/inference-control';
import { isLocalInferenceBackend } from '@/llm/inference-control';
import type { InferenceMode } from '@/types/global';
// INFERENCE-CONTROL-SECTION-END

// ---------- External response validation ----------

const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

const ollamaTagsResponseSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      model: z.string().optional(),
    })
  ),
});

// ---------- Config ----------

export interface LLMAdapterConfig {
  baseUrl: string;
  model: string;
  /**
   * R28 (Agent A) — widened to the full {@link Backend} enum to support
   * cloud providers via the same OpenAI-compatible Chat Completions
   * surface (`openai`, `openrouter`, `google`, `custom`) alongside the
   * existing local backends (`ollama`, `lmstudio`). Anthropic uses a
   * separate adapter (`AnthropicAdapter`) — when this adapter is
   * constructed with `backend: 'anthropic'` it falls back to the
   * LM-Studio-style request shape, which is harmless because an
   * Anthropic call site should not reach this adapter at all.
   *
   * The wire-body branching previously toggled on `'ollama' | 'lmstudio'`
   * — we collapse "everything that isn't Ollama" onto the LM Studio
   * path, since OpenAI / OpenRouter / Groq / Together / Fireworks /
   * Mistral all accept the OpenAI top-level `temperature` / `top_p` /
   * `max_tokens` shape that LM Studio uses.
   */
  backend?: Backend;
  /**
   * R28 (Agent A) — API key for cloud providers (OpenAI, OpenRouter,
   * generic OpenAI-compat). Forwarded as `Authorization: Bearer
   * <apiKey>`. Local providers (`ollama`, `lmstudio`) leave this
   * undefined; the header is omitted in that case.
   *
   * Anthropic also leaves this slot empty here — the Anthropic adapter
   * has its own header convention (`x-api-key`) and reads the key
   * separately from `BackendConfig.apiKey` via `resolveApiKey`.
   */
  apiKey?: string;
  /**
   * R28 (Agent A) — extra request headers, forwarded verbatim on every
   * outbound request. Useful for proxies, custom auth schemes, and
   * aggregator-specific tagging headers (OpenRouter's HTTP-Referer /
   * X-Title are added automatically; explicit entries here override).
   *
   * Header keys are case-insensitive on the wire but we preserve the
   * caller's exact casing to make debugging easier.
   */
  customHeaders?: Record<string, string>;
  /** Max retry attempts on network errors. Default 3. */
  maxAttempts?: number;
  /**
   * Max retry attempts when the failure is classified as transient
   * (e.g. OpenRouter wraps an upstream provider 5xx as a transient
   * 400, or we get a 429 / 5xx that signals "try again"). Defaults to
   * 6 for the OpenRouter backend (where transient blips are common
   * and re-routing to a different upstream usually succeeds) and to
   * `maxAttempts` for everyone else. Callers can override per-backend.
   */
  transientMaxAttempts?: number;
  /** Initial backoff in ms. Doubles each attempt. Default 1000. */
  initialBackoffMs?: number;
  /**
   * Cap on the per-attempt backoff after the schedule has grown.
   * Default 30_000 (30s). The transient-retry schedule (2s, 4s, 8s,
   * 16s, 24s, 30s) clamps each step to this ceiling before jitter is
   * applied. Total wall-clock budget at the default schedule is ~84s.
   */
  maxBackoffMs?: number;
  /** Connect/read timeout in ms applied to the POST (not per-chunk). Default 120000. */
  requestTimeoutMs?: number;
  /** Timeout for ping in ms. Default 2000. */
  pingTimeoutMs?: number;
  /**
   * Max number of context tokens the model should allocate (forwarded
   * as `options.num_ctx` to Ollama). LM Studio ignores this — its
   * context size is fixed at model-load time.
   */
  contextMaxTokens?: number;
  /**
   * How long Ollama should keep the model resident in VRAM after the
   * request (forwarded as `keep_alive`). Expressed in seconds; will be
   * sent as `"<N>s"`.
   */
  keepAliveSeconds?: number;
  /**
   * Abort the stream if no VISIBLE-content chunk arrives for this many
   * milliseconds. Defaults to 180_000 (180s).
   *
   * R10 / FIX B: the watchdog now measures gaps between deltas that
   * actually carry visible content (`delta.content` outside a
   * `<think>` block, or `delta.tool_calls`). Heartbeats, `[DONE]`
   * markers, and thinking-only deltas do NOT reset the timer. This
   * lets us catch hangs where Qwen-style models scan the prompt and
   * then loop inside `<think>` while the server keeps the socket
   * alive.
   *
   * Set to a very large number to effectively disable the stall
   * detector.
   */
  stallTimeoutMs?: number;
  /**
   * Generation knobs (temperature, top_p, repeat_penalty, max_tokens).
   * When supplied, the adapter merges them into every `streamChat`
   * request body in a backend-aware shape:
   *   - Ollama:   `options.{num_predict, repeat_penalty, temperature, top_p}`
   *   - LM Studio (OpenAI-compatible): top-level `temperature`,
   *     `top_p`, `max_tokens`, `frequency_penalty: repeatPenalty - 1`.
   * Backwards-compatible: omitting `generation` leaves request bodies
   * unchanged (existing R2 tests stay green).
   */
  generation?: GenerationConfig;
  /**
   * R26 (Agent A, ROADMAP #5) — number of recent tool-role messages to
   * keep verbatim in the wire payload. Older tool results are collapsed
   * into a one-line stub before being sent to the LLM. Reduces prompt
   * tokens by 40-60% on long sessions where the model has been reading
   * many files. The full content stays in SQLite — collapse is purely
   * a view transformation. Default 5 (see
   * {@link DEFAULT_TRIM_TOOL_RESULTS_AFTER}). Set to a very large
   * number (or `Infinity`) to effectively disable the trim.
   */
  trimToolResultsAfter?: number;
  /**
   * R26 (Agent A, ROADMAP #6) — coalesce streaming text deltas into
   * batches before invoking `onChunk`. The first chunk fires
   * immediately (so the user sees a response start instantly); after
   * that, deltas are buffered and flushed when EITHER:
   *   - the buffer reaches {@link CHUNK_BATCH_FLUSH_CHARS} characters, OR
   *   - this many milliseconds have elapsed since the last flush, OR
   *   - the buffer contains a `\n` (line boundary — flushed eagerly so
   *     code blocks render row-by-row), OR
   *   - the stream ends (`flushPipeline` drains everything).
   *
   * Default 30ms. Set to 0 to disable batching entirely (every delta
   * fires immediately, which is the legacy behaviour). 30ms gives
   * roughly 33 paints/sec under continuous streaming — well within
   * the ChatScreen throttle window (R25's 150ms) so we don't add
   * UI latency.
   */
  chunkBatchMs?: number;
  /**
   * R26 (Agent A, ROADMAP #12) — when `true`, the adapter adds
   * `response_format: { type: 'json_object' }` to the request body
   * whenever `tools` is non-empty. LM Studio supports this knob and it
   * forces Qwen / Gemma 7B-class models to emit syntactically valid
   * JSON, which dramatically reduces malformed tool calls.
   *
   * IMPORTANT: this MUST NOT be set for plain text (no-tools) requests
   * — JSON mode will force the model to wrap its prose in JSON, which
   * breaks the visible reply. The adapter only applies the field when
   * `tools.length > 0`, so callers can safely flip this on globally.
   *
   * Default `false` — only enable for weak local models that can't
   * reliably emit tool-call JSON without the constraint. Stronger
   * models (DeepSeek, Llama 3.1 70B+) typically don't need it and
   * the format restriction can hurt their reasoning quality.
   */
  useJsonMode?: boolean;
  /**
   * R26 (Agent A, ROADMAP #13) — when `true`, the adapter inspects
   * the last user message and adjusts the request `temperature`
   * dynamically per-turn:
   *   - Coding-style verbs ("write", "implement", "fix", ...) → 0.1
   *   - Brainstorm / explanation verbs ("explain", "why", ...) →
   *     the configured base temperature (no change)
   *   - Tool-call in flight (assistant has issued tool calls and is
   *     awaiting the result) → 0.0
   *   - Otherwise → base temperature.
   *
   * The adjustment is applied AFTER the static `generation.temperature`
   * is merged in, so the dynamic value wins. Default `false` —
   * preserves existing R5 test expectations until callers opt in.
   */
  adaptiveTemperature?: boolean;
  /**
   * When true AND `backend === 'openrouter'`, the adapter writes a
   * sanitized JSON dump of every non-2xx response to
   * `~/.localcode/diagnostics/`. Off by default — flip on temporarily
   * to capture an OpenRouter `400 Provider returned error` for
   * sharing. See `docs/DEBUGGING_OPENROUTER.md`.
   */
  dumpFailedRequests?: boolean;
  // INFERENCE-CONTROL-SECTION
  /**
   * Wave 16B — local-first constrained-decoding inputs. The composition
   * root probes capabilities ONCE (async, outside the hot loop) and
   * injects the precompiled artefacts here so `streamChat` stays
   * synchronous and byte-stable on the system-prompt prefix.
   *
   * The adapter only ATTACHES these to the per-request body when:
   *   1. the resolved backend is LOCAL (ollama/lmstudio/custom — never
   *      cloud), AND
   *   2. the capability report says the knob is honoured, AND
   *   3. the corresponding `inference.*` mode is `'on'` or `'auto'`.
   *
   * Everything goes in the REQUEST body, NEVER the system prompt — the
   * prefix cache stays hot. Absent fields = legacy behaviour (no-op).
   */
  inference?: InferenceControlConfig;
  // INFERENCE-CONTROL-SECTION-END
}

// INFERENCE-CONTROL-SECTION
/**
 * Precomputed constrained-decoding artefacts handed to the adapter by the
 * composition root. Keeping these precomputed (rather than probing /
 * compiling inside `streamChat`) preserves the synchronous, byte-stable
 * request path.
 */
export interface InferenceControlConfig {
  /** Capability report from `probeCapabilities` (cloud → all false). */
  report: CapabilityReport;
  /** `inference.grammarLock` mode. `'auto'` defers to the report. */
  grammarLock: InferenceMode;
  /** `inference.logitBanlist` mode. `'auto'` defers to the report. */
  logitBanlist: InferenceMode;
  /**
   * Precompiled GBNF tool-call grammar. Attached as `grammar` when the
   * report says `grammar: true` and `grammarLock !== 'off'`.
   */
  toolGrammar?: string;
  /**
   * Precomputed token→bias map. Attached as `logit_bias` when the report
   * says `logitBias: true`, `logitBanlist !== 'off'`, and it's non-empty.
   */
  logitBias?: Record<number, number>;
}
// INFERENCE-CONTROL-SECTION-END

interface AccumulatedToolCall {
  index: number;
  id: string;
  name: string;
  argumentsBuffer: string;
}

// ---------- Adapter ----------

export class LLMAdapter {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly backend: Backend | undefined;
  private readonly apiKey: string | undefined;
  private readonly customHeaders: Record<string, string> | undefined;
  private readonly maxAttempts: number;
  private readonly transientMaxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pingTimeoutMs: number;
  private readonly contextMaxTokens: number | undefined;
  private readonly keepAliveSeconds: number | undefined;
  private readonly stallTimeoutMs: number;
  private readonly generation: GenerationConfig | undefined;
  // ---- R26 (Agent A) wiring ----
  private readonly trimToolResultsAfter: number;
  private readonly chunkBatchMs: number;
  private readonly useJsonMode: boolean;
  private readonly adaptiveTemperature: boolean;
  private readonly dumpFailedRequests: boolean;
  // INFERENCE-CONTROL-SECTION
  private readonly inference: InferenceControlConfig | undefined;
  // INFERENCE-CONTROL-SECTION-END

  /**
   * C2 — set (NOT a single slot) of every in-flight stream's abort
   * controller. Each `runStreamOnce` adds its own controller in the
   * try block and removes it in finally via `clearController`. The
   * old single-slot field was overwritten when two `streamChat` calls
   * ran in parallel (which web sessions now do), so a `cancel()` only
   * aborted the most recently started stream and the older one
   * continued in the background. The Set ensures `cancel()` aborts
   * every active controller.
   */
  private readonly activeControllers = new Set<AbortController>();

  constructor(config: LLMAdapterConfig) {
    this.baseUrl = stripTrailingSlash(config.baseUrl);
    this.model = config.model;
    this.backend = config.backend;
    // R28 — API key & custom headers. Empty strings are normalised to
    // `undefined` so an empty `apiKey: ''` from a half-filled config
    // does not produce a `Authorization: Bearer ` header that no
    // server accepts.
    this.apiKey =
      typeof config.apiKey === 'string' && config.apiKey.length > 0
        ? config.apiKey
        : undefined;
    this.customHeaders =
      config.customHeaders && Object.keys(config.customHeaders).length > 0
        ? { ...config.customHeaders }
        : undefined;
    this.maxAttempts = Math.max(1, config.maxAttempts ?? 3);
    // Transient retries get a larger budget. Default 6 for OpenRouter
    // (upstream provider blips clear on retry), `maxAttempts` for
    // everyone else. Caller-supplied value always wins.
    const defaultTransient =
      config.backend === 'openrouter' ? 6 : this.maxAttempts;
    this.transientMaxAttempts = Math.max(
      this.maxAttempts,
      config.transientMaxAttempts ?? defaultTransient,
    );
    this.initialBackoffMs = Math.max(0, config.initialBackoffMs ?? 1000);
    this.maxBackoffMs = Math.max(
      this.initialBackoffMs,
      config.maxBackoffMs ?? 30_000,
    );
    this.requestTimeoutMs = Math.max(1000, config.requestTimeoutMs ?? 120_000);
    this.pingTimeoutMs = Math.max(100, config.pingTimeoutMs ?? 2_000);
    this.contextMaxTokens =
      typeof config.contextMaxTokens === 'number' && config.contextMaxTokens > 0
        ? Math.floor(config.contextMaxTokens)
        : undefined;
    this.keepAliveSeconds =
      typeof config.keepAliveSeconds === 'number' && config.keepAliveSeconds >= 0
        ? Math.floor(config.keepAliveSeconds)
        : undefined;
    this.stallTimeoutMs = Math.max(1000, config.stallTimeoutMs ?? 180_000);
    this.generation = config.generation;
    // R26 — keep `trimToolResultsAfter` permissive: NaN/negative → 0
    // (collapse all old tool results); Infinity / huge values pass
    // through so callers can effectively disable the trim by setting
    // a large number. We use the DEFAULT constant so the runtime
    // behaviour matches the comment in LLMAdapterConfig.
    const rawTrim = config.trimToolResultsAfter;
    this.trimToolResultsAfter =
      typeof rawTrim === 'number' && Number.isFinite(rawTrim) && rawTrim >= 0
        ? Math.floor(rawTrim)
        : typeof rawTrim === 'number' && rawTrim === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : DEFAULT_TRIM_TOOL_RESULTS_AFTER;
    // R26 — `chunkBatchMs`: clamped to [0, 5_000ms]. 0 disables batching.
    const rawBatch = config.chunkBatchMs;
    this.chunkBatchMs =
      typeof rawBatch === 'number' && Number.isFinite(rawBatch) && rawBatch >= 0
        ? Math.min(5_000, Math.floor(rawBatch))
        : DEFAULT_CHUNK_BATCH_MS;
    this.useJsonMode = config.useJsonMode === true;
    this.adaptiveTemperature = config.adaptiveTemperature === true;
    this.dumpFailedRequests = config.dumpFailedRequests === true;
    // INFERENCE-CONTROL-SECTION
    this.inference = config.inference;
    // INFERENCE-CONTROL-SECTION-END
  }

  /**
   * Infer the wire-body shape kind from the explicit backend or — if
   * missing — from the base URL. We collapse the seven concrete
   * `Backend` values onto two body shapes:
   *
   *   - `'ollama'`   — uses `options.{num_ctx, num_predict, temperature,
   *                    top_p, repeat_penalty}` and top-level
   *                    `keep_alive`. Only Ollama's OpenAI-compat shim
   *                    accepts this shape.
   *   - `'lmstudio'` — vanilla OpenAI shape: top-level `temperature`,
   *                    `top_p`, `max_tokens`, `frequency_penalty`. This
   *                    is what LM Studio, OpenAI, OpenRouter, Groq,
   *                    Together, Fireworks, Mistral, vLLM, llama.cpp
   *                    server, and most other providers expect.
   *
   * Anthropic is dispatched via a SEPARATE adapter (`AnthropicAdapter`,
   * Agent G) and should never construct this adapter — but we
   * defensively map it onto the LM Studio shape so a misconfigured call
   * site degrades to "OpenAI body, wrong endpoint" rather than throwing
   * in the type system.
   */
  private resolveBackend(): 'ollama' | 'lmstudio' {
    if (this.backend === 'ollama') return 'ollama';
    if (this.backend === 'lmstudio') return 'lmstudio';
    if (this.backend) {
      // Cloud / generic OpenAI-compat providers all share the LM Studio
      // request shape (top-level temperature/top_p/max_tokens).
      return 'lmstudio';
    }
    // No explicit backend → infer from URL. Ollama listens on :11434
    // by default; everything else assumed OpenAI-compat.
    return this.baseUrl.includes(':11434') ? 'ollama' : 'lmstudio';
  }

  /**
   * R28 (Agent A) — build the per-request HTTP header map.
   *
   * Header rules per provider:
   *   - `ollama` / `lmstudio`        — no auth, no aggregator headers.
   *   - `openai` / `openrouter` /
   *     `google` / `custom`          — `Authorization: Bearer <apiKey>`
   *                                    when `apiKey` is set.
   *   - `openrouter`                 — also emits `HTTP-Referer` and
   *                                    `X-Title` so requests appear under
   *                                    the LocalCode app on the OR
   *                                    dashboard.
   *   - `anthropic`                  — handled by `AnthropicAdapter`;
   *                                    if it ever lands here we omit
   *                                    auth (the request would 401
   *                                    anyway — there is no behavioural
   *                                    side-effect to add).
   *
   * Custom headers from the user override every default we set —
   * applied last via `Object.assign`.
   */
  private buildRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      // R30 (OpenRouter dial-up audit) — explicit `keep-alive`. Bun's
      // `fetch` already pools connections by default, so this is mostly
      // documentation: it tells any intermediate proxy / aggregator (and
      // the OpenRouter edge) that the client wants to reuse the
      // underlying TCP+TLS session. Saves a fresh TLS handshake (~150-300ms
      // over Atlantic links) on every chat turn after the first.
      Connection: 'keep-alive',
    };

    const backend = this.backend;
    const isOpenAiCompatCloud =
      backend === 'openai' ||
      backend === 'openrouter' ||
      backend === 'google' ||
      backend === 'custom';

    if (this.apiKey && isOpenAiCompatCloud) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    if (backend === 'openrouter') {
      // OpenRouter docs recommend HTTP-Referer + X-Title so the request
      // shows up tagged on the user's dashboard. Not strictly required
      // (OR will accept anonymous requests too) but the dashboard
      // entries are useful when debugging quota / cost.
      headers['HTTP-Referer'] = 'https://github.com/localcode';
      headers['X-Title'] = 'LocalCode';
    }

    // Custom headers override last — proxies, special auth, internal
    // staging environments, etc.
    if (this.customHeaders) {
      Object.assign(headers, this.customHeaders);
    }

    return headers;
  }

  /**
   * R28 (Agent A) — build the headers used for plain GET requests
   * (e.g. `/v1/models`, `/api/tags`). Same auth rules as
   * {@link buildRequestHeaders} but without the SSE `Accept`.
   */
  private buildGetHeaders(): Record<string, string> {
    const headers = this.buildRequestHeaders();
    delete headers.Accept;
    delete headers['Content-Type'];
    return headers;
  }

  /**
   * Abort EVERY in-flight stream. Safe to call when no stream is active.
   *
   * C2 — iterates over `activeControllers` and aborts each. The
   * try/finally in `runStreamOnce` is what actually removes them from
   * the set (via `clearController`), so we don't mutate the set here.
   * If a caller invokes `cancel()` mid-stream, the aborted promise
   * rejects with an AbortError that `streamChat`'s catch block
   * recognises and converts into `onDone({ finishReason: 'aborted' })`.
   */
  cancel(): void {
    for (const c of this.activeControllers) {
      try {
        c.abort();
      } catch {
        // Defensive — `AbortController.abort()` doesn't throw in any
        // runtime we support, but never let a buggy polyfill tank
        // the loop and leave later controllers un-aborted.
      }
    }
  }

  // MODEL-SWAP-SECTION — alias for `cancel()` exposed to the live
  // model-swap path. Semantically identical (we abort every active
  // controller); the rename exists so callers can read code at the
  // call site and understand the INTENT — "interrupt for swap" vs
  // "user pressed Esc to cancel" both flow through here. We also
  // mark this as the seam the model-swap reducer in `app.tsx`
  // listens for: when the host invokes `interruptStream()`, the
  // existing `done: { finishReason: 'aborted' }` path fires and
  // the reducer's swap branch can re-issue with the new model.
  interruptStream(): void {
    this.cancel();
  }

  // ---------- Server info ----------

  /**
   * List available models. Tries the OpenAI `/v1/models` endpoint first,
   * then falls back to Ollama's native `/api/tags` if the server 404s.
   *
   * R28 — for cloud providers we ALWAYS forward `Authorization: Bearer
   * <apiKey>` (via {@link buildGetHeaders}). Without the header,
   * OpenAI / OpenRouter would 401 and the user would see "Failed to
   * list models" with no actionable hint.
   */
  async getModels(): Promise<string[]> {
    const headers = this.buildGetHeaders();
    const primaryUrl = this.joinUrl('/v1/models');
    // R30 — getModels can return 200+ KB of payload (OpenRouter ships
    // hundreds of model entries) and on slow links the legacy
    // `pingTimeoutMs * 4 = 8s` cap fired before the body fully arrived,
    // surfacing as "Failed to list models" with no actionable hint. Use
    // a per-call ceiling that's the larger of (pingTimeoutMs*4, 30s)
    // so caller-supplied higher pings still win, but the floor is
    // network-realistic for cloud providers.
    const modelsTimeoutMs = Math.max(this.pingTimeoutMs * 4, 30_000);
    try {
      const res = await fetchWithTimeout(
        primaryUrl,
        { headers },
        modelsTimeoutMs,
      );
      if (res.ok) {
        const json: unknown = await res.json();
        const parsed = modelsResponseSchema.safeParse(json);
        if (parsed.success) {
          const ids = parsed.data.data.map((m) => m.id);
          // Agent O — for OpenRouter, push `:free` model ids to the
          // bottom of the list. Free-tier models route through
          // capacity-capped providers (Together, HF, etc.) and
          // frequently 404 with "No allowed providers" when those
          // providers are saturated. Keeping them visible (so users
          // who specifically want them can pick) but de-prioritised
          // means the model picker surfaces reliable paid options
          // first. Non-OpenRouter backends preserve the upstream
          // ordering.
          if (this.backend === 'openrouter') {
            ids.sort((a, b) => {
              const aFree = a.includes(':free');
              const bFree = b.includes(':free');
              if (aFree === bFree) return a.localeCompare(b);
              return aFree ? 1 : -1;
            });
          }
          return ids;
        }
      } else if (res.status !== 404) {
        throw new Error(`GET /v1/models failed with status ${res.status}`);
      }
    } catch (error) {
      // Fall through to Ollama fallback on any error — we'll re-raise
      // if that also fails. Cloud providers (`openai`, `openrouter`,
      // `google`, `custom`) and LM Studio do NOT have a meaningful
      // /api/tags fallback; raise immediately so the user sees the real
      // error instead of a misleading "Ollama tags failed" message.
      if (this.backend && this.backend !== 'ollama') {
        throw wrapError('Failed to list models', error);
      }
    }

    // Ollama fallback (also reached when the backend is unspecified —
    // we then try /api/tags speculatively).
    const fallbackUrl = this.joinUrl('/api/tags');
    try {
      const res = await fetchWithTimeout(
        fallbackUrl,
        { headers },
        modelsTimeoutMs,
      );
      if (!res.ok) {
        throw new Error(`GET /api/tags failed with status ${res.status}`);
      }
      const json: unknown = await res.json();
      const parsed = ollamaTagsResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error('Ollama /api/tags returned unexpected shape');
      }
      return parsed.data.models.map((m) => m.name);
    } catch (error) {
      throw wrapError('Failed to list models', error);
    }
  }

  /** Quick liveness check. Returns true iff GET /v1/models 2xx within timeout. */
  async ping(): Promise<boolean> {
    const headers = this.buildGetHeaders();
    const url = this.joinUrl('/v1/models');
    try {
      const res = await fetchWithTimeout(
        url,
        { headers },
        this.pingTimeoutMs,
      );
      if (res.ok) return true;
      // Only fall back to Ollama's /api/tags when the backend is
      // unspecified or explicitly Ollama — cloud providers and LM
      // Studio don't ship that endpoint and the fallback would just
      // produce a misleading "alive" or 404 reply.
      if (
        res.status === 404 &&
        (this.backend === undefined || this.backend === 'ollama')
      ) {
        const fallback = await fetchWithTimeout(
          this.joinUrl('/api/tags'),
          { headers },
          this.pingTimeoutMs,
        );
        return fallback.ok;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ---------- Streaming chat ----------

  /**
   * Stream a chat completion. Callbacks are invoked as tokens arrive; the
   * returned promise resolves once the stream has ended and `onDone` has
   * already fired. The method never throws post-connection — all errors
   * surface through `onDone({ error })`.
   */
  async streamChat(params: StreamChatParams): Promise<void> {
    const done = onceDone(params.onDone);
    const startedAt = Date.now();
    // C1 — `state` is re-initialised at the top of each retry iteration
    // below (via `resetStreamState`). Only `startTime` is cumulative
    // across attempts (it anchors total-duration accounting in the
    // `done` payload). All counters / buffers / per-attempt flags reset
    // so a torn-down first attempt cannot leak its partial fields into
    // the second attempt's `buildSuccessDoneResult` / `finaliseUsage`
    // calls. Without this, e.g. a half-streamed first attempt would
    // make the retry's `visibleContentBuffer` start non-empty and the
    // XML-fallback tool-call path could fire twice.
    const state: StreamState = freshStreamState(startedAt);

    // Circuit breaker — fail fast when the backend is in OPEN state.
    // Without this, every concurrent ChatRuntime independently exhausts
    // its retry budget against a sustained-down upstream. With it, the
    // first batch of failures trips the breaker and subsequent calls
    // reject immediately with an actionable message until the cooldown
    // elapses and a single probe is allowed through.
    const breaker = globalBreakerRegistry.get(
      this.backend ?? 'custom',
      this.baseUrl,
    );
    const breakerCheck = breaker.check();
    if (!breakerCheck.allowed) {
      done({
        finishReason: 'error',
        error: breakerCheck.reason ?? 'Backend circuit open',
        usage: this.finaliseUsage(state),
        durationMs: Date.now() - state.startTime,
      });
      return;
    }

    let attempt = 0;
    let lastError: unknown = null;
    // The wall-clock budget used by `formatRetryExhaustedMessage` —
    // updated as we sleep between attempts so the friendly final error
    // reflects the actual time spent retrying.
    let totalBackoffMs = 0;

    // Hard ceiling on attempts. We start with the regular budget and,
    // the first time we observe a transient error, bump it up to the
    // transient budget. This keeps the legacy fast-fail behaviour for
    // genuine non-transient errors while still giving sustained-down
    // upstream providers more breathing room.
    let attemptCap = this.maxAttempts;

    while (attempt < attemptCap) {
      attempt += 1;
      // C1 — wipe per-attempt fields before each try so a partial
      // first attempt cannot poison the second. `startTime` is
      // preserved (cumulative timing); everything else (counters,
      // finishReason, sawToolCall, buffers) starts from 0.
      if (attempt > 1) resetStreamState(state, startedAt);
      try {
        await this.runStreamOnce(params, state);
        // Build the onDone result based on what the stream actually
        // reported. Order of precedence:
        //   1. stalled → 'error' with stall message.
        //   2. finishReason === 'length' → 'length' with cut-off hint.
        //   3. emptyStream (no content / no tool calls / no finish) → 'error' empty-response.
        //   4. otherwise → 'stop' (covers 'stop', 'tool_calls', null/undefined).
        const finalResult = this.buildSuccessDoneResult(state);
        // Circuit breaker — record 'success' on any non-error finish
        // reason (`stop`, `length`, etc). `error` / `thinking-only`
        // finishes are treated as transient signals to the breaker.
        const failed = finalResult.finishReason === 'error';
        breaker.record(failed ? 'failure' : 'success');
        done(finalResult);
        return;
      } catch (error) {
        lastError = error;
        if (isAbortError(error)) {
          if (state.stalled) {
            done({
              finishReason: 'error',
              error: `Connection stalled (no visible content for ${Math.round(
                this.stallTimeoutMs / 1000
              )}s). Model may be looping inside <think>... or have crashed (common with LM Studio + large context).`,
              usage: this.finaliseUsage(state),
              durationMs: Date.now() - state.startTime,
            });
            return;
          }
          done({
            finishReason: 'aborted',
            error: 'Request cancelled',
            usage: this.finaliseUsage(state),
            durationMs: Date.now() - state.startTime,
          });
          return;
        }
        // First time we see a transient error, widen the attempt cap
        // to the (possibly larger) transient budget so we keep retrying
        // upstream-provider blips even after the regular 3-attempt
        // window has been used.
        if (
          error instanceof HttpError &&
          error.transient &&
          attemptCap < this.transientMaxAttempts
        ) {
          attemptCap = this.transientMaxAttempts;
        }
        if (!isRetryableError(error) || attempt >= attemptCap) {
          // Circuit breaker — only transient failures (network errors +
          // explicit transient HttpError + 5xx) count. A 4xx client
          // bug shouldn't trip the breaker for everyone else.
          if (isTransientForBreaker(error)) {
            breaker.record('failure');
          }
          done({
            finishReason: 'error',
            error: this.formatExhaustedError(
              error,
              attempt,
              attemptCap,
              totalBackoffMs,
            ),
            usage: this.finaliseUsage(state),
            durationMs: Date.now() - state.startTime,
          });
          return;
        }
        // We intentionally do NOT record mid-loop failures — the
        // breaker only sees the final outcome of each `streamChat`
        // call (one success/failure per call). This keeps the retry
        // budget behaviour identical to pre-breaker semantics for
        // tests that exercise it directly, while still letting the
        // breaker accumulate when N consecutive `streamChat` calls
        // exhaust their budgets and surface as failures.
        const delayMs = this.computeBackoffMs(attempt, error);
        // Optional caller-facing surface: tells the UI we're about to
        // sleep + retry. Wrapped in try/catch so a buggy callback
        // can't sabotage the stream.
        const onRetryAttempt = params.onRetryAttempt;
        if (onRetryAttempt) {
          try {
            onRetryAttempt({
              attempt,
              maxAttempts: attemptCap,
              reason: errorMessage(error),
              nextDelayMs: delayMs,
            });
          } catch {
            // Swallow — UI callbacks must never break the retry loop.
          }
        }
        totalBackoffMs += delayMs;
        await sleep(delayMs);
      }
    }
    // Defensive — loop exits normally above.
    done({
      finishReason: 'error',
      error: this.formatExhaustedError(
        lastError,
        attempt,
        attemptCap,
        totalBackoffMs,
      ),
      usage: this.finaliseUsage(state),
      durationMs: Date.now() - state.startTime,
    });
  }

  /**
   * Per-attempt backoff schedule.
   *
   * Transient errors (`HttpError.transient === true`, plus 429 / 5xx
   * passing through `isRetryableError`) follow a 2s, 4s, 8s, 16s, 24s,
   * 30s ladder, clamped at `maxBackoffMs` and multiplied by a uniform
   * jitter factor of `0.5 + Math.random()` so concurrent clients
   * de-synchronise. If the upstream sent a `Retry-After` header
   * (parsed into `HttpError.retryAfterMs`), we use `max(retryAfter,
   * scheduled)` so we always honour an explicit server hint.
   *
   * Non-transient retries (e.g. a generic `TypeError` from fetch on a
   * dropped socket) keep the legacy 1s/2s/4s exponential schedule from
   * `initialBackoffMs` so existing tests / behaviour stay intact.
   */
  private computeBackoffMs(attempt: number, error: unknown): number {
    const isTransient = error instanceof HttpError && error.transient;
    let scheduled: number;
    if (isTransient) {
      // Ladder index `attempt - 1`. Step values in seconds: 2, 4, 8,
      // 16, 24, 30. Beyond the array we clamp at the cap.
      const ladderSec = [2, 4, 8, 16, 24, 30];
      const idx = Math.min(attempt - 1, ladderSec.length - 1);
      const stepSec = ladderSec[idx] ?? 30;
      scheduled = Math.min(stepSec * 1000, this.maxBackoffMs);
    } else {
      const exp = this.initialBackoffMs * Math.pow(2, attempt - 1);
      scheduled = Math.min(exp, this.maxBackoffMs);
    }
    // Honour Retry-After if present.
    const retryAfter =
      error instanceof HttpError && typeof error.retryAfterMs === 'number'
        ? error.retryAfterMs
        : 0;
    const base = Math.max(scheduled, retryAfter);
    // Jitter: uniform in [0.5, 1.5). Skip when scheduled is 0 to keep
    // tests with `initialBackoffMs: 0` deterministic.
    if (base === 0) return 0;
    const jitter = 0.5 + Math.random();
    return Math.floor(base * jitter);
  }

  /**
   * Friendly retry-exhausted error message. Matches the spec format:
   *   "Failed after N retries over Ns seconds — upstream provider is
   *    sustained-down. Try again in a minute or switch model/provider."
   *
   * Falls back to the raw error message when the error wasn't
   * transient (so cancel/4xx/network paths keep their existing copy).
   */
  private formatExhaustedError(
    error: unknown,
    attempt: number,
    attemptCap: number,
    totalBackoffMs: number,
  ): string {
    const raw = errorMessage(error);
    const isTransient = error instanceof HttpError && error.transient;
    if (!isTransient) return raw;
    const seconds = Math.max(1, Math.round(totalBackoffMs / 1000));
    return (
      `Failed after ${attempt} retries (cap ${attemptCap}) over ${seconds} seconds — ` +
      `upstream provider is sustained-down. Try again in a minute or switch ` +
      `model/provider.\nRaw: ${raw}`
    );
  }

  /**
   * Run several `streamChat` requests in parallel with a bounded
   * concurrency cap. Each request carries its own `onChunk` / `onDone`
   * callbacks from its own params — this method does NOT replace them;
   * it simply schedules the streams and collects a per-slot summary
   * after every one has settled.
   *
   * Returns an array whose order matches `requests`. Each slot contains:
   *   - `messages`: the assistant/tool messages that came out of the
   *     stream. For the scheduling primitive we return an empty array
   *     (the caller's `onChunk` / `onToolCalls` already received the
   *     content); callers that need a post-hoc list can accumulate it
   *     inside their own `onChunk` and inject it here via a wrapped
   *     params object. Kept in the signature so higher-level dispatchers
   *     (Agent 8 R3) have a forward-compatible shape.
   *   - `usage`: the final `Usage` triple if the stream reported one.
   *   - `error`: the error string from `StreamDoneResult.error`, if any.
   *
   * If a slot's stream aborts mid-flight (user cancel, network error),
   * OTHER slots still finish — the aggregate collects the error and
   * returns normally.
   *
   * NOTE: LM Studio concurrency is configurable server-side; default
   * max_concurrent is 1. If the user has increased it (LM Studio > 0.3),
   * this helps. Otherwise requests queue server-side anyway — but our
   * local scheduling here is still useful for cleaner error isolation +
   * cancel semantics.
   */
  async streamMultiple(
    requests: readonly StreamChatParams[],
    options?: { maxConcurrent?: number },
  ): Promise<
    Array<{ messages: Message[]; usage?: Usage; error?: string }>
  > {
    const max = Math.max(1, Math.floor(options?.maxConcurrent ?? 2));
    if (requests.length === 0) return [];

    return mapWithConcurrency(
      requests,
      (req) => this.runSingleForMultiple(req),
      max,
    );
  }

  /**
   * Run a single `streamChat` request for `streamMultiple`, wrapping the
   * caller's `onDone` so we can capture usage/error after the stream
   * completes. The caller's original callbacks (including their own
   * `onDone`) still fire — we chain on top of them. Never throws.
   */
  private async runSingleForMultiple(
    req: StreamChatParams,
  ): Promise<{ messages: Message[]; usage?: Usage; error?: string }> {
    let capturedUsage: Usage | undefined;
    let capturedError: string | undefined;

    const originalOnDone = req.onDone;
    const wrappedParams: StreamChatParams = {
      ...req,
      onDone: (result: StreamDoneResult): void => {
        if (typeof result.error === 'string' && result.error.length > 0) {
          capturedError = result.error;
        }
        if (result.usage) {
          capturedUsage = toUsage(result.usage);
        }
        // Preserve the caller's own onDone.
        if (originalOnDone) {
          try {
            originalOnDone(result);
          } catch (err) {
            // Don't let a user callback failure tank the aggregate.
            // eslint-disable-next-line no-console
            console.warn(
              `[streamMultiple] caller onDone threw: ${errorMessage(err)}`,
            );
          }
        }
      },
    };

    try {
      await this.streamChat(wrappedParams);
    } catch (err) {
      // streamChat is documented as not throwing post-connection, but
      // defensively swallow pre-connection throws too so siblings finish.
      capturedError = capturedError ?? errorMessage(err);
    }

    const slot: { messages: Message[]; usage?: Usage; error?: string } = {
      messages: [],
    };
    if (capturedUsage) slot.usage = capturedUsage;
    if (typeof capturedError === 'string') slot.error = capturedError;
    return slot;
  }

  /**
   * Build the `StreamDoneResult` after a *successful* `runStreamOnce`
   * (no thrown error). Captures all of the diagnostic signals tracked
   * in {@link StreamState} and turns them into the appropriate
   * finish-reason / error pair.
   *
   * Precedence (first match wins):
   *   1. `state.stalled`        → 'error', stall message.
   *   2. `finishReason==='length'` → 'length', max-tokens hint.
   *   3. thinking-only           → 'thinking-only', actionable hint.
   *      (Stream completed but only `<think>` content was produced;
   *       no visible bytes ever reached the user.)
   *   4. `state.emptyStream`    → 'error', empty-response message.
   *   5. otherwise              → 'stop' (covers 'stop', 'tool_calls',
   *                                       null/undefined and any other
   *                                       custom string the server sent).
   */
  private buildSuccessDoneResult(state: StreamState): StreamDoneResult {
    const usage = this.finaliseUsage(state);
    const durationMs = Date.now() - state.startTime;

    if (state.stalled) {
      return {
        finishReason: 'error',
        error: `Connection stalled (no visible content for ${Math.round(
          this.stallTimeoutMs / 1000,
        )}s). Model may be looping inside <think>... or have crashed (common with LM Studio + large context).`,
        ...(usage ? { usage } : {}),
        durationMs,
      };
    }

    if (state.finishReason === 'length') {
      return {
        finishReason: 'length',
        error:
          'Response cut off due to max_tokens limit. Increase via /ctxsize or /settings.',
        ...(usage ? { usage } : {}),
        durationMs,
      };
    }

    // FIX C / R13: thinking-only finish. The stream completed cleanly
    // (or hit `[DONE]`) but we never received a visible content byte —
    // only `<think>...</think>` reasoning. Tool calls do NOT count as
    // thinking-only because `sawToolCall` already short-circuits the
    // empty-stream path. R13: the user now SEES the thinking content
    // in the UI (it was forwarded via `onThinkingChunk`), so we
    // upgrade the error message from "Model produced only thinking
    // content" to a friendlier hint pointing them at the rendered
    // reasoning above.
    const visibleBytesEmitted = state.streamedTextLength > 0;
    if (
      !visibleBytesEmitted &&
      !state.sawToolCall &&
      state.sawThinkingContent
    ) {
      return {
        finishReason: 'thinking-only',
        error:
          'Model produced thinking but no actual reply. Read the thinking above for context, or retry with a more specific prompt.',
        ...(usage ? { usage } : {}),
        durationMs,
      };
    }

    if (state.emptyStream) {
      return {
        finishReason: 'error',
        error:
          'Empty response from model. The server may have closed the connection prematurely.',
        ...(usage ? { usage } : {}),
        durationMs,
      };
    }

    return {
      finishReason: 'stop',
      ...(usage ? { usage } : {}),
      durationMs,
    };
  }

  /**
   * Compute the final `StreamUsage` for `onDone`. Prefer server-reported
   * values when present, else estimate from the streamed text length.
   */
  private finaliseUsage(state: StreamState): StreamUsage | undefined {
    if (state.usage) return state.usage;
    if (state.streamedTextLength > 0) {
      const completionTokens = estimateTokens(state.streamedTextLength);
      return {
        completionTokens,
        totalTokens: completionTokens,
        estimated: true,
      };
    }
    return undefined;
  }

  // ---------- internals ----------

  private async runStreamOnce(
    rawParams: StreamChatParams,
    state: StreamState
  ): Promise<void> {
    // R26 (Agent A, ROADMAP #6) — wrap `onChunk` with a batching
    // layer. Subsequent code in this method uses `params` (the wrapped
    // shape) so every emit goes through the batcher. The batcher is
    // a no-op when `chunkBatchMs === 0` and emits the very first
    // delta immediately so the user sees a response start instantly.
    const batcher = this.chunkBatchMs > 0 && rawParams.onChunk
      ? new ChunkBatcher(rawParams.onChunk, this.chunkBatchMs)
      : null;
    const params: StreamChatParams = batcher
      ? { ...rawParams, onChunk: (text) => batcher.push(text) }
      : rawParams;

    const controller = new AbortController();
    // C2 — register in the active-controller set; `clearController`
    // removes us in every exit path (catch + finally), so the set
    // stays bounded even if the stream errors out mid-flight.
    this.activeControllers.add(controller);

    const externalSignal = rawParams.signal;
    const externalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', externalAbort, { once: true });
      }
    }

    const url = this.joinUrl('/v1/chat/completions');
    const body = this.buildRequestBody(params);
    // Capture for failure dumps. Sanitization happens inside
    // `captureFailure` so we hold the raw values here.
    const requestHeadersForDump = this.buildRequestHeaders();

    // R30 (OpenRouter dial-up audit) — TTFB instrumentation.
    //
    // We measure with `performance.now()` rather than `Date.now()` so
    // wall-clock skew (NTP corrections, sleep/resume) cannot poison
    // the deltas. The timing breakdown is forwarded into failure
    // dumps and the `StreamDoneResult` so users debugging "why is
    // OpenRouter so slow?" can pinpoint:
    //
    //   - `connectMs` ballooned   → cold TLS handshake or saturated
    //                                upstream provider routing.
    //   - `firstByteMs` ballooned → prefix-cache miss / model ramp-up
    //                                on the upstream provider.
    //   - both healthy, totalMs   → genuine generation latency
    //     huge                      (long completion or slow tokens/sec).
    const fetchStartedAt = performance.now();
    let headersReceivedAt: number | null = null;
    let firstVisibleByteAt: number | null = null;
    const buildTiming = (): RequestTiming => {
      const t: RequestTiming = {};
      if (headersReceivedAt !== null) {
        t.connectMs = Math.max(0, Math.floor(headersReceivedAt - fetchStartedAt));
      }
      if (headersReceivedAt !== null && firstVisibleByteAt !== null) {
        t.firstByteMs = Math.max(
          0,
          Math.floor(firstVisibleByteAt - headersReceivedAt),
        );
      }
      t.totalMs = Math.max(0, Math.floor(performance.now() - fetchStartedAt));
      return t;
    };

    // R15 (Agent 8) — `requestTimeoutMs` is now a CONNECT-ONLY timeout.
    //
    // PRIOR BUG: this timer was kept armed for the entire stream lifetime
    // (default 120s). For long completions on local LLMs (5000+ tokens
    // can take >120s on slower hardware), it would fire `controller.abort()`
    // mid-stream after a perfectly healthy generation, surfacing as
    // `(stream error) Request cancelled` even though the server (LM
    // Studio / Ollama) had completed cleanly. The user observed this
    // as a phantom cancellation accompanied by an LM Studio
    // `channelSend for unknown channel` warning — our abort raced LM
    // Studio's slot release.
    //
    // FIX: clear the connect timer as soon as we have a 2xx response
    // and an open body. From that point on the watchdog (`stallTimeoutMs`,
    // user-configurable via `responseTimeoutSeconds`) takes over —
    // it's content-aware (refreshes on every visible/thinking byte)
    // and therefore safe for arbitrarily long generations as long as
    // tokens keep arriving.
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
        // R28 — headers are built per-request via `buildRequestHeaders`
        // so cloud-provider auth (`Authorization: Bearer ...`) and
        // OpenRouter's tagging headers travel with every streamChat
        // call. Local providers (`ollama`, `lmstudio`) get the previous
        // minimal `Content-Type` + `Accept` only.
        headers: requestHeadersForDump,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // R30 — fetch resolved with response headers in hand. This is
      // our connect+TLS+upload+server-headers boundary; everything
      // after here is body-stream territory.
      headersReceivedAt = performance.now();
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
      // Diagnostics dump — sanitized JSON of the failed request lands
      // in `~/.localcode/diagnostics/`. Only fires for OpenRouter so
      // we don't write a dump every time a local Ollama burps.
      if (this.dumpFailedRequests && this.backend === 'openrouter') {
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });
        // Fire-and-forget: do not let a disk write error tank the
        // outer error path. Errors during dump capture are swallowed.
        captureFailure({
          timestamp: new Date().toISOString(),
          backend: this.backend,
          model: this.model,
          status: response.status,
          responseBody: detail,
          responseHeaders,
          requestBody: body,
          requestHeaders: requestHeadersForDump,
          timing: buildTiming(),
        }).catch(() => {
          // ignore dump failures
        });
      }
      // Parse the optional Retry-After header (RFC 9110). Servers send
      // either a decimal seconds value or an HTTP-date — both forms
      // are honoured. Missing / malformed headers leave the value
      // undefined and the regular backoff schedule applies.
      const retryAfterMs = parseRetryAfterHeader(
        response.headers.get('retry-after'),
      );
      // R28 — OpenAI / OpenRouter / generic OpenAI-compat servers
      // return `{ error: { message, type, code } }` on 4xx. Surface
      // the message verbatim instead of the raw JSON, so the user
      // sees "Incorrect API key provided" rather than a 200-char
      // serialised JSON blob. Falls back to the raw detail when the
      // body isn't a recognised OpenAI error shape.
      const niceDetail = parseOpenAiErrorMessage(detail) ?? detail;

      // Agent O — friendly mapping for OpenRouter's "No allowed providers"
      // 404. The raw provider message ("No allowed providers are
      // available for the selected model") is technically accurate but
      // gives the user no path forward — they assume the model id is
      // wrong, when in fact the model is fine and OpenRouter's edge is
      // refusing to route. Replace it with actionable guidance instead.
      // Only fires for the OpenRouter backend; other backends keep the
      // verbatim error.
      const isNoAllowedProviders =
        this.backend === 'openrouter' &&
        response.status === 404 &&
        /no allowed providers/i.test(`${detail} ${niceDetail ?? ''}`);
      if (isNoAllowedProviders) {
        throw new HttpError(
          'OpenRouter rejected this model — no providers available right now. This usually means:\n' +
            '  • The :free tier is at capacity (try the same model without :free, or pick another).\n' +
            '  • Your OpenRouter account lacks access to this model (check openrouter.ai/keys → Account).\n' +
            '  • The model is deprecated or geo-restricted.\n' +
            '\n' +
            'Try /model to pick a different model, or /provider to switch backends.',
          response.status,
        );
      }

      // 429 from OpenRouter — almost always upstream `:free` per-IP /
      // per-model throttle, not the user's own request rate. The raw
      // body says "Rate limit exceeded" or just "Too Many Requests"
      // which makes the user think THEY did something wrong; in
      // reality they share a 5-20 RPM ceiling with the whole world
      // for `:free` variants. One chat turn that uses tools fires
      // N+1 requests (initial + tool roundtrips), so even a "single
      // message" trips it. Surface the real story.
      if (this.backend === 'openrouter' && response.status === 429) {
        // 429 is transient — the retry loop will honour the
        // server-provided Retry-After (or the default backoff schedule)
        // before re-trying. Once the retry budget is exhausted the
        // friendly help-text below is what the user sees.
        throw new HttpError(
          'OpenRouter rate-limited this request (429). On `:free` models this is shared across all users — typical ceilings are 5-20 requests/minute regardless of how few you sent. One chat turn here = several upstream calls (each tool the model uses is another request).\n' +
            '\n' +
            'Options:\n' +
            '  • Wait 30-60s and retry the same message.\n' +
            '  • Use the same model WITHOUT `:free` (paid variant has dedicated quota; usually <$0.01 per turn).\n' +
            '  • /model — pick a less-saturated model.\n' +
            '  • /provider — switch to Ollama (local, no limits) or another backend.\n' +
            '  • Top up OpenRouter balance to ≥$10 → 200 free req/day instead of 50.',
          response.status,
          true,
          retryAfterMs,
        );
      }

      // OpenRouter wraps upstream provider failures (timeouts, transient
      // 5xx, capacity blips, model-loading) as a top-level 400 with
      // bodies like "Provider returned error". Mark as transient so the
      // outer retry loop kicks in — retrying with the same payload
      // commonly hits a different upstream provider via OpenRouter's
      // fallback router and succeeds.
      const isTransientUpstream =
        this.backend === 'openrouter' &&
        response.status === 400 &&
        /provider returned error|provider.*timeout|upstream.*error/i.test(
          `${detail} ${niceDetail ?? ''}`,
        );
      if (isTransientUpstream) {
        throw new HttpError(
          'OpenRouter upstream provider failed transiently. ' +
            'Retries exhausted — try again, switch model via /model, or pick another backend via /provider. ' +
            `Raw: ${niceDetail ?? 'Provider returned error'}`,
          response.status,
          true,
          retryAfterMs,
        );
      }

      // Generic 5xx — retryable as transient. Honours Retry-After when
      // provided. (The legacy 4xx path below stays non-transient.)
      if (response.status >= 500) {
        throw new HttpError(
          `LLM server returned ${response.status} ${response.statusText}${
            niceDetail ? `: ${niceDetail}` : ''
          }`,
          response.status,
          true,
          retryAfterMs,
        );
      }

      const err = new HttpError(
        `LLM server returned ${response.status} ${response.statusText}${
          niceDetail ? `: ${niceDetail}` : ''
        }`,
        response.status
      );
      throw err;
    }

    if (!response.body) {
      clearConnectTimeout();
      this.clearController(controller);
      if (externalSignal) externalSignal.removeEventListener('abort', externalAbort);
      throw new Error('LLM server returned no response body');
    }

    // 2xx + body — handover to the stall watchdog. Disarm the wall-clock
    // connect timer immediately so it cannot fire mid-stream.
    clearConnectTimeout();

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const accumulator = new Map<number, AccumulatedToolCall>();
    let emittedToolCalls = false;
    // R13 — thinking is now a first-class channel. The splitter routes
    // bytes to either `visible` (forwarded via `onChunk`) or `thinking`
    // (forwarded via `onThinkingChunk`), instead of dropping the
    // thinking content silently as the legacy `ThinkingBlockFilter`
    // did.
    const thinking = new ThinkingBlockSplitter();
    const harmony = new HarmonyFilter();

    // Stricter stall detector (FIX B):
    //
    // The watchdog timer is checked on a short interval (1s) but its
    // trip condition is `Date.now() - state.lastContentChunkAt >
    // stallTimeoutMs`. Because `lastContentChunkAt` is only refreshed
    // when a VISIBLE-content delta arrives (or a tool-call delta),
    // heartbeats and `[DONE]` markers don't postpone the stall.
    //
    // A second, softer "thinking-only" timer fires once at 120s if
    // the stream is alive but `visibleContentChunks === 0` — the
    // model is presumably looping inside `<think>...</think>`.
    let watchdog: ReturnType<typeof setInterval> | null = null;
    const armWatchdog = (): void => {
      if (watchdog) clearInterval(watchdog);
      watchdog = setInterval(() => {
        const now = Date.now();
        const idle = now - state.lastContentChunkAt;
        if (idle > this.stallTimeoutMs) {
          state.stalled = true;
          controller.abort();
          return;
        }
        // Soft thinking-only warning at 120s (only when no visible
        // content has arrived AT ALL — the model is in `<think>`
        // limbo). Fired once per stream via `onChunk`.
        const sinceStart = now - state.startTime;
        if (
          !state.thinkingOnlyWarningEmitted &&
          state.visibleContentChunks === 0 &&
          state.sawThinkingContent &&
          sinceStart > THINKING_ONLY_WARNING_MS
        ) {
          state.thinkingOnlyWarningEmitted = true;
          try {
            params.onChunk?.(THINKING_ONLY_WARNING_TEXT);
          } catch {
            // Defensive — caller's onChunk must not break the watchdog.
          }
        }
      }, 1_000);
    };
    const disarmWatchdog = (): void => {
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
      }
    };
    armWatchdog();

    let sawDoneMarker = false;
    try {
      outer: for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = splitSSEFrames(buffer);
        buffer = rest;

        for (const frame of frames) {
          const chunk = parseSSEChunk(frame);
          if (!chunk) continue;
          state.chunksReceived += 1;

          if (chunk.kind === 'heartbeat') {
            // Heartbeats: the server is alive, but no content arrived.
            // We deliberately do NOT update `lastContentChunkAt` — see
            // FIX B comment above.
            continue;
          }
          if (chunk.kind === 'done') {
            // [DONE] is the canonical SSE end-of-stream marker. Don't
            // refresh `lastContentChunkAt` — the marker carries no
            // content. Break out so the post-loop drain runs once.
            sawDoneMarker = true;
            break outer;
          }
          // R30 — first SSE `data` chunk (any payload, even an empty
          // delta with `usage`) marks the upstream provider's TTFB.
          // We snapshot here rather than inside `consumeChunk` so the
          // measurement isn't biased by post-filter pipeline work
          // (HarmonyFilter / ThinkingBlockSplitter buffering can hold
          // the very first byte until the next push).
          if (firstVisibleByteAt === null) {
            firstVisibleByteAt = performance.now();
          }
          state.finishReason = this.consumeChunk(
            chunk.payload,
            params,
            accumulator,
            state.finishReason,
            harmony,
            thinking,
            state,
          );
          if (state.finishReason === 'tool_calls' && !emittedToolCalls) {
            emitToolCalls(accumulator, params.onToolCalls);
            emittedToolCalls = true;
          }
        }
      }

      // Drain any trailing partial frame. Skip when we already saw
      // [DONE] — by the SSE spec the server may close the socket
      // immediately after the marker, leaving an artefact byte behind.
      if (!sawDoneMarker && buffer.length > 0) {
        const chunk = parseSSEChunk(buffer);
        if (chunk && chunk.kind === 'data') {
          state.chunksReceived += 1;
          state.finishReason = this.consumeChunk(
            chunk.payload,
            params,
            accumulator,
            state.finishReason,
            harmony,
            thinking,
            state,
          );
        }
      }
      // Flush any tool-call batch that's been fully accumulated. We
      // emit when the accumulator is non-empty regardless of
      // finish_reason so a server that omits the `tool_calls` marker
      // still produces the expected callback. (Empty accumulator →
      // nothing to emit.)
      if (accumulator.size > 0 && !emittedToolCalls) {
        emitToolCalls(accumulator, params.onToolCalls);
        emittedToolCalls = true;
      }
      flushPipeline(thinking, harmony, params, state);

      // FIX E — XML tool-call fallback. Some Qwen/Hermes builds emit
      // `<tool_call>{"name": "...", "args": {...}}</tool_call>` in
      // content rather than via `delta.tool_calls`. Only attempt this
      // when the standard accumulator stayed empty AND we never saw
      // a tool_call delta — otherwise we'd risk double-firing.
      if (
        !emittedToolCalls &&
        !state.sawToolCall &&
        accumulator.size === 0 &&
        state.visibleContentBuffer.length > 0
      ) {
        const xmlCalls = extractXmlToolCalls(state.visibleContentBuffer);
        if (xmlCalls.length > 0 && params.onToolCalls) {
          try {
            params.onToolCalls(xmlCalls);
            emittedToolCalls = true;
            state.sawToolCall = true;
          } catch {
            // If the caller's onToolCalls throws, leave the XML
            // visible in the reply — never tank the stream.
          }
        }
      }

      // Premature-close detection: the connection ended (with or
      // without [DONE]) but we got no usable signal at all. This
      // usually means the server returned an empty SSE stream or
      // closed the socket immediately after `200 OK`. Flag it so
      // `buildSuccessDoneResult` can surface a clear error rather
      // than a silent zero-byte completion. Also fires when the
      // server emitted only a bare [DONE] with no preceding content.
      const noContent = state.streamedTextLength === 0;
      const noFinish =
        state.finishReason === null ||
        state.finishReason === undefined ||
        state.finishReason === '';
      const noToolCalls = !state.sawToolCall && !emittedToolCalls;
      if (noContent && noFinish && noToolCalls) {
        state.emptyStream = true;
      }
    } catch (streamErr) {
      // Mid-stream failure (200 OK was received but the SSE body was
      // torn down — connection-reset, upstream provider crash, our
      // stall watchdog tripping, etc). The original `if (!response.ok)`
      // branch above never fired because the HTTP status WAS 200.
      // Capture a dump so the user can see what we sent to OpenRouter
      // when the stream collapsed.
      if (this.dumpFailedRequests && this.backend === 'openrouter') {
        captureFailure({
          timestamp: new Date().toISOString(),
          backend: this.backend,
          model: this.model,
          status: 200,
          responseBody: `[mid-stream] ${errorMessage(streamErr)}`,
          responseHeaders: {},
          requestBody: body,
          requestHeaders: requestHeadersForDump,
          timing: buildTiming(),
        }).catch(() => {
          // ignore dump failures
        });
      }
      throw streamErr;
    } finally {
      disarmWatchdog();
      // R26 — flush any chars still held in the chunk-batch buffer
      // BEFORE we release the reader and trigger `onDone` upstream.
      // Otherwise the very last sentence of a stream could be dropped
      // when the model emits one final delta and the watchdog window
      // hasn't elapsed yet.
      //
      // M2 — `dispose()` after `flush()` clears the pending
      // setTimeout closure too. Without dispose, a torn-down stream
      // could keep the timer (and its captured `onChunk`) alive past
      // `onDone`, leaking memory and risking a late `onChunk` call
      // against a UI that has already torn down its handler.
      if (batcher) {
        batcher.flush();
        batcher.dispose();
      }
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
      // R15: connect timer is disarmed pre-stream once the response body
      // opens, but defensively clear here too in case we exited via the
      // catch path between connect and body-open.
      clearConnectTimeout();
      this.clearController(controller);
      if (externalSignal) externalSignal.removeEventListener('abort', externalAbort);
    }
  }

  private consumeChunk(
    payload: ChatCompletionChunk,
    params: StreamChatParams,
    accumulator: Map<number, AccumulatedToolCall>,
    finishReason: string | null,
    harmony: HarmonyFilter,
    thinking: ThinkingBlockSplitter,
    state: StreamState
  ): string | null {
    // OpenAI-compatible final chunk may carry a top-level `usage` object
    // when `stream_options: { include_usage: true }` is set. It often
    // arrives in a chunk with zero choices, so capture it before the
    // choice check.
    const usage = parseUsage(payload.usage);
    if (usage) state.usage = usage;

    const choice = payload.choices[0];
    if (!choice) return finishReason;

    const delta = choice.delta;

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      // R13 pipeline: HarmonyFilter FIRST (strips `<|channel|>...`
      // control leakage that some open-weights models scatter through
      // their reasoning), THEN ThinkingBlockSplitter routes the cleaned
      // bytes onto two channels — visible (`onChunk`) and thinking
      // (`onThinkingChunk`). Order matters because Harmony control
      // tokens can sit either inside or outside a thinking block;
      // running Harmony first keeps both channels free of `<|...|>`
      // gunk without us having to pipeline twice.
      const harmonyClean = harmony.push(delta.content);
      if (harmonyClean.length === 0) {
        // HarmonyFilter is still buffering a partial token — skip
        // splitter work for this delta. The bytes will surface on the
        // next push or in the final flush.
      } else {
        const split = thinking.push(harmonyClean);

        if (split.visible.length > 0) {
          // Visible bytes refresh both the strict stall clock and the
          // visible-content chunk counter. The watchdog reads
          // `lastContentChunkAt` to detect "thinking-only" hangs.
          state.streamedTextLength += split.visible.length;
          state.lastContentChunkAt = Date.now();
          state.visibleContentChunks += 1;
          params.onChunk?.(split.visible);
          // Buffer for XML tool-call fallback (FIX E). Cap at the
          // limit; we only need enough to detect a tool_call block.
          if (
            state.visibleContentBuffer.length < XML_TOOL_CALL_BUFFER_LIMIT
          ) {
            state.visibleContentBuffer = (
              state.visibleContentBuffer + split.visible
            ).slice(-XML_TOOL_CALL_BUFFER_LIMIT);
          }
        }

        if (split.thinking.length > 0) {
          // Thinking content is a first-class signal — surface it via
          // its own callback. We DO refresh `lastContentChunkAt` here
          // because thinking bytes are real model activity (the user
          // sees them in a dedicated UI pane) — letting them postpone
          // the stall timer is the right call. The "thinking-only"
          // soft warning still fires from the watchdog when
          // `visibleContentChunks === 0` past 120s, so we don't lose
          // the looping-inside-think-detection behaviour.
          state.lastContentChunkAt = Date.now();
          state.sawThinkingContent = true;
          params.onThinkingChunk?.(split.thinking);
        }
      }
    }

    if (delta.tool_calls && delta.tool_calls.length > 0) {
      state.sawToolCall = true;
      // Tool-call deltas count as "real content" for the stall watchdog.
      state.lastContentChunkAt = Date.now();
      for (const tc of delta.tool_calls) {
        mergeToolCallDelta(accumulator, tc);
      }
    }

    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      return choice.finish_reason;
    }
    return finishReason;
  }

  private buildRequestBody(params: StreamChatParams): Record<string, unknown> {
    // R26 — apply tool-result trimming BEFORE serialising to wire form.
    // The trim is a pure transform; full content stays in SQLite. We
    // skip the work entirely if `trimToolResultsAfter` is Infinity to
    // keep request bodies byte-identical to the legacy shape for
    // callers that have opted out (e.g. one-shot test fixtures).
    const trimmedMessages = Number.isFinite(this.trimToolResultsAfter)
      ? trimOldToolResults(params.messages, this.trimToolResultsAfter)
      : params.messages;
    const wireMessages: WireMessage[] = sanitiseToolCallPairing(
      trimmedMessages.map(toWireMessage),
    );
    const body: Record<string, unknown> = {
      model: params.model ?? this.model,
      messages: wireMessages,
      stream: true,
      // Ask the server to include final usage telemetry. LM Studio
      // generally ignores it; Ollama's OpenAI shim and true OpenAI honour it.
      stream_options: { include_usage: true },
    };
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools;
      body.tool_choice = 'auto';
      // R26 (ROADMAP #12) — JSON mode for weak local models. Only
      // applied when tools are present so plain-text replies aren't
      // forced into a JSON envelope. Servers that don't recognise the
      // field (e.g. older Ollama versions) silently ignore it; we don't
      // probe support upfront.
      if (this.useJsonMode) {
        body.response_format = { type: 'json_object' };
      }
    }

    const backend = this.resolveBackend();
    if (backend === 'ollama') {
      // Ollama's OpenAI-compatible shim accepts backend-specific knobs
      // under `options` (num_ctx, temperature, etc) and `keep_alive` at
      // the top level. Generation knobs (temperature, top_p,
      // repeat_penalty, num_predict) are merged here too — undefined
      // entries are stripped so the body stays minimal.
      const existing = isPlainObject(body.options)
        ? (body.options as Record<string, unknown>)
        : {};
      const gen = this.generation;
      const ollamaOptions: Record<string, unknown> = {
        ...existing,
        num_ctx: this.contextMaxTokens,
        repeat_penalty: gen?.repeatPenalty,
        num_predict: gen?.maxTokens,
        temperature: gen?.temperature,
        top_p: gen?.topP,
      };
      const cleaned = stripUndefined(ollamaOptions);
      if (Object.keys(cleaned).length > 0) {
        body.options = cleaned;
      } else {
        // Nothing to send under `options` — drop the key entirely so
        // the request body matches the legacy "no options" shape.
        delete body.options;
      }
      if (typeof this.keepAliveSeconds === 'number') {
        body.keep_alive = `${this.keepAliveSeconds}s`;
      }
    } else {
      // LM Studio (and most other OpenAI-compatible servers):
      // top-level `temperature`, `top_p`, `max_tokens`, and translate
      // Ollama's `repeat_penalty` (centred on 1.0) into OpenAI's
      // `frequency_penalty` (centred on 0.0). num_ctx is fixed at
      // model-load time on LM Studio, and `keep_alive` is n/a.
      const gen = this.generation;
      if (gen) {
        // R28 — OpenAI's `o1-*` reasoning models DO NOT accept the
        // `temperature` knob (the API returns 400 Bad Request when one
        // is supplied). They also ignore `top_p` and use
        // `max_completion_tokens` rather than `max_tokens`. Strip the
        // unsupported fields when the resolved model name starts with
        // `o1-` (covers `o1-preview`, `o1-mini`, future `o1-*`
        // variants) so the request body validates cleanly.
        const isO1 = isO1Model(params.model ?? this.model);
        const top: Record<string, unknown> = {
          temperature: isO1 ? undefined : gen.temperature,
          top_p: isO1 ? undefined : gen.topP,
          max_tokens: isO1 ? undefined : gen.maxTokens,
          // o1 uses `max_completion_tokens` instead of `max_tokens`.
          max_completion_tokens: isO1 ? gen.maxTokens : undefined,
          frequency_penalty:
            !isO1 &&
            typeof gen.repeatPenalty === 'number' &&
            Number.isFinite(gen.repeatPenalty)
              ? gen.repeatPenalty - 1
              : undefined,
        };
        for (const [k, v] of Object.entries(stripUndefined(top))) {
          body[k] = v;
        }
      }
    }

    if (params.options) {
      for (const [k, v] of Object.entries(params.options)) {
        if (k === 'options' && isPlainObject(body.options) && isPlainObject(v)) {
          // Merge additional Ollama options without clobbering existing keys.
          body.options = {
            ...(v as Record<string, unknown>),
            ...(body.options as Record<string, unknown>),
          };
          continue;
        }
        if (!(k in body)) body[k] = v;
      }
    }

    // Agent O — OpenRouter routing reliability hints.
    //
    // Reports kept surfacing `404 No allowed providers are available for
    // the selected model` (especially on `:free` model ids), often with
    // 0 requests visible on the OpenRouter dashboard — i.e. OpenRouter's
    // edge rejected the request before it ever hit the underlying
    // provider. Two OpenRouter-spec'd knobs improve our chances:
    //
    //   - `provider.allow_fallbacks: true` — if the primary provider is
    //     at capacity / unauthorised, OpenRouter will try the next one
    //     in its routing list rather than 404.
    //   - `provider.sort: "throughput"` — prefer higher-throughput
    //     providers, which tend to be paid tiers with looser caps.
    //   - `transforms: ["middle-out"]` — auto-trim very long contexts so
    //     conversations don't 400 with a context-window overflow on
    //     models with smaller windows than the prompt.
    //
    // Spec: https://openrouter.ai/docs/provider-routing
    //
    // We avoid clobbering caller-supplied values (e.g. somebody who has
    // pre-pinned `provider.order: ["openai"]` should keep that pin and
    // we just fill in the missing fallback / sort fields).
    if (this.backend === 'openrouter') {
      const callerProvider = isPlainObject(body.provider)
        ? (body.provider as Record<string, unknown>)
        : {};
      const provider: Record<string, unknown> = {
        allow_fallbacks: true,
        sort: 'throughput',
        ...callerProvider,
      };
      body.provider = provider;
      if (!('transforms' in body)) {
        body.transforms = ['middle-out'];
      }
      // Token-economy hints (token-economy round):
      //   - `route: 'fallback'` — top-level routing preference. Tells
      //     OpenRouter to prefer providers that can serve immediately
      //     and route around saturated ones rather than failing fast.
      //     Synergistic with `provider.allow_fallbacks` above.
      //   - `usage: { include: true }` — opt into usage telemetry on
      //     the response so we can record `tokensIn`/`tokensOut` per
      //     turn (drives session totals + auto-compress decisions).
      //
      // PREFIX CACHING: providers fronted by OpenRouter — Anthropic,
      // OpenAI, DeepInfra in particular — implement automatic prefix
      // caching when subsequent requests share a byte-stable prefix
      // (system prompt + early history). `ContextManager.buildSystemPrompt`
      // is already byte-stable (skills sorted, no per-turn data
      // appended); these flags help OpenRouter route us to providers
      // that honour the cache.
      if (!('route' in body)) {
        body.route = 'fallback';
      }
      if (!('usage' in body)) {
        body.usage = { include: true };
      }

      // PROMPT-CACHE PASS-THROUGH for Anthropic-routed models.
      //
      // OpenAI auto-caches stable prefixes ≥1024 tokens without any
      // markers, but Anthropic does NOT auto-cache — the caller MUST
      // attach `cache_control: { type: 'ephemeral' }` markers to a
      // content block, otherwise every turn pays full price.
      //
      // OpenRouter mirrors the OpenAI Chat Completions surface but
      // accepts Anthropic-style `cache_control` markers nested into
      // message content blocks (array-of-parts form) and forwards them
      // to Anthropic verbatim. We:
      //
      //   1. Convert `messages[0]` (system role) into the array-of-parts
      //      content form with a `cache_control` marker on its single
      //      text part.
      //   2. Tag the LAST tool with `cache_control` so the entire
      //      tools array rides the cache.
      //
      // Other providers (`openai/*`, `deepseek/*`, etc.) get the
      // standard OpenAI shape — they auto-cache without markers, and
      // unknown fields would either be ignored or cause a 400 on the
      // upstream API. We gate strictly on `anthropic/` prefix.
      const targetModel = (params.model ?? this.model) || '';
      const isAnthropicRoute = targetModel.startsWith('anthropic/');
      const cacheDisabled =
        typeof process !== 'undefined' &&
        process.env?.LOCALCODE_DISABLE_PROMPT_CACHE === '1';
      if (isAnthropicRoute && !cacheDisabled) {
        const wireMsgs = body.messages;
        if (Array.isArray(wireMsgs) && wireMsgs.length > 0) {
          const first = wireMsgs[0];
          if (
            isPlainObject(first) &&
            (first as Record<string, unknown>).role === 'system'
          ) {
            const sysMsg = first as Record<string, unknown>;
            const sysContent = sysMsg.content;
            if (typeof sysContent === 'string' && sysContent.length > 0) {
              sysMsg.content = [
                {
                  type: 'text',
                  text: sysContent,
                  cache_control: { type: 'ephemeral' },
                },
              ];
            }
          }
        }
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          const toolsArr = body.tools as unknown[];
          const lastIdx = toolsArr.length - 1;
          const last = toolsArr[lastIdx];
          if (isPlainObject(last)) {
            toolsArr[lastIdx] = {
              ...(last as Record<string, unknown>),
              cache_control: { type: 'ephemeral' },
            };
          }
        }
      }
    }

    // R26 (Agent A, ROADMAP #13) — adaptive temperature.
    //
    // Applied LAST so it wins over the static `generation.temperature`
    // and any caller-supplied `params.options.temperature`. Only kicks
    // in when explicitly opted into (`adaptiveTemperature: true`) so
    // existing R5 tests stay green.
    //
    // Where the value lands depends on the backend wire shape:
    //   - Ollama: `body.options.temperature`.
    //   - LM Studio: top-level `body.temperature`.
    //
    // We pull the base temperature from the SAME slot we'd be about to
    // overwrite — falling back to the configured `generation.temperature`
    // and then a conservative 0.2 if neither is set. This way the
    // "brainstorm → preserve baseTemp" branch behaves correctly even
    // for adapters created without a generation block.
    if (this.adaptiveTemperature) {
      const inferred = this.computeAdaptiveTemperature(params.messages, body, backend);
      if (typeof inferred === 'number') {
        if (backend === 'ollama') {
          const opts = isPlainObject(body.options)
            ? (body.options as Record<string, unknown>)
            : {};
          opts.temperature = inferred;
          body.options = opts;
        } else {
          body.temperature = inferred;
        }
      }
    }

    // INFERENCE-CONTROL-SECTION
    // Wave 16B — attach local-first constrained-decoding knobs to the
    // PER-REQUEST body. These live here (NOT in the system prompt) so the
    // byte-stable prefix cache is never disturbed. Additive + gated:
    // omitted entirely for cloud backends and when unsupported/disabled.
    this.applyInferenceControl(body, params);
    // INFERENCE-CONTROL-SECTION-END
    return body;
  }

  // INFERENCE-CONTROL-SECTION
  /**
   * Mutate `body` in place to add `grammar` / `logit_bias` / `cache_prompt`
   * for LOCAL backends when the capability report + config allow.
   *
   * v1 targets ONE backend family: llama.cpp-class local servers
   * (ollama / lmstudio / custom). Cloud backends (openai / openrouter /
   * google / anthropic) are excluded unconditionally — they don't expose
   * these knobs and a stray field would 400 a billed request.
   *
   * Caller-supplied `params.options` already merged above takes
   * precedence: if the caller explicitly set `grammar` / `logit_bias` we
   * never clobber it.
   */
  private applyInferenceControl(
    body: Record<string, unknown>,
    params: StreamChatParams,
  ): void {
    const inf = this.inference;
    if (!inf) return;
    // Hard gate: local backends only. `resolveBackend()` already collapses
    // cloud onto 'lmstudio' for the wire SHAPE, so we must check the
    // ORIGINAL backend here, not the resolved one.
    if (!isLocalInferenceBackend(this.backend)) return;

    const report = inf.report;

    // Grammar — only when tools are present (a grammar-locked plain-text
    // reply makes no sense). Gated on report.grammar + mode != 'off'.
    const grammarOn = inf.grammarLock !== 'off';
    const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
    if (
      grammarOn &&
      report.grammar &&
      hasTools &&
      typeof inf.toolGrammar === 'string' &&
      inf.toolGrammar.length > 0 &&
      !('grammar' in body)
    ) {
      body.grammar = inf.toolGrammar;
    }

    // Logit bias — gated on report.logitBias + mode != 'off' + non-empty.
    const banlistOn = inf.logitBanlist !== 'off';
    if (
      banlistOn &&
      report.logitBias &&
      inf.logitBias &&
      Object.keys(inf.logitBias).length > 0 &&
      !('logit_bias' in body)
    ) {
      body.logit_bias = inf.logitBias;
    }

    // cache_prompt — a small, free win on llama.cpp-class servers that
    // pins the KV prefix between turns. Only when the server honoured it
    // during probing. Never on cloud (already excluded above).
    if (report.cachePrompt && !('cache_prompt' in body)) {
      body.cache_prompt = true;
    }
  }
  // INFERENCE-CONTROL-SECTION-END

  /**
   * Resolve the base temperature, run {@link inferTemperatureForTask},
   * and return the value to write back. Returns `null` when there is
   * literally nothing to base the inference on (no messages, no
   * configured base, no current value) — in that case we leave the
   * body unchanged.
   */
  private computeAdaptiveTemperature(
    messages: ReadonlyArray<Message>,
    body: Record<string, unknown>,
    backend: 'ollama' | 'lmstudio',
  ): number | null {
    if (messages.length === 0) return null;
    const currentTopLevel = typeof body.temperature === 'number'
      ? (body.temperature as number)
      : undefined;
    const currentOllama =
      backend === 'ollama' && isPlainObject(body.options)
        ? ((body.options as Record<string, unknown>).temperature)
        : undefined;
    const currentBase =
      typeof currentTopLevel === 'number'
        ? currentTopLevel
        : typeof currentOllama === 'number'
          ? (currentOllama as number)
          : typeof this.generation?.temperature === 'number'
            ? this.generation.temperature
            : 0.2;
    return inferTemperatureForTask(messages, currentBase);
  }

  private joinUrl(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    const p = path.startsWith('/') ? path : `/${path}`;
    // If baseUrl already ends with /v1 and path starts with /v1/, strip one.
    if (this.baseUrl.endsWith('/v1') && p.startsWith('/v1/')) {
      return this.baseUrl + p.slice(3);
    }
    return this.baseUrl + p;
  }

  /**
   * C2 — remove this stream's controller from the active set. Always
   * called from `runStreamOnce`'s finally / catch paths so the set
   * stays bounded even if the stream errors out. `delete` on a Set
   * is a no-op when the entry isn't present, so double-calls are safe.
   */
  private clearController(controller: AbortController): void {
    this.activeControllers.delete(controller);
  }
}

// ---------- Error types ----------

export class HttpError extends Error {
  public readonly status: number;
  /**
   * Marks errors that are transport-classified as 4xx but semantically
   * transient (e.g. OpenRouter wraps upstream provider failures as 400
   * "Provider returned error" — those are retryable even though the
   * status code says client-side).
   */
  public readonly transient: boolean;
  /**
   * Optional explicit retry hint from the server, normalised to
   * milliseconds. Populated when the upstream returns a `Retry-After`
   * header (in seconds OR HTTP-date form). The retry loop honours
   * this via `max(retryAfter, scheduledBackoff)` so we never retry
   * sooner than the server asked for.
   */
  public readonly retryAfterMs: number | undefined;
  constructor(
    message: string,
    status: number,
    transient = false,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.transient = transient;
    this.retryAfterMs = retryAfterMs;
  }
}

// ---------- Stream state ----------

interface StreamState {
  startTime: number;
  usage: StreamUsage | null;
  streamedTextLength: number;
  stalled: boolean;
  /**
   * Last `finish_reason` reported by the server. `null` means the
   * stream ended without ever surfacing one (which is itself a signal
   * — see {@link emptyStream}).
   */
  finishReason: string | null;
  /**
   * Number of SSE chunks (data + heartbeats + [DONE] frames combined)
   * read from the server during this stream attempt. Used to detect
   * "empty stream / connection closed prematurely" — if zero chunks
   * arrived AND the connection ended without an error, that's a
   * server-side premature close.
   */
  chunksReceived: number;
  /**
   * True when the stream produced no text deltas, no tool calls, and
   * no terminal `finish_reason`. Used to surface a clear error rather
   * than a silent zero-byte completion. Set by `consumeChunk` /
   * `runStreamOnce` after the loop exits.
   */
  emptyStream: boolean;
  /**
   * True once a tool-call delta has been observed. Tracked so we can
   * still emit a complete tool-call batch when the server omits the
   * `finish_reason: 'tool_calls'` marker (some Ollama builds skip it).
   */
  sawToolCall: boolean;
  /**
   * Timestamp (ms since epoch) of the most recent SSE chunk that
   * actually carried VISIBLE content — `delta.content` (non-empty,
   * non-thinking-only) or `delta.tool_calls`. Heartbeats, `[DONE]`
   * markers, empty-delta finish chunks, and thinking-only deltas do
   * NOT update this clock. The strict stall detector fires when the
   * gap between `Date.now()` and `lastContentChunkAt` exceeds
   * `stallTimeoutMs`.
   *
   * Initialised to `startTime` so the very first content gap is
   * measured from the moment the request was sent (not from "first
   * heartbeat", which would mask a server that opens the connection
   * and never produces anything).
   */
  lastContentChunkAt: number;
  /**
   * Number of SSE chunks that emitted at least one VISIBLE byte
   * after passing through both filters (HarmonyFilter +
   * ThinkingBlockSplitter). Used to detect "thinking-only" hangs:
   * if the stream is alive (heartbeats and/or thinking content
   * arriving) but `visibleContentChunks === 0` after a soft window,
   * the user gets a one-shot informational notice that the model is
   * stuck in `<think>` mode.
   */
  visibleContentChunks: number;
  /**
   * True once the soft "thinking-only" notice has been emitted via
   * `onChunk`. Prevents the warning from repeating if the model
   * stays in thinking mode well past the threshold.
   */
  thinkingOnlyWarningEmitted: boolean;
  /**
   * True iff at least one piece of `<think>...</think>` content has
   * arrived during the stream. Distinguishes "model is genuinely
   * thinking but never produced a visible reply" (`thinking-only`)
   * from "model produced literally nothing" (`empty stream`) when the
   * stream finishes.
   */
  sawThinkingContent: boolean;
  /**
   * Concatenated visible-content buffer (post-thinking, post-harmony).
   * Used by FIX E (XML tool-call fallback): if the standard
   * `delta.tool_calls` accumulator stays empty BUT the model emitted
   * a `<tool_call>{...}</tool_call>` block as content, we parse it
   * here and synthesise the `onToolCalls` callback.
   *
   * Capped at {@link XML_TOOL_CALL_BUFFER_LIMIT} characters so a
   * legitimately huge text reply doesn't blow memory; XML tool calls
   * are always small (a few hundred chars at most).
   */
  visibleContentBuffer: string;
}

/**
 * C1 — produce a freshly-zeroed {@link StreamState} anchored at
 * `startedAt`. Used both at the top of `streamChat` and (via
 * `resetStreamState`) before each retry iteration so a partial first
 * attempt cannot leak counters / buffers into the next attempt.
 */
function freshStreamState(startedAt: number): StreamState {
  return {
    startTime: startedAt,
    usage: null,
    streamedTextLength: 0,
    stalled: false,
    finishReason: null,
    chunksReceived: 0,
    emptyStream: false,
    sawToolCall: false,
    // Initialise to the request-start time so the first stall window
    // is measured from "we asked the server" — this catches "open
    // 200 OK then never send anything" without waiting for a first
    // heartbeat to arm the watchdog.
    lastContentChunkAt: startedAt,
    visibleContentChunks: 0,
    thinkingOnlyWarningEmitted: false,
    sawThinkingContent: false,
    visibleContentBuffer: '',
  };
}

/**
 * C1 — wipe every per-attempt field in `state` so the retry begins
 * with a clean ledger. We deliberately mutate in place (rather than
 * returning a new object) so callers that captured the `state`
 * reference for telemetry / stall watchdog access keep seeing the
 * live counters update through the same handle.
 *
 * `startTime` is preserved because it represents the cumulative
 * wall-clock anchor for the whole `streamChat` call; everything else
 * resets to its constructor value.
 */
function resetStreamState(state: StreamState, startedAt: number): void {
  state.usage = null;
  state.streamedTextLength = 0;
  state.stalled = false;
  state.finishReason = null;
  state.chunksReceived = 0;
  state.emptyStream = false;
  state.sawToolCall = false;
  state.lastContentChunkAt = startedAt;
  state.visibleContentChunks = 0;
  state.thinkingOnlyWarningEmitted = false;
  state.sawThinkingContent = false;
  state.visibleContentBuffer = '';
}

/**
 * R26 (Agent A, ROADMAP #6) — coalescing buffer for streamed text
 * deltas. The first `push` flushes immediately so the user sees a
 * response start with no perceived delay; subsequent pushes are
 * buffered until the elapsed-ms / byte-cap / line-break trigger fires.
 *
 * Lifecycle:
 *   - Construct with the underlying `onChunk` callback and a window.
 *   - Call `push(text)` for every delta — auto-flushes when triggers fire.
 *   - Call `flush()` once at stream end to drain the tail.
 *
 * Thread-safety: not designed for it; expects to be invoked from a
 * single async loop (the SSE reader). The internal timer is a `setTimeout`
 * scheduled on every push; it's always cleared before a fresh schedule
 * so we never have more than one timer per batcher.
 */
class ChunkBatcher {
  private readonly onChunk: (text: string) => void;
  private readonly windowMs: number;
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPushSeen = false;

  constructor(onChunk: (text: string) => void, windowMs: number) {
    this.onChunk = onChunk;
    this.windowMs = Math.max(1, windowMs);
  }

  push(text: string): void {
    if (text.length === 0) return;
    this.buffer += text;
    // First push always flushes immediately — keeps the perceived
    // latency of the very first byte tight (matches R24's leading-edge
    // behaviour at the UI throttle layer).
    if (!this.firstPushSeen) {
      this.firstPushSeen = true;
      this.flush();
      return;
    }
    // Line-break flush: code blocks render row-by-row when the model
    // emits newlines, even if the time/byte triggers haven't fired.
    if (text.indexOf('\n') !== -1) {
      this.flush();
      return;
    }
    // Byte-cap flush: avoid unbounded memory growth for ultra-fast
    // models that produce many tokens before the next event-loop tick.
    if (this.buffer.length >= CHUNK_BATCH_FLUSH_CHARS) {
      this.flush();
      return;
    }
    // Schedule a deferred flush.
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.windowMs);
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const out = this.buffer;
    this.buffer = '';
    try {
      this.onChunk(out);
    } catch {
      // Defensive — caller's onChunk should not break the batcher.
    }
  }

  /**
   * M2 — release every retained resource without invoking `onChunk`.
   *
   * Called from `runStreamOnce`'s finally block. Without this, if the
   * stream exits via an unrecoverable throw between `push()` and the
   * pending `setTimeout` firing, the timer's closure keeps the
   * `onChunk` reference and any retained context (DOM nodes via UI
   * callbacks, large strings, etc.) alive until the timer fires —
   * which it will, but it will then try to call `onChunk` on a
   * scenario the caller no longer expects (post-`onDone`).
   *
   * After `dispose()`:
   *   - any pending timer is cleared,
   *   - the buffer is dropped (no late `onChunk` for stale text),
   *   - further `push()` / `flush()` calls become no-ops because both
   *     paths early-return on empty buffer / cleared timer.
   */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = '';
  }
}

/**
 * Cap on the visible-content buffer kept for XML tool-call detection
 * (FIX E). Tool-call XML blocks are always small; legitimate replies
 * can be many KB, so we only retain the last 16 KB and scan that.
 */
const XML_TOOL_CALL_BUFFER_LIMIT = 16_384;

/**
 * R26 (Agent A, ROADMAP #6) — default chunk-batching window in ms.
 * Buffered text deltas are flushed to `onChunk` every 30ms (or at
 * earlier triggers — line breaks, byte cap, stream end).
 */
const DEFAULT_CHUNK_BATCH_MS = 30;

/**
 * R26 (Agent A, ROADMAP #6) — flush the chunk-batch buffer when it
 * crosses this many characters. 64 chars is roughly two short
 * sentences at typical token lengths — small enough that the user
 * still feels the stream live and large enough to amortise the
 * onChunk + UI-throttle overhead.
 */
const CHUNK_BATCH_FLUSH_CHARS = 64;

/**
 * R26 (Agent A, ROADMAP #13) — keyword sets used by
 * {@link inferTemperatureForTask}. Detection is case-insensitive,
 * matched as whole-word boundaries (so "explain" doesn't match
 * "implementation"), and supports both English and Russian
 * imperative forms because the user freely switches between them.
 *
 * The lists are deliberately small and high-signal: false positives
 * are worse than false negatives here (a wrong temperature lock can
 * make a brainstorm feel robotic). When a verb does not match either
 * set, the base temperature is preserved.
 */
const CODING_KEYWORDS: ReadonlyArray<string> = [
  // English imperatives
  'write',
  'implement',
  'fix',
  'refactor',
  'code',
  'patch',
  'add',
  'rewrite',
  'replace',
  'rename',
  'extract',
  // Russian imperatives
  'реализуй',
  'напиши',
  'исправь',
  'почини',
  'замени',
  'добавь',
  'отрефактори',
  'переименуй',
  // Domain nouns commonly used as imperatives
  'функция',
  'класс',
  'метод',
];

const BRAINSTORM_KEYWORDS: ReadonlyArray<string> = [
  'explain',
  'why',
  'pros and cons',
  'tradeoff',
  'trade-off',
  'compare',
  'brainstorm',
  // Russian
  'объясни',
  'почему',
  'расскажи',
  'обсуди',
  'сравни',
  'плюсы и минусы',
];

/**
 * Compile keyword lists into a single regex per category. We rebuild
 * the regex once at module load — the keyword arrays are immutable so
 * this is safe. Anchored on word boundaries (`\b`) for ASCII; for
 * Cyrillic the boundary uses `(?:^|[^\p{L}])` plus a trailing
 * lookahead so partial-stem matches don't false-positive on Russian
 * inflected forms (e.g. "напишите" still matches "напиши").
 */
const CODING_RE = buildKeywordRegex(CODING_KEYWORDS);
const BRAINSTORM_RE = buildKeywordRegex(BRAINSTORM_KEYWORDS);

function buildKeywordRegex(keywords: ReadonlyArray<string>): RegExp {
  const escaped = keywords.map((k) =>
    k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  // Use Unicode-aware boundary: lookbehind for non-letter (or BOS),
  // lookahead similarly. This matches both ASCII and Cyrillic letters.
  // For Russian stems, accept any further letters after the keyword
  // (so "напишите" matches "напиши") via a non-capturing trailing
  // letter run. We OR all keywords into a single alternation.
  return new RegExp(
    `(?:^|[^\\p{L}])(?:${escaped.join('|')})\\p{L}*`,
    'iu',
  );
}

/**
 * R26 (Agent A, ROADMAP #13) — adaptive temperature inference.
 *
 * Inspects the most recent user message and the assistant tail to
 * derive an appropriate temperature for the next turn.
 *
 * Rules (first match wins):
 *   1. Tool-call in flight (last assistant message has `toolCalls` and
 *      no `tool` reply has landed yet for at least one of them) → 0.0.
 *      Reasoning: tool-call args are mechanical reformulations of the
 *      user's intent; randomness only hurts.
 *   2. Last user message contains a coding-style verb → 0.1. Code
 *      generation benefits from low randomness — the model should
 *      pick the most common, idiomatic phrasing.
 *   3. Last user message contains a brainstorm/explanation verb →
 *      preserve `baseTemp`. Discussion benefits from variety.
 *   4. No clear signal → preserve `baseTemp`.
 *
 * Pure function — no side effects, takes a snapshot of `messages`
 * and a numeric base temperature. Returns the adapted value, never
 * mutating the inputs.
 */
export function inferTemperatureForTask(
  messages: ReadonlyArray<Message>,
  baseTemp: number,
): number {
  if (!Number.isFinite(baseTemp) || baseTemp < 0) {
    // Defensive — caller should already have validated; but if not,
    // fall back to a conservative 0.2 so we don't propagate NaN.
    return 0.2;
  }

  // Rule 1 — tool-call in flight. Walk back from the end and look for
  // the most recent assistant message with toolCalls. If every one of
  // its tool calls has a matching `tool` reply AFTER it, the model
  // has already received the responses and we're back to "user might
  // have just typed something". Otherwise we're awaiting a tool reply
  // (or the model issued the calls and the user hasn't typed since)
  // → temperature 0.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user') break; // user already replied — rule 1 doesn't apply
    if (m.role !== 'assistant') continue;
    if (!m.toolCalls || m.toolCalls.length === 0) continue;
    // Found an assistant message that issued tool calls. Check if
    // every call has a `tool` reply *after* this index.
    const expectedIds = new Set(m.toolCalls.map((c) => c.id));
    for (let j = i + 1; j < messages.length; j += 1) {
      const reply = messages[j];
      if (!reply) continue;
      if (reply.role === 'tool' && reply.toolCallId) {
        expectedIds.delete(reply.toolCallId);
      }
    }
    if (expectedIds.size > 0) return 0.0;
    break;
  }

  // Rule 2/3 — inspect last user message.
  const lastUser = findLastUserText(messages);
  if (!lastUser) return baseTemp;

  if (CODING_RE.test(lastUser)) return 0.1;
  if (BRAINSTORM_RE.test(lastUser)) return baseTemp;

  return baseTemp;
}

/**
 * Walk the messages from the end and return the text of the most
 * recent `user` message, normalised to lowercase. Multimodal user
 * messages (where `content` was smuggled as a `MessageContentPart[]`)
 * surface only the text parts; image-only messages return `null`.
 */
function findLastUserText(messages: ReadonlyArray<Message>): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const raw: unknown = m.content;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(raw)) {
      // Multimodal — concatenate all text parts.
      const parts: string[] = [];
      for (const p of raw) {
        if (p !== null && typeof p === 'object') {
          const obj = p as { type?: unknown; text?: unknown };
          if (obj.type === 'text' && typeof obj.text === 'string') {
            parts.push(obj.text);
          }
        }
      }
      const joined = parts.join(' ').trim();
      return joined.length > 0 ? joined : null;
    }
    return null;
  }
  return null;
}

/**
 * Soft warning fired once when a stream has been alive for this many
 * milliseconds without producing any visible content (the model is
 * stuck inside `<think>...</think>`). Informational only — does NOT
 * abort the stream; the user can Ctrl-C or wait.
 */
const THINKING_ONLY_WARNING_MS = 120_000;
const THINKING_ONLY_WARNING_TEXT =
  '[Note: model has been in thinking mode for 2 minutes — it may be looping. Press Ctrl+C to cancel and retry.]\n';

/**
 * Drain both filters at stream-end. R13 pipeline: HarmonyFilter is
 * pushed first, its tail flushed, and the released bytes are fed
 * through the {@link ThinkingBlockSplitter}. Visible bytes go via
 * `onChunk`; thinking bytes go via `onThinkingChunk`. Any thinking
 * content that was held in mid-block at end-of-stream is released as
 * thinking (rather than silently dropped) so the user sees what the
 * model was reasoning about even if it never finished.
 */
function flushPipeline(
  thinking: ThinkingBlockSplitter,
  harmony: HarmonyFilter,
  params: StreamChatParams,
  state: StreamState,
): void {
  const harmonyTail = harmony.flush();
  if (harmonyTail.length > 0) {
    const split = thinking.push(harmonyTail);
    emitSplit(split, params, state);
  }
  const finalSplit = thinking.flush();
  emitSplit(finalSplit, params, state);
}

/**
 * Helper that forwards the splitter's per-channel output to the right
 * callbacks and updates the relevant {@link StreamState} counters. Used
 * by both {@link flushPipeline} and the in-loop chunk handler so the
 * book-keeping stays in one place.
 */
function emitSplit(
  split: { visible: string; thinking: string },
  params: StreamChatParams,
  state: StreamState,
): void {
  if (split.visible.length > 0) {
    state.streamedTextLength += split.visible.length;
    state.lastContentChunkAt = Date.now();
    state.visibleContentChunks += 1;
    params.onChunk?.(split.visible);
    if (state.visibleContentBuffer.length < XML_TOOL_CALL_BUFFER_LIMIT) {
      state.visibleContentBuffer = (
        state.visibleContentBuffer + split.visible
      ).slice(-XML_TOOL_CALL_BUFFER_LIMIT);
    }
  }
  if (split.thinking.length > 0) {
    state.lastContentChunkAt = Date.now();
    state.sawThinkingContent = true;
    params.onThinkingChunk?.(split.thinking);
  }
}

/**
 * Parse a provider-reported usage block into our normalised
 * {@link StreamUsage}. Cross-provider field shapes for prompt-cache
 * reporting (so future contributors know which fields we surface):
 *
 *   1. OpenAI / OpenRouter→OpenAI:
 *        usage.prompt_tokens_details.cached_tokens
 *   2. Anthropic / OpenRouter→Anthropic (handled in adapter-anthropic.ts):
 *        usage.cache_read_input_tokens     → cachedInputTokens
 *        usage.cache_creation_input_tokens → cacheCreationTokens
 *   3. DeepSeek (and GLM/Zhipu, same shape):
 *        usage.prompt_cache_hit_tokens     → cachedInputTokens
 *        usage.prompt_cache_miss_tokens    → freshInputTokens
 *   4. Groq / OpenRouter normalised fallback:
 *        usage.cached_tokens               → cachedInputTokens
 *
 * Detection priority for `cachedInputTokens` (first match wins):
 *   1. `prompt_tokens_details.cached_tokens` (OpenAI explicit)
 *   2. `prompt_cache_hit_tokens` (DeepSeek / GLM)
 *   3. `cached_tokens` (Groq / OpenRouter normalised fallback)
 *
 * `freshInputTokens` is sourced from `prompt_cache_miss_tokens` when the
 * provider supplied it directly (DeepSeek); otherwise we derive it as
 * `promptTokens - cachedInputTokens` (clamped to >= 0).
 *
 * `cacheCreationTokens` is Anthropic-only and only set in
 * adapter-anthropic.ts — other providers don't have that concept.
 *
 * Defensive: `pickFiniteInt` rejects negatives, NaN, and non-numeric
 * values, so garbage cache fields fall through silently.
 */
function parseUsage(raw: unknown): StreamUsage | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) return null;
  const u = raw;
  // OpenAI: prompt_tokens / completion_tokens / total_tokens
  // Ollama native: prompt_eval_count / eval_count
  const promptTokens = pickFiniteInt(u.prompt_tokens, u.prompt_eval_count);
  const completionTokens = pickFiniteInt(u.completion_tokens, u.eval_count);
  const totalTokensExplicit = pickFiniteInt(u.total_tokens);
  const totalTokens =
    typeof totalTokensExplicit === 'number'
      ? totalTokensExplicit
      : (promptTokens ?? 0) + (completionTokens ?? 0) || undefined;

  // Detection priority (first match wins):
  //   1. OpenAI explicit: prompt_tokens_details.cached_tokens
  //   2. DeepSeek / GLM:  prompt_cache_hit_tokens
  //   3. Groq / OpenRouter normalised fallback: cached_tokens
  // Note: Anthropic's `cache_read_input_tokens` is handled in
  // adapter-anthropic.ts, not here — Anthropic events carry their own
  // shape and never flow through this OpenAI-shaped parser.
  const detailsRaw = u.prompt_tokens_details;
  let cachedInputTokens: number | undefined;
  if (isPlainObject(detailsRaw)) {
    cachedInputTokens = pickFiniteInt(detailsRaw.cached_tokens);
  }
  if (cachedInputTokens === undefined) {
    cachedInputTokens = pickFiniteInt(u.prompt_cache_hit_tokens);
  }
  if (cachedInputTokens === undefined) {
    cachedInputTokens = pickFiniteInt(u.cached_tokens);
  }

  // DeepSeek surfaces a paired `prompt_cache_miss_tokens` field that we
  // can use directly for `freshInputTokens` instead of deriving by
  // subtraction. If absent, we'll derive below.
  const cacheMissTokens = pickFiniteInt(u.prompt_cache_miss_tokens);

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined
  ) {
    return null;
  }

  const usage: StreamUsage = {};
  if (promptTokens !== undefined) usage.promptTokens = promptTokens;
  if (completionTokens !== undefined) usage.completionTokens = completionTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if (cachedInputTokens !== undefined && cachedInputTokens > 0) {
    usage.cachedInputTokens = cachedInputTokens;
    if (cacheMissTokens !== undefined) {
      usage.freshInputTokens = cacheMissTokens;
    } else if (promptTokens !== undefined) {
      usage.freshInputTokens = Math.max(0, promptTokens - cachedInputTokens);
    }
  }
  return usage;
}

function pickFiniteInt(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
      return Math.floor(c);
    }
  }
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.prototype.toString.call(v) === '[object Object]'
  );
}

/**
 * Return a copy of `obj` with `undefined`-valued entries removed. Used
 * when assembling request bodies so the wire payload only carries
 * fields the user actually supplied — keeps unit-test snapshots tight
 * and avoids surprising downstream servers that reject unknown nulls.
 */
function stripUndefined(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---------- Helpers ----------

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function toWireMessage(m: {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ReadonlyArray<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}): WireMessage {
  // MULTIMODAL-ROUTING-SECTION — `Message.content` is typed as `string`
  // in the public domain type, but `buildImageMessage` and similar
  // helpers smuggle a `MessageContentPart[]` through the field. If we
  // see one, forward it unchanged to the wire body — OpenAI-compatible
  // vision endpoints (OpenAI, OpenRouter, LM Studio, Ollama's OpenAI
  // shim with a vision model loaded, Google Gemini's OpenAI compat
  // surface, Custom OpenAI-compat) all accept the `image_url` array
  // form natively. The Anthropic adapter sits in `adapter-anthropic.ts`
  // and translates the parts to its own `image` block shape inside
  // `toAnthropicMessageContent`. For plain strings, use the legacy
  // scalar wire format.
  //
  // Ollama native (`/api/chat`) uses a `messages[].images: [base64]`
  // field instead of `image_url` — but we exclusively talk to Ollama
  // through its `/v1/chat/completions` OpenAI-compat shim, which
  // accepts the `image_url` array form for any vision model loaded
  // (llava, llama3.2-vision, qwen2-vl, etc.). No translation needed.
  // MULTIMODAL-ROUTING-SECTION end
  const rawContent: unknown = m.content;
  const content: string | MessageContentPart[] = isMessageContentPartArray(
    rawContent,
  )
    ? rawContent
    : typeof rawContent === 'string'
      ? rawContent
      : '';

  // Orphan tool-role messages (no toolCallId — historical/synthetic
  // entries) MUST NOT be sent as role='tool': OpenAI/DeepSeek/most
  // providers reject the request with `missing field tool_call_id`,
  // and the bad message poisons every subsequent turn until the user
  // resets the session. Demote to role='user' with a clear prefix so
  // the model still sees the content but the wire schema stays valid.
  if (m.role === 'tool' && (!m.toolCallId || m.toolCallId.length === 0)) {
    const note = typeof content === 'string' ? content : '[tool output]';
    return {
      role: 'user',
      content: `[orphan tool result, no call_id]: ${note}`,
    };
  }
  const wire: WireMessage = { role: m.role, content };
  if (m.toolCallId) wire.tool_call_id = m.toolCallId;
  if (m.toolName) wire.name = m.toolName;
  if (m.toolCalls && m.toolCalls.length > 0) {
    wire.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: stringifyArgs(tc.arguments),
      },
    }));
  }
  return wire;
}

/**
 * Pre-send sanitiser that enforces OpenAI / DeepSeek schema invariants
 * on the messages array. Without this, a corrupted history (orphan tool
 * results, assistant.tool_calls without matching tool replies) poisons
 * EVERY subsequent turn — providers reject the request and the user
 * can't recover without manually editing the session DB.
 *
 * Two passes:
 *   1. Drop ORPHAN TOOL MESSAGES whose tool_call_id has no preceding
 *      assistant.tool_calls entry that opened it. This is the
 *      sliding-window cut case: when `applyRecentWindow` slices the
 *      first 30 messages off, a tool reply may end up at position [1]
 *      with its caller assistant gone. DeepSeek rejects this with
 *      "Messages with role 'tool' must be a response to a preceding
 *      message with 'tool_calls'". We walk forward and only keep tool
 *      messages whose id was opened by an assistant.tool_calls upstream
 *      in the SAME slice.
 *   2. Drop assistant.tool_calls entries whose id has no matching tool
 *      message anywhere later in the conversation. The assistant
 *      message keeps its content (if any).
 *   3. Reorder so each assistant.tool_calls is followed immediately by
 *      its matching tool replies (positional pairing requirement).
 */
export function sanitiseToolCallPairing(
  messages: readonly WireMessage[],
): WireMessage[] {
  // ---- Pass 1: drop orphan TOOL messages (no preceding assistant.tool_calls).
  // This protects against the sliding-window cut where the assistant
  // that emitted the tool_call got sliced off but its tool reply
  // survived at the head of the slice.
  //
  // M1 — `openToolCallIds` is a Map<string, number> counter, not a
  // Set, so we can accept N tool replies for the same id when the
  // assistant emitted N calls with that id. The old Set behaviour
  // `delete(id)` on first match dropped any model stutter where the
  // server re-emitted the same `tool_call_id` (rare but observed on
  // OpenRouter retries) — the second reply landed as an orphan and
  // got demoted, confusing the model. We DECREMENT the counter and
  // only stop matching once it hits zero.
  const openToolCallIds = new Map<string, number>();
  const afterToolPass: WireMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        if (typeof tc.id === 'string' && tc.id.length > 0) {
          openToolCallIds.set(tc.id, (openToolCallIds.get(tc.id) ?? 0) + 1);
        }
      }
      afterToolPass.push(m);
      continue;
    }
    if (m.role === 'tool') {
      const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
      const remaining = id.length > 0 ? openToolCallIds.get(id) ?? 0 : 0;
      if (remaining <= 0) {
        // Orphan — no open caller assistant slot for this id. Drop it.
        continue;
      }
      // Matched. Decrement so we still accept further replies up to
      // the original open count (handles model stutter that re-emits
      // the same tool_call_id twice), then surface this one.
      if (remaining === 1) {
        openToolCallIds.delete(id);
      } else {
        openToolCallIds.set(id, remaining - 1);
      }
      afterToolPass.push(m);
      continue;
    }
    afterToolPass.push(m);
  }

  // ---- Pass 2: drop ORPHAN assistant.tool_calls entries (no matching
  // tool reply downstream). This covers the inverse cut: caller
  // survived the slice but its replies were trimmed.
  const allToolReplyIds = new Set<string>();
  for (const m of afterToolPass) {
    if (m.role === 'tool' && typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0) {
      allToolReplyIds.add(m.tool_call_id);
    }
  }

  const out: WireMessage[] = [];
  for (const m of afterToolPass) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const kept = m.tool_calls.filter((tc) => allToolReplyIds.has(tc.id));
      const hasContent = typeof m.content === 'string'
        ? m.content.trim().length > 0
        : Array.isArray(m.content) && m.content.length > 0;
      if (kept.length === 0 && !hasContent) continue;  // drop empty assistant
      const cleaned: WireMessage = { ...m };
      if (kept.length > 0) {
        cleaned.tool_calls = kept;
      } else {
        delete cleaned.tool_calls;
      }
      out.push(cleaned);
      continue;
    }
    out.push(m);
  }

  // ---- Pass 3: enforce POSITIONAL pairing. OpenAI/DeepSeek require
  // assistant.tool_calls to be followed IMMEDIATELY by tool messages
  // for each tool_call_id, before any other role appears. Type-ahead
  // queue flushes can wedge a user message between assistant.tool_calls
  // and the tool result — DeepSeek then rejects with "insufficient
  // tool messages following". Reorder so user/assistant interlopers
  // move AFTER the matching tool replies.
  return reorderToolPairs(out);
}

function reorderToolPairs(messages: readonly WireMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  // Build an index of tool messages by tool_call_id (first occurrence
  // wins; duplicates are appended later as-is).
  const toolByCallId = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role === 'tool' && typeof m.tool_call_id === 'string'
        && m.tool_call_id.length > 0 && !toolByCallId.has(m.tool_call_id)) {
      toolByCallId.set(m.tool_call_id, i);
    }
  });
  const consumed = new Set<number>();
  for (let i = 0; i < messages.length; i += 1) {
    if (consumed.has(i)) continue;
    const m = messages[i];
    if (!m) continue;
    out.push(m);
    consumed.add(i);
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      // Pull the matching tool messages right after, in tool_calls order.
      for (const tc of m.tool_calls) {
        const idx = toolByCallId.get(tc.id);
        if (idx !== undefined && !consumed.has(idx)) {
          const toolMsg = messages[idx];
          if (toolMsg) {
            out.push(toolMsg);
            consumed.add(idx);
          }
        }
      }
    }
  }
  return out;
}

function stringifyArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return '{}';
  }
}

function mergeToolCallDelta(
  accumulator: Map<number, AccumulatedToolCall>,
  delta: ToolCallDelta
): void {
  const existing =
    accumulator.get(delta.index) ??
    ({
      index: delta.index,
      id: '',
      name: '',
      argumentsBuffer: '',
    } satisfies AccumulatedToolCall);

  if (delta.id && !existing.id) existing.id = delta.id;
  if (delta.function?.name) {
    // Some servers send the name in slices too; concatenate defensively.
    existing.name = existing.name + delta.function.name;
  }
  if (delta.function?.arguments) {
    existing.argumentsBuffer += delta.function.arguments;
  }
  accumulator.set(delta.index, existing);
}

function emitToolCalls(
  accumulator: Map<number, AccumulatedToolCall>,
  onToolCalls: ((toolCalls: ToolCall[]) => void) | undefined
): void {
  if (!onToolCalls) {
    accumulator.clear();
    return;
  }
  const sorted = Array.from(accumulator.values()).sort(
    (a, b) => a.index - b.index
  );
  const calls: ToolCall[] = [];
  for (const acc of sorted) {
    const args = safeParseJsonObject(acc.argumentsBuffer);
    calls.push({
      id: acc.id || `tool-${acc.index}-${Date.now().toString(36)}`,
      name: acc.name,
      arguments: args,
    });
  }
  accumulator.clear();
  if (calls.length > 0) onToolCalls(calls);
}

/**
 * FIX E — Qwen XML-tagged tool-call fallback parser.
 *
 * Some Qwen and Hermes-style models emit tool calls as XML inside
 * the content stream rather than via OpenAI's `delta.tool_calls`:
 *
 *   <tool_call>{"name": "read_file", "args": {"path": "a.txt"}}</tool_call>
 *
 * Variants seen in the wild:
 *   - `arguments` instead of `args`
 *   - `parameters` instead of `args`
 *   - missing `args` (unary tool)
 *   - whitespace / newlines inside the JSON
 *   - multiple `<tool_call>` blocks back-to-back
 *
 * This parser walks the buffer, extracts every well-formed
 * `<tool_call>...JSON...</tool_call>` block, and converts the JSON
 * payload into a {@link ToolCall}. Malformed blocks are silently
 * skipped — better to leave the XML visible in the user's reply
 * than to invent a wrong tool call.
 */
function extractXmlToolCalls(content: string): ToolCall[] {
  if (!content || content.length === 0) return [];
  const calls: ToolCall[] = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(content)) !== null) {
    const inner = (m[1] ?? '').trim();
    if (inner.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(inner);
    } catch {
      // Malformed JSON — skip; original XML stays in the visible reply.
      continue;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const name = obj.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    // Pull args from the most common variants.
    const rawArgs =
      (isPlainObject(obj.args) ? obj.args : undefined) ??
      (isPlainObject(obj.arguments) ? obj.arguments : undefined) ??
      (isPlainObject(obj.parameters) ? obj.parameters : undefined) ??
      {};
    calls.push({
      id: `xml-tc-${idx}-${Date.now().toString(36)}`,
      name,
      arguments: rawArgs as Record<string, unknown>,
    });
    idx += 1;
  }
  return calls;
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

function onceDone(
  onDone: ((result: StreamDoneResult) => void) | undefined
): (result: StreamDoneResult) => void {
  let fired = false;
  return (result) => {
    if (fired) return;
    fired = true;
    onDone?.(result);
  };
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
 * H2 — only retry errors that look like transport / network failures.
 *
 * Prior behaviour treated EVERY `error instanceof Error` as retryable,
 * which silently absorbed our own bugs (SyntaxError / TypeError /
 * RangeError from a malformed code path inside the stream loop) into
 * the retry cycle. The user then saw a "failed after 3 retries"
 * message that hid the original stack trace.
 *
 * New policy:
 *   - HttpError → 4xx fails fast unless `transient`; 5xx retries.
 *   - AbortError → user cancel / stall; never retry.
 *   - TypeError → fetch network failure (Node, Bun, browser all
 *     surface DNS / ECONNRESET / dropped sockets as TypeError).
 *   - Other Error → ONLY retry when the message matches a known
 *     network failure pattern. SyntaxError from a broken JSON.parse
 *     in our reader path falls through to `return false`, surfacing
 *     immediately so the bug is visible.
 */
const NETWORK_ERROR_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|fetch failed|network|socket hang up|TLS|terminated/i;

/**
 * Predicate: does this error count toward the circuit breaker's failure
 * tally? Only TRUE for transient backend failures — network errors,
 * explicit `HttpError.transient`, and 5xx responses. 4xx errors with no
 * transient marker (auth failures, malformed requests) almost always
 * indicate a caller bug; tripping the breaker on those would punish
 * other sessions for one user's mistake.
 *
 * AbortErrors (user cancellation, stall watchdog) are NOT transient —
 * they signal "user wanted to stop" or "we gave up", not "backend down".
 */
function isTransientForBreaker(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof BackendCircuitOpenError) return false;
  if (error instanceof HttpError) {
    if (error.transient) return true;
    return error.status >= 500;
  }
  // Network-level errors (DNS, ECONNRESET, TLS) typically surface as
  // TypeError from undici/fetch. Treat as transient — the upstream is
  // unreachable, which is exactly what the breaker is for.
  if (error instanceof TypeError) return true;
  // Generic Error (e.g. "LLM server returned no response body") is
  // ambiguous; err on the side of transient so a stuck upstream that
  // returns 200 + empty bodies still trips the breaker.
  if (error instanceof Error) return true;
  return false;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof HttpError) {
    // 4xx normally aren't retried (client error). EXCEPTION: errors
    // explicitly marked `transient` — e.g. OpenRouter 400 "Provider
    // returned error" wraps an upstream provider 5xx/timeout that the
    // gateway turned into a 400. Retrying with the same payload often
    // succeeds because the gateway routes to a different upstream.
    if (error.transient) return true;
    return error.status >= 500;
  }
  if (isAbortError(error)) return false;
  // TypeError from fetch typically means network/DNS/connection-reset.
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    return NETWORK_ERROR_RE.test(error.message);
  }
  return false;
}

function errorMessage(error: unknown): string {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function wrapError(prefix: string, error: unknown): Error {
  const cause = errorMessage(error);
  const wrapped = new Error(`${prefix}: ${cause}`);
  if (error instanceof Error) wrapped.stack = error.stack;
  return wrapped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 *
 * RFC 9110 allows two forms:
 *   - delta-seconds (a non-negative integer, e.g. `"30"`)
 *   - HTTP-date (e.g. `"Wed, 21 Oct 2015 07:28:00 GMT"`)
 *
 * Returns `undefined` for missing / malformed / past-dated values so
 * the caller falls back to its scheduled backoff. Negative or
 * zero-second hints clamp to 0 — the retry loop combines this with
 * the scheduled delay via `Math.max(...)` so a 0-hint never shortens
 * the backoff below the configured floor.
 */
export function parseRetryAfterHeader(
  raw: string | null | undefined,
): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // Form 1: delta-seconds.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const sec = Number(trimmed);
    if (!Number.isFinite(sec) || sec < 0) return undefined;
    return Math.floor(sec * 1000);
  }
  // Form 2: HTTP-date. Date.parse handles RFC 1123 / 850 / asctime.
  const ts = Date.parse(trimmed);
  if (!Number.isFinite(ts)) return undefined;
  const delta = ts - Date.now();
  if (delta <= 0) return 0;
  return delta;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return '';
  }
}

/**
 * R28 (Agent A) — return `true` when the given model name is an
 * OpenAI o1-class reasoning model. These models reject the standard
 * `temperature` / `top_p` / `max_tokens` knobs; the adapter strips
 * them from the request body when this returns `true`.
 *
 * Matches the canonical `o1-` prefix (covers `o1-preview`, `o1-mini`,
 * `o1-pro`, and any future `o1-*` SKU). Case-sensitive — OpenAI's
 * model IDs are lowercase.
 */
function isO1Model(modelName: string): boolean {
  if (!modelName) return false;
  return modelName.startsWith('o1-') || modelName === 'o1';
}

/**
 * R28 (Agent A) — extract the human-readable `error.message` from an
 * OpenAI / OpenRouter 4xx body.
 *
 * Format reference (OpenAI Error Codes):
 *   { "error": { "message": "...", "type": "...", "code": "..." } }
 *
 * Returns `null` when the input does not parse as JSON or doesn't
 * follow the canonical shape — callers fall back to the raw body in
 * that case so we never swallow useful diagnostics.
 */
function parseOpenAiErrorMessage(raw: string): string | null {
  if (!raw || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    const errField = parsed.error;
    if (!isPlainObject(errField)) return null;
    const msg = errField.message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
    return null;
  } catch {
    return null;
  }
}

// ---------- Concurrency primitives ----------

/**
 * Apply an async mapper to every element with a bounded concurrency cap.
 * Output ordering matches input ordering, independent of completion order.
 *
 * Behaviour:
 *   - At most `max` promises are in flight concurrently.
 *   - Each mapper result is stored at the element's original index.
 *   - Any mapper rejection propagates — the returned promise rejects with
 *     the first rejection encountered. Callers that want per-slot error
 *     isolation should catch inside their mapper and return a tagged
 *     result instead (that's what `LLMAdapter.streamMultiple` does).
 *
 * Used internally by `LLMAdapter.streamMultiple`, exported for other
 * places that need order-preserving bounded concurrency (e.g. parallel
 * file scans, parallel model pings).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, i: number) => Promise<R>,
  max: number,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(max));
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  let nextIndex = 0;
  const workers: Promise<void>[] = [];
  // Cap worker count at `limit` but never exceed the item count — no
  // point spinning up 8 workers for 3 items.
  const workerCount = Math.min(limit, items.length);

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      const item = items[i] as T; // bounds-checked above
      results[i] = await fn(item, i);
    }
  }

  for (let w = 0; w < workerCount; w += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Normalise the adapter's internal `StreamUsage` (all fields optional)
 * into the stricter `Usage` triple with defaults of 0 for missing
 * values. Only called after we know at least one field was reported.
 */
function toUsage(raw: StreamUsage): Usage {
  return {
    promptTokens: raw.promptTokens ?? 0,
    completionTokens: raw.completionTokens ?? 0,
    totalTokens:
      raw.totalTokens ??
      (raw.promptTokens ?? 0) + (raw.completionTokens ?? 0),
  };
}
