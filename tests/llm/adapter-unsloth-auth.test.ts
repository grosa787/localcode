/**
 * Unsloth Studio auth regression guard.
 *
 * Unsloth serves an OpenAI-compatible API on localhost but REQUIRES
 * `Authorization: Bearer sk-unsloth-…`. The predicate that decides this
 * (`isOpenAiCompatCloud` in `src/llm/adapter.ts`) is a `||` chain of
 * string literals, not a Record — dropping `'unsloth'` from it compiles
 * clean, passes every other test in the suite, and 401s on 100% of
 * requests. This file is the only thing standing between that refactor
 * and a silent, undiagnosable failure.
 *
 * It also pins the negative half of the contract: Unsloth must NOT
 * receive the OpenRouter attribution headers, which Unsloth documents
 * as invalidating the KV cache (~90% throughput loss on local models).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import type { Message } from '@/types/global';

type FetchImpl = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

const realFetch = globalThis.fetch;

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** Case-insensitive header lookup — `fetch` may normalise casing. */
function authOf(req: RecordedRequest): string | undefined {
  return req.headers.Authorization ?? req.headers.authorization;
}

function sseResponse(frames: readonly string[]): Response {
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

/** Minimal Unsloth SSE transcript: one content delta, stop, [DONE]. */
function unslothStream(): string[] {
  const text = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: 'ok' } }],
  })}\n\n`;
  const stop = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`;
  return [text, stop, 'data: [DONE]\n\n'];
}

function installRecordingFetch(build: () => Response): RecordedRequest[] {
  const recorded: RecordedRequest[] = [];
  const impl: FetchImpl = async (url, init) => {
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
    recorded.push({ url: String(url), headers });
    return build();
  };
  globalThis.fetch = impl as unknown as typeof fetch;
  return recorded;
}

function makeAdapter(): LLMAdapter {
  return new LLMAdapter({
    baseUrl: 'http://localhost:8888/v1',
    model: 'unsloth/qwen3-coder-30B-GGUF',
    backend: 'unsloth',
    apiKey: 'sk-unsloth-test-key',
    maxAttempts: 1,
    requestTimeoutMs: 5_000,
    pingTimeoutMs: 500,
  });
}

const userMessage: Message = {
  id: 'm-1',
  role: 'user',
  content: 'hi',
  createdAt: 0,
};

describe('LLMAdapter — unsloth requires bearer auth', () => {
  afterEach(() => restoreFetch());

  test('streamChat sends Authorization: Bearer', async () => {
    const recorded = installRecordingFetch(() => sseResponse(unslothStream()));

    await makeAdapter().streamChat({
      messages: [userMessage],
      onDone: () => {
        /* noop */
      },
    });

    expect(recorded.length).toBeGreaterThan(0);
    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(last.url).toContain('/v1/chat/completions');
    expect(authOf(last)).toBe('Bearer sk-unsloth-test-key');
  });

  test('getModels sends Authorization: Bearer', async () => {
    const recorded = installRecordingFetch(
      () =>
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'unsloth/qwen3-coder-30B-GGUF',
                object: 'model',
                owned_by: 'local',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const models = await makeAdapter().getModels();

    expect(models).toContain('unsloth/qwen3-coder-30B-GGUF');
    const first = recorded[0] as RecordedRequest;
    expect(first.url).toContain('/v1/models');
    expect(authOf(first)).toBe('Bearer sk-unsloth-test-key');
  });

  test('does not emit OpenRouter attribution headers (KV-cache cost)', async () => {
    const recorded = installRecordingFetch(() => sseResponse(unslothStream()));

    await makeAdapter().streamChat({
      messages: [userMessage],
      onDone: () => {
        /* noop */
      },
    });

    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(last.headers['HTTP-Referer'] ?? last.headers['http-referer']).toBe(
      undefined,
    );
    expect(last.headers['X-Title'] ?? last.headers['x-title']).toBe(undefined);
  });
});
