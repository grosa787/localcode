/**
 * R7 (Agent 9) — LLMAdapter cloud-provider tests.
 *
 * Covers the OpenAI-compatible code path for the new cloud backends
 * (`openai`, `openrouter`, `google`, `custom`). The Anthropic path uses
 * a separate adapter — covered in `tests/llm/adapter-anthropic.test.ts`.
 *
 * Each test installs a fake `globalThis.fetch` so we can inspect exactly
 * what the adapter sends to the network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import type { Message } from '@/types/global';
import type { StreamDoneResult } from '@/types/message';

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
  return { id: 'm-1', role: 'user', content, createdAt: 0 };
}

function basicTextThenStop(): string[] {
  const textFrame = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: 'ok' } }],
  })}\n\n`;
  const stopFrame = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`;
  return [textFrame, stopFrame, 'data: [DONE]\n\n'];
}

/**
 * Capture the headers from the most recent POST to `/v1/chat/completions`
 * (the one the adapter sends in `streamChat`). Returns null if no such
 * request was observed.
 */
interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function makeRecordingFetch(
  responseBuilder: () => Response,
): {
  fetchImpl: FetchImpl;
  recorded: RecordedRequest[];
} {
  const recorded: RecordedRequest[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string> | Headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k] = v;
        });
      } else {
        for (const [k, v] of Object.entries(h)) headers[k] = String(v);
      }
    }
    recorded.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return responseBuilder();
  };
  return { fetchImpl, recorded };
}

// ---------- Auth headers ----------

describe('LLMAdapter — auth headers per backend', () => {
  afterEach(() => restoreFetch());

  test('openai backend with apiKey adds Authorization: Bearer header', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch(() =>
      sseResponse(basicTextThenStop()),
    );
    installFetch(fetchImpl);

    const adapter = new LLMAdapter({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      backend: 'openai',
      apiKey: 'sk-test',
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
    });

    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: (r) => {
        done = r;
      },
    });
    expect(done).not.toBeNull();
    expect(recorded.length).toBeGreaterThan(0);
    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(last.url).toContain('/v1/chat/completions');
    expect(last.headers.Authorization ?? last.headers.authorization).toBe(
      'Bearer sk-test',
    );
  });

  test('openrouter backend adds HTTP-Referer + X-Title headers', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch(() =>
      sseResponse(basicTextThenStop()),
    );
    installFetch(fetchImpl);

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      backend: 'openrouter',
      apiKey: 'or-test-key',
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
    });

    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(last.headers['HTTP-Referer'] ?? last.headers['http-referer']).toBe(
      'https://github.com/localcode',
    );
    expect(last.headers['X-Title'] ?? last.headers['x-title']).toBe(
      'LocalCode',
    );
    expect(last.headers.Authorization ?? last.headers.authorization).toBe(
      'Bearer or-test-key',
    );
  });

  test('ollama backend sends NO Authorization header', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch(() =>
      sseResponse(basicTextThenStop()),
    );
    installFetch(fetchImpl);

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:11434',
      model: 'llama3',
      backend: 'ollama',
      apiKey: 'should-be-ignored',
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
    });

    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(last.headers.Authorization).toBeUndefined();
    expect(last.headers.authorization).toBeUndefined();
  });

  test('lmstudio backend sends NO Authorization header', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch(() =>
      sseResponse(basicTextThenStop()),
    );
    installFetch(fetchImpl);

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      apiKey: 'should-be-ignored',
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
    });

    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(last.headers.Authorization).toBeUndefined();
    expect(last.headers.authorization).toBeUndefined();
  });

  test('custom backend with apiKey adds Bearer auth', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch(() =>
      sseResponse(basicTextThenStop()),
    );
    installFetch(fetchImpl);

    const adapter = new LLMAdapter({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1-70b',
      backend: 'custom',
      apiKey: 'gsk-test',
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
    });

    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(last.headers.Authorization ?? last.headers.authorization).toBe(
      'Bearer gsk-test',
    );
  });

  test('customHeaders extra entries merge into the request', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch(() =>
      sseResponse(basicTextThenStop()),
    );
    installFetch(fetchImpl);

    const adapter = new LLMAdapter({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      backend: 'openai',
      apiKey: 'sk-test',
      customHeaders: {
        'X-Tenant': 'team-1',
        'X-Trace-Id': 'abc-123',
      },
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
    });

    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(last.headers['X-Tenant'] ?? last.headers['x-tenant']).toBe(
      'team-1',
    );
    expect(last.headers['X-Trace-Id'] ?? last.headers['x-trace-id']).toBe(
      'abc-123',
    );
    // Auth still present.
    expect(last.headers.Authorization ?? last.headers.authorization).toBe(
      'Bearer sk-test',
    );
  });

  test('customHeaders override default headers (last write wins)', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch(() =>
      sseResponse(basicTextThenStop()),
    );
    installFetch(fetchImpl);

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      backend: 'openrouter',
      apiKey: 'or-key',
      customHeaders: {
        'X-Title': 'MyCustomApp',
      },
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
    });

    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(last.headers['X-Title'] ?? last.headers['x-title']).toBe(
      'MyCustomApp',
    );
  });
});

// ---------- getModels ----------

describe('LLMAdapter.getModels — cloud providers', () => {
  afterEach(() => restoreFetch());

  test('openai parses /v1/models response (data[].id)', async () => {
    installFetch(async (url) => {
      const u = String(url);
      expect(u).toContain('/v1/models');
      return jsonResponse(200, {
        data: [
          { id: 'gpt-4o' },
          { id: 'gpt-4o-mini' },
          { id: 'gpt-3.5-turbo' },
        ],
      });
    });
    const adapter = new LLMAdapter({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      backend: 'openai',
      apiKey: 'sk-test',
      pingTimeoutMs: 500,
    });
    const models = await adapter.getModels();
    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo']);
  });

  test('openrouter parses /v1/models — returns array of ids', async () => {
    installFetch(async () =>
      jsonResponse(200, {
        data: [
          { id: 'anthropic/claude-3.5-sonnet' },
          { id: 'meta-llama/llama-3.1-70b-instruct' },
        ],
      }),
    );
    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      backend: 'openrouter',
      apiKey: 'or-key',
      pingTimeoutMs: 500,
    });
    const models = await adapter.getModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models).toContain('anthropic/claude-3.5-sonnet');
    expect(models).toContain('meta-llama/llama-3.1-70b-instruct');
  });

  test('getModels for openai forwards Authorization header', async () => {
    let sawHeader: string | undefined;
    installFetch(async (_url, init) => {
      const h = init?.headers as Record<string, string> | undefined;
      sawHeader = h?.Authorization ?? h?.authorization;
      return jsonResponse(200, { data: [{ id: 'gpt-4o' }] });
    });
    const adapter = new LLMAdapter({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      backend: 'openai',
      apiKey: 'sk-list-test',
      pingTimeoutMs: 500,
    });
    await adapter.getModels();
    expect(sawHeader).toBe('Bearer sk-list-test');
  });
});

// ---------- 4xx error surface ----------

describe('LLMAdapter — 4xx response surfaces in onDone', () => {
  afterEach(() => restoreFetch());

  test('401 from openai surfaces as error in onDone', async () => {
    installFetch(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Incorrect API key provided.',
            type: 'invalid_request_error',
          },
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const adapter = new LLMAdapter({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      backend: 'openai',
      apiKey: 'sk-bad',
      maxAttempts: 1,
      initialBackoffMs: 1,
      requestTimeoutMs: 5_000,
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
    expect(d.error ?? '').toContain('401');
  });

  test('429 (rate limit) surfaces in onDone after retries exhausted', async () => {
    let calls = 0;
    installFetch(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: { message: 'rate limited', type: 'rate_limit_error' },
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const adapter = new LLMAdapter({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      backend: 'openai',
      apiKey: 'sk-test',
      maxAttempts: 2,
      initialBackoffMs: 1,
      requestTimeoutMs: 5_000,
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
    expect(calls).toBeGreaterThan(0);
  });
});
