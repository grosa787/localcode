/**
 * OpenRouter routing-flag tests.
 *
 * Verifies that the new token-economy hints —
 *   - top-level `route: 'fallback'`
 *   - top-level `usage: { include: true }`
 *   - top-level `transforms: ['middle-out']`
 *   - `provider.allow_fallbacks: true`
 *   - `provider.sort: 'throughput'`
 * — are present in the request body for the `openrouter` backend, AND
 * absent for OpenAI-compatible siblings (where they would be unknown
 * parameters and could 400 the request).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import type { Message } from '@/types/global';

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

function basicTextThenStop(): string[] {
  const text = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: 'ok' } }],
  })}\n\n`;
  const stop = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`;
  return [text, stop, 'data: [DONE]\n\n'];
}

function baseMessage(content: string): Message {
  return { id: 'm-1', role: 'user', content, createdAt: 0 };
}

interface Recorded {
  url: string;
  body: unknown;
}

function makeRecordingFetch(): { fetchImpl: FetchImpl; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    let parsed: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    }
    recorded.push({ url: String(url), body: parsed });
    return sseResponse(basicTextThenStop());
  };
  return { fetchImpl, recorded };
}

afterEach(() => {
  restoreFetch();
});

describe('OpenRouter request body — token-economy routing flags', () => {
  test('openrouter body includes route:fallback, usage.include, transforms, provider.allow_fallbacks/sort', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch();
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

    const last = recorded[recorded.length - 1];
    expect(last).toBeDefined();
    const body = last?.body as Record<string, unknown>;
    expect(body.route).toBe('fallback');
    expect(body.usage).toEqual({ include: true });
    expect(body.transforms).toEqual(['middle-out']);
    const provider = body.provider as Record<string, unknown>;
    expect(provider).toBeDefined();
    expect(provider.allow_fallbacks).toBe(true);
    expect(provider.sort).toBe('throughput');
  });

  test('openai backend does NOT include route/usage/transforms/provider', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch();
    installFetch(fetchImpl);

    const adapter = new LLMAdapter({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      backend: 'openai',
      apiKey: 'sk-test',
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
    });

    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: () => {
        /* noop */
      },
    });

    const last = recorded[recorded.length - 1];
    expect(last).toBeDefined();
    const body = last?.body as Record<string, unknown>;
    expect('route' in body).toBe(false);
    expect('usage' in body).toBe(false);
    expect('transforms' in body).toBe(false);
    expect('provider' in body).toBe(false);
  });

  test('custom backend does NOT include OpenRouter-specific fields', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch();
    installFetch(fetchImpl);

    const adapter = new LLMAdapter({
      baseUrl: 'https://api.example.com/v1',
      model: 'custom-model',
      backend: 'custom',
      apiKey: 'x-test',
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
    });

    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: () => {
        /* noop */
      },
    });

    const last = recorded[recorded.length - 1];
    const body = last?.body as Record<string, unknown>;
    expect('route' in body).toBe(false);
    expect('provider' in body).toBe(false);
  });
});
