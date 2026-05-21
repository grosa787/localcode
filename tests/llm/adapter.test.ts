import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import type { Message } from '@/types/global';
import type { StreamDoneResult } from '@/types/message';

// ---------- fetch mocking scaffolding ----------

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

const realFetch = globalThis.fetch;

function installFetch(impl: FetchImpl): void {
  // Cast intentionally — we wrap the full browser/Bun fetch surface.
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
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function baseMessage(content: string): Message {
  return {
    id: 'msg-1',
    role: 'user',
    content,
    createdAt: 0,
  };
}

// Shrinks retry backoff so tests run fast.
function makeAdapter(overrides?: {
  baseUrl?: string;
  model?: string;
  backend?: 'ollama' | 'lmstudio';
  maxAttempts?: number;
  initialBackoffMs?: number;
}): LLMAdapter {
  return new LLMAdapter({
    baseUrl: overrides?.baseUrl ?? 'http://localhost:1234/v1',
    model: overrides?.model ?? 'test-model',
    backend: overrides?.backend ?? 'lmstudio',
    maxAttempts: overrides?.maxAttempts ?? 3,
    initialBackoffMs: overrides?.initialBackoffMs ?? 1,
    requestTimeoutMs: 5_000,
    pingTimeoutMs: 500,
  });
}

// ---------- Tests ----------

describe('LLMAdapter.getModels', () => {
  afterEach(() => restoreFetch());

  test('parses /v1/models data', async () => {
    installFetch(async (url) => {
      expect(String(url)).toContain('/v1/models');
      return jsonResponse(200, {
        data: [{ id: 'model-a' }, { id: 'model-b' }],
      });
    });
    const adapter = makeAdapter();
    const models = await adapter.getModels();
    expect(models).toEqual(['model-a', 'model-b']);
  });

  test('falls back to /api/tags when /v1/models 404s (ollama)', async () => {
    let sawPrimary = false;
    let sawFallback = false;
    installFetch(async (url) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) {
        sawPrimary = true;
        return new Response('', { status: 404 });
      }
      if (u.endsWith('/api/tags')) {
        sawFallback = true;
        return jsonResponse(200, {
          models: [{ name: 'llama3:latest' }, { name: 'qwen:32b' }],
        });
      }
      throw new Error(`unexpected url ${u}`);
    });
    const adapter = makeAdapter({ backend: 'ollama', baseUrl: 'http://localhost:11434' });
    const models = await adapter.getModels();
    expect(sawPrimary).toBe(true);
    expect(sawFallback).toBe(true);
    expect(models).toEqual(['llama3:latest', 'qwen:32b']);
  });
});

describe('LLMAdapter.ping', () => {
  afterEach(() => restoreFetch());

  test('returns true on 2xx', async () => {
    installFetch(async () => jsonResponse(200, { data: [] }));
    const adapter = makeAdapter();
    expect(await adapter.ping()).toBe(true);
  });

  test('returns false when fetch throws (server down)', async () => {
    installFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const adapter = makeAdapter();
    expect(await adapter.ping()).toBe(false);
  });
});

describe('LLMAdapter.streamChat — text chunks', () => {
  afterEach(() => restoreFetch());

  test('parses two content deltas + stop finish_reason', async () => {
    const frame1 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'Hello, ' } }],
    })}\n\n`;
    const frame2 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'world!' } }],
    })}\n\n`;
    const frame3 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`;
    const frame4 = 'data: [DONE]\n\n';

    installFetch(async () => sseResponse([frame1, frame2, frame3, frame4]));

    const chunks: string[] = [];
    let doneResult: StreamDoneResult | null = null;
    const adapter = makeAdapter();
    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onChunk: (t) => chunks.push(t),
      onDone: (r) => {
        doneResult = r;
      },
    });

    expect(chunks).toEqual(['Hello, ', 'world!']);
    expect(doneResult).not.toBeNull();
    // After [DONE], the loop returns and onDone is invoked with 'stop'.
    // Accept either 'stop' (captured from choice) or the adapter's
    // synthetic 'stop' emitted after a successful runStreamOnce.
    expect(['stop']).toContain((doneResult as unknown as StreamDoneResult).finishReason);
  });
});

describe('LLMAdapter.streamChat — tool calls', () => {
  afterEach(() => restoreFetch());

  test('reconstructs partial tool_call deltas on finish_reason tool_calls', async () => {
    // Three chunks representing partial tool calls: id + name, then args part 1,
    // then args part 2, then finish_reason tool_calls.
    const part1 = `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', function: { name: 'read_file' } },
            ],
          },
        },
      ],
    })}\n\n`;
    const part2 = `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '{"path":' } },
            ],
          },
        },
      ],
    })}\n\n`;
    const part3 = `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '"a.ts"}' } },
            ],
          },
        },
      ],
    })}\n\n`;
    const final = `data: ${JSON.stringify({
      choices: [
        { index: 0, delta: {}, finish_reason: 'tool_calls' },
      ],
    })}\n\n`;
    const doneFrame = 'data: [DONE]\n\n';

    installFetch(async () =>
      sseResponse([part1, part2, part3, final, doneFrame]),
    );

    let emittedOnce = 0;
    let captured: Array<{ id: string; name: string; arguments: Record<string, unknown> }> =
      [];
    const adapter = makeAdapter();
    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onToolCalls: (calls) => {
        emittedOnce += 1;
        captured = calls;
      },
    });

    expect(emittedOnce).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.name).toBe('read_file');
    expect(captured[0]?.arguments).toEqual({ path: 'a.ts' });
  });
});

describe('LLMAdapter.streamChat — retry / error handling', () => {
  afterEach(() => restoreFetch());

  test('retries network errors and eventually succeeds', async () => {
    let calls = 0;
    installFetch(async () => {
      calls += 1;
      if (calls < 3) {
        throw new TypeError('ECONNRESET');
      }
      const frame1 = `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: 'ok' } }],
      })}\n\n`;
      const frame2 = `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`;
      const done = 'data: [DONE]\n\n';
      return sseResponse([frame1, frame2, done]);
    });

    const adapter = makeAdapter({ initialBackoffMs: 1 });
    const chunks: string[] = [];
    let err: string | undefined;
    await adapter.streamChat({
      messages: [baseMessage('x')],
      onChunk: (t) => chunks.push(t),
      onDone: (r) => {
        err = r.error;
      },
    });
    expect(calls).toBe(3);
    expect(chunks).toEqual(['ok']);
    expect(err).toBeUndefined();
  });

  test('does not retry on 4xx — onDone fires with error', async () => {
    let calls = 0;
    installFetch(async () => {
      calls += 1;
      return new Response('Bad request body', {
        status: 400,
        statusText: 'Bad Request',
      });
    });

    const adapter = makeAdapter({ initialBackoffMs: 1 });
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [baseMessage('x')],
      onDone: (r) => {
        done = r;
      },
    });
    expect(calls).toBe(1);
    expect(done).not.toBeNull();
    const d = done as unknown as StreamDoneResult;
    expect(d.finishReason).toBe('error');
    expect(d.error).toContain('400');
  });

  test('cancel() aborts in-flight stream and reports aborted', async () => {
    const adapter = makeAdapter({ initialBackoffMs: 1 });

    installFetch(async (_url, init) => {
      // Respect the adapter-provided signal: reject with AbortError when it fires.
      const signal = (init as RequestInit | undefined)?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        const reject404 = (): void => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal) {
          if (signal.aborted) {
            reject404();
            return;
          }
          signal.addEventListener('abort', reject404, { once: true });
        }
        // Never resolve — test will cancel.
      });
    });

    let done: StreamDoneResult | null = null;
    const streamPromise = adapter.streamChat({
      messages: [baseMessage('x')],
      onDone: (r) => {
        done = r;
      },
    });

    // Give the fetch a tick to install its abort listener.
    await new Promise((r) => setTimeout(r, 10));
    adapter.cancel();

    await streamPromise;
    expect(done).not.toBeNull();
    const d = done as unknown as StreamDoneResult;
    expect(d.finishReason).toBe('aborted');
    expect(d.error).toBeDefined();
  });
});

describe('LLMAdapter.streamChat — message serialisation', () => {
  beforeEach(() => {
    // clean slate
  });
  afterEach(() => restoreFetch());

  test('serialises tool-role messages with tool_call_id passthrough', async () => {
    let capturedBody: unknown = null;
    installFetch(async (_url, init) => {
      const body = (init as RequestInit | undefined)?.body;
      if (typeof body === 'string') capturedBody = JSON.parse(body);
      const frame = `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`;
      return sseResponse([frame, 'data: [DONE]\n\n']);
    });

    const adapter = makeAdapter();
    await adapter.streamChat({
      messages: [
        { id: '1', role: 'user', content: 'hi', createdAt: 0 },
        // Assistant caller required so the tool reply isn't dropped as
        // an orphan by `sanitiseToolCallPairing` (DeepSeek invariant).
        {
          id: '1a',
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-abc', name: 'read_file', arguments: { path: 'x.ts' } },
          ],
          createdAt: 0,
        },
        {
          id: '2',
          role: 'tool',
          content: 'ok',
          createdAt: 0,
          toolCallId: 'call-abc',
          toolName: 'read_file',
        },
      ],
    });
    const body = capturedBody as {
      messages: Array<{
        role: string;
        content: string;
        tool_call_id?: string;
        name?: string;
      }>;
    } | null;
    expect(body).not.toBeNull();
    const toolMsg = body?.messages[2];
    expect(toolMsg?.role).toBe('tool');
    expect(toolMsg?.tool_call_id).toBe('call-abc');
    expect(toolMsg?.name).toBe('read_file');
  });
});
