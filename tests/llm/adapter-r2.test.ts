/**
 * R2 additions to LLMAdapter:
 *   - Stall detection (stallTimeoutMs).
 *   - Usage capture (OpenAI-compat final chunk + Ollama prompt_eval_count).
 *   - Ollama vs LM Studio backend-specific request body (num_ctx, keep_alive).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import type { Message } from '@/types/global';
import type { StreamDoneResult } from '@/types/message';

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
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

function baseMessage(content: string): Message {
  return { id: 'm1', role: 'user', content, createdAt: 0 };
}

describe('LLMAdapter — stall detection', () => {
  afterEach(() => restoreFetch());

  test('aborts with a stall-specific error when no chunks arrive in time', async () => {
    // Build a ReadableStream that only signals "done" when the adapter's
    // AbortController fires — that's how a real server hangs. The stall
    // timer must trip and abort the reader before anything arrives.
    installFetch(async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      let cancelStream: (() => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // When the adapter aborts its controller (triggered by the
          // stall timer), drop an `error` onto the stream so the reader
          // promise rejects with an AbortError-shaped Error.
          const onAbort = (): void => {
            try {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              controller.error(err);
            } catch {
              // swallow — controller may already be closed
            }
          };
          cancelStream = onAbort;
          if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        },
        cancel() {
          cancelStream?.();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      stallTimeoutMs: 100,
      requestTimeoutMs: 10_000,
    });

    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: (r) => {
        done = r;
      },
    });

    expect(done).not.toBeNull();
    const d = done as unknown as StreamDoneResult;
    expect(d.finishReason).toBe('error');
    expect(d.error ?? '').toContain('stalled');
    expect(typeof d.durationMs).toBe('number');
  });
});

describe('LLMAdapter — usage capture from final chunk', () => {
  afterEach(() => restoreFetch());

  test('captures OpenAI-style prompt_tokens + completion_tokens', async () => {
    const textFrame = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'hi' } }],
    })}\n\n`;
    const stopFrame = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`;
    // Final usage-only chunk (choices: []).
    const usageFrame = `data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 42,
        completion_tokens: 7,
        total_tokens: 49,
      },
    })}\n\n`;
    const done = 'data: [DONE]\n\n';

    installFetch(async () => sseResponse([textFrame, stopFrame, usageFrame, done]));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    let result: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [baseMessage('x')],
      onDone: (r) => {
        result = r;
      },
    });

    expect(result).not.toBeNull();
    const r = result as unknown as StreamDoneResult;
    expect(r.usage).toBeDefined();
    expect(r.usage?.promptTokens).toBe(42);
    expect(r.usage?.completionTokens).toBe(7);
    expect(r.usage?.totalTokens).toBe(49);
    expect(typeof r.durationMs).toBe('number');
    expect((r.durationMs ?? 0) >= 0).toBe(true);
  });

  test('also accepts Ollama-native prompt_eval_count / eval_count', async () => {
    const textFrame = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'hi' } }],
    })}\n\n`;
    const stopFrame = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`;
    const usageFrame = `data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_eval_count: 15,
        eval_count: 5,
      },
    })}\n\n`;
    const done = 'data: [DONE]\n\n';

    installFetch(async () => sseResponse([textFrame, stopFrame, usageFrame, done]));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:11434',
      model: 'test',
      backend: 'ollama',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    let result: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [baseMessage('x')],
      onDone: (r) => {
        result = r;
      },
    });

    const r = result as unknown as StreamDoneResult;
    expect(r.usage?.promptTokens).toBe(15);
    expect(r.usage?.completionTokens).toBe(5);
    // totalTokens fallback (15 + 5 = 20) when not explicit.
    expect(r.usage?.totalTokens).toBe(20);
  });

  test('falls back to estimated usage when server omits it', async () => {
    const textFrame = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'abcdabcd' } }],
    })}\n\n`;
    const stopFrame = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`;
    const done = 'data: [DONE]\n\n';

    installFetch(async () => sseResponse([textFrame, stopFrame, done]));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    let result: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [baseMessage('x')],
      onDone: (r) => {
        result = r;
      },
    });

    const r = result as unknown as StreamDoneResult;
    expect(r.usage).toBeDefined();
    expect(r.usage?.estimated).toBe(true);
    expect((r.usage?.completionTokens ?? 0) > 0).toBe(true);
  });
});

describe('LLMAdapter — Ollama-specific request body', () => {
  afterEach(() => restoreFetch());

  test('detects Ollama via :11434 port and adds num_ctx + keep_alive', async () => {
    let capturedBody: unknown = null;
    installFetch(async (_url, init) => {
      const body = (init as RequestInit | undefined)?.body;
      if (typeof body === 'string') capturedBody = JSON.parse(body);
      const stop = `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`;
      return sseResponse([stop, 'data: [DONE]\n\n']);
    });

    // NOTE: no `backend` override — detection must fall back to the URL.
    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5-coder:32b',
      maxAttempts: 1,
      initialBackoffMs: 1,
      contextMaxTokens: 32768,
      keepAliveSeconds: 1800,
    });

    await adapter.streamChat({
      messages: [baseMessage('x')],
    });

    expect(capturedBody).not.toBeNull();
    const body = capturedBody as {
      model: string;
      options?: { num_ctx?: number };
      keep_alive?: string;
    };
    expect(body.options).toBeDefined();
    expect(body.options?.num_ctx).toBe(32768);
    expect(body.keep_alive).toBe('1800s');
    expect(body.model).toBe('qwen2.5-coder:32b');
  });

  test('explicit backend=ollama honours num_ctx even on non-standard port', async () => {
    let capturedBody: unknown = null;
    installFetch(async (_url, init) => {
      const body = (init as RequestInit | undefined)?.body;
      if (typeof body === 'string') capturedBody = JSON.parse(body);
      const stop = `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`;
      return sseResponse([stop, 'data: [DONE]\n\n']);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'x',
      backend: 'ollama',
      maxAttempts: 1,
      initialBackoffMs: 1,
      contextMaxTokens: 16384,
      keepAliveSeconds: 60,
    });

    await adapter.streamChat({ messages: [baseMessage('x')] });

    const body = capturedBody as {
      options?: { num_ctx?: number };
      keep_alive?: string;
    } | null;
    expect(body?.options?.num_ctx).toBe(16384);
    expect(body?.keep_alive).toBe('60s');
  });
});

describe('LLMAdapter — LM Studio request body', () => {
  afterEach(() => restoreFetch());

  test('backend=lmstudio omits num_ctx and keep_alive', async () => {
    let capturedBody: unknown = null;
    installFetch(async (_url, init) => {
      const body = (init as RequestInit | undefined)?.body;
      if (typeof body === 'string') capturedBody = JSON.parse(body);
      const stop = `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`;
      return sseResponse([stop, 'data: [DONE]\n\n']);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'some-model',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      // Passed in but must be dropped for LM Studio.
      contextMaxTokens: 32768,
      keepAliveSeconds: 3600,
    });

    await adapter.streamChat({ messages: [baseMessage('x')] });

    const body = capturedBody as {
      options?: unknown;
      keep_alive?: unknown;
      stream_options?: { include_usage?: boolean };
    } | null;
    // No num_ctx, no keep_alive.
    expect(body?.keep_alive).toBeUndefined();
    // `options` should either be absent or not contain num_ctx.
    if (body?.options !== undefined) {
      const opts = body.options as Record<string, unknown>;
      expect(opts['num_ctx']).toBeUndefined();
    }
    // include_usage is always requested.
    expect(body?.stream_options?.include_usage).toBe(true);
  });
});
