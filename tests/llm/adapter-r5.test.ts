/**
 * R5 — `LLMAdapter` `generation` field pass-through (FIX #35).
 *
 * The adapter accepts a `generation: GenerationConfig` constructor
 * field and forwards it to every `streamChat` POST in a backend-aware
 * shape:
 *
 *   - Ollama:    `options.{repeat_penalty, num_predict, temperature, top_p}`
 *                (Ollama's native names; merged alongside any existing
 *                 `options` block).
 *   - LM Studio: top-level `temperature`, `top_p`, `max_tokens`, plus
 *                `frequency_penalty: repeatPenalty - 1` (centring the
 *                repeat-penalty knob on 0.0 instead of 1.0).
 *
 * When `generation` is omitted, the request body must continue to work
 * (no extra params, no errors).
 *
 * These tests intercept fetch, capture the POST body, and assert the
 * shape — they do NOT need a real LLM.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import type { Message } from '@/types/global';
import type { StreamChatParams } from '@/types/message';

type FetchImpl = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
const realFetch = globalThis.fetch;

function installFetch(impl: FetchImpl): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function stopFrames(): string[] {
  const stop = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
  })}\n\n`;
  return [stop, 'data: [DONE]\n\n'];
}

function captureBodyFetch(
  capture: { body: Record<string, unknown> | null },
): FetchImpl {
  return async (_url, init) => {
    const raw = (init as RequestInit | undefined)?.body;
    if (typeof raw === 'string') {
      try {
        capture.body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        capture.body = null;
      }
    } else {
      capture.body = null;
    }
    return sseResponse(stopFrames());
  };
}

function baseParams(): StreamChatParams {
  const m: Message = {
    id: 'u-1',
    role: 'user',
    content: 'hi',
    createdAt: 0,
  };
  return { messages: [m] };
}

// ---------- Ollama backend ----------

describe('LLMAdapter — generation pass-through (Ollama)', () => {
  afterEach(() => restoreFetch());

  test('emits options.{repeat_penalty, num_predict, temperature, top_p}', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5-coder',
      backend: 'ollama',
      maxAttempts: 1,
      initialBackoffMs: 1,
      generation: {
        temperature: 0.42,
        topP: 0.85,
        repeatPenalty: 1.15,
        maxTokens: 2048,
      },
    });

    await adapter.streamChat(baseParams());

    expect(captured.body).not.toBeNull();
    const opts = (captured.body as { options?: Record<string, unknown> })
      .options;
    expect(opts).toBeDefined();
    expect(opts!.repeat_penalty).toBe(1.15);
    expect(opts!.num_predict).toBe(2048);
    expect(opts!.temperature).toBe(0.42);
    expect(opts!.top_p).toBe(0.85);
  });

  test('contextMaxTokens (num_ctx) coexists with generation knobs', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5-coder',
      backend: 'ollama',
      maxAttempts: 1,
      initialBackoffMs: 1,
      contextMaxTokens: 16384,
      generation: {
        temperature: 0.1,
        topP: 0.95,
        repeatPenalty: 1.05,
        maxTokens: 1024,
      },
    });

    await adapter.streamChat(baseParams());

    const opts = (captured.body as { options: Record<string, unknown> }).options;
    expect(opts.num_ctx).toBe(16384);
    expect(opts.repeat_penalty).toBe(1.05);
    expect(opts.num_predict).toBe(1024);
    expect(opts.temperature).toBe(0.1);
    expect(opts.top_p).toBe(0.95);
  });
});

// ---------- LM Studio backend ----------

describe('LLMAdapter — generation pass-through (LM Studio)', () => {
  afterEach(() => restoreFetch());

  test('emits top-level temperature/top_p/max_tokens + frequency_penalty', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'lmstudio-model',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      generation: {
        temperature: 0.7,
        topP: 0.92,
        repeatPenalty: 1.2,
        maxTokens: 1500,
      },
    });

    await adapter.streamChat(baseParams());

    const body = captured.body as Record<string, unknown>;
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.92);
    expect(body.max_tokens).toBe(1500);
    // 1.2 - 1 = 0.2 (centred). Allow tiny FP wobble.
    const freq = body.frequency_penalty as number;
    expect(typeof freq).toBe('number');
    expect(Math.abs(freq - 0.2)).toBeLessThan(1e-9);
  });

  test('repeatPenalty == 1.0 → frequency_penalty == 0.0 (neutral)', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'lmstudio',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      generation: {
        temperature: 0.5,
        topP: 0.9,
        repeatPenalty: 1.0,
        maxTokens: 512,
      },
    });

    await adapter.streamChat(baseParams());
    const body = captured.body as Record<string, unknown>;
    expect(body.frequency_penalty).toBe(0);
  });

  test('LM Studio body has no `options` block (Ollama-only field)', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'lmstudio',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      generation: {
        temperature: 0.3,
        topP: 0.9,
        repeatPenalty: 1.1,
        maxTokens: 256,
      },
    });

    await adapter.streamChat(baseParams());
    expect(captured.body).not.toBeNull();
    expect((captured.body as Record<string, unknown>).options).toBeUndefined();
  });
});

// ---------- Without generation ----------

describe('LLMAdapter — no generation field', () => {
  afterEach(() => restoreFetch());

  test('Ollama POST works without generation (no extra options)', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:11434',
      model: 'm',
      backend: 'ollama',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    await adapter.streamChat(baseParams());
    expect(captured.body).not.toBeNull();

    const body = captured.body as Record<string, unknown>;
    // No top-level temperature / top_p / max_tokens.
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    // Either no `options` at all (no num_ctx either) or an `options`
    // block that does NOT include any generation knobs.
    const opts = body.options as Record<string, unknown> | undefined;
    if (opts) {
      expect(opts.repeat_penalty).toBeUndefined();
      expect(opts.num_predict).toBeUndefined();
      expect(opts.temperature).toBeUndefined();
      expect(opts.top_p).toBeUndefined();
    }
  });

  test('LM Studio POST works without generation (no extra fields)', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'm',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    await adapter.streamChat(baseParams());
    const body = captured.body as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.frequency_penalty).toBeUndefined();
    // Body shape itself must still be valid: model + messages + stream.
    expect(body.model).toBe('m');
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.stream).toBe(true);
  });
});
