/**
 * R30 — OpenRouter dial-up timing instrumentation tests.
 *
 * Verifies the timing breakdown attached to failure dumps when
 * `dumpFailedRequests=true` and the OpenRouter backend produces a
 * non-2xx response. The adapter measures three phases via
 * `performance.now()`:
 *
 *   - `connectMs`     — request start → response headers received
 *   - `firstByteMs`   — response headers → first SSE `data` chunk
 *   - `totalMs`       — request start → done event
 *
 * These tests deliberately use a mocked `captureFailure` rather than a
 * real disk write so the suite never touches `~/.localcode/diagnostics/`.
 *
 * Also verifies that:
 *   - Outbound requests carry an explicit `Connection: keep-alive`
 *     header (R30: even though Bun's fetch pools by default, the
 *     explicit header prevents a misbehaving proxy from forcing
 *     close). The header sits in `buildRequestHeaders` so it travels
 *     on every chat completion AND the failure-dump capture too.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { FailureDump } from '@/llm/diagnostics';

// `mock.module` must run BEFORE the module under test is imported.
// We collect every `captureFailure` invocation here so individual
// tests can assert on the timing payload.
const captured: FailureDump[] = [];

// Replace `@/llm/diagnostics` so the adapter's `captureFailure` calls
// are intercepted. Returning a resolved Promise keeps the adapter's
// fire-and-forget `.catch(() => {})` chain happy.
mock.module('@/llm/diagnostics', () => ({
  captureFailure: async (d: FailureDump): Promise<string> => {
    captured.push(d);
    return '/dev/null/dump.json';
  },
}));

// Import AFTER the mock is installed so the adapter binds against
// the replacement.
const { LLMAdapter } = await import('@/llm/adapter');
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

function userMsg(content: string): Message {
  return { id: 'u-1', role: 'user', content, createdAt: 0 };
}

/**
 * SSE response generator that yields `frames` with a configurable
 * delay BEFORE the first frame. Used to simulate "headers arrive,
 * but the first SSE chunk is delayed" — the gap exercises the
 * `firstByteMs` measurement.
 */
function delayedSseResponse(
  frames: string[],
  firstFrameDelayMs: number,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (firstFrameDelayMs > 0) {
        await new Promise((r) => setTimeout(r, firstFrameDelayMs));
      }
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
  return [
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'ok' } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  restoreFetch();
});

describe('OpenRouter timing instrumentation (R30)', () => {
  test('failure dump includes connectMs, firstByteMs, totalMs on 4xx response', async () => {
    // Synthesise a 400 from OpenRouter to exercise the first dump path
    // (response.ok === false). We add a brief delay before the response
    // resolves so connectMs is unambiguously > 0.
    installFetch(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Response('{"error":{"message":"bad model"}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    });

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      backend: 'openrouter',
      apiKey: 'or-test-key',
      maxAttempts: 1,
      transientMaxAttempts: 1,
      initialBackoffMs: 0,
      requestTimeoutMs: 5_000,
      dumpFailedRequests: true,
    });

    let resolved = false;
    await adapter.streamChat({
      messages: [userMsg('hi')],
      onChunk: () => {},
      onDone: () => {
        resolved = true;
      },
    });
    expect(resolved).toBe(true);

    // Wait one microtask tick so the fire-and-forget capture lands.
    await new Promise((r) => setTimeout(r, 5));

    expect(captured.length).toBe(1);
    const dump = captured[0];
    expect(dump).toBeDefined();
    expect(dump?.timing).toBeDefined();
    const t = dump?.timing;
    expect(typeof t?.connectMs).toBe('number');
    expect(typeof t?.totalMs).toBe('number');
    // connectMs measured a real delay; sanity check it's non-negative.
    expect((t?.connectMs ?? -1) >= 0).toBe(true);
    // totalMs >= connectMs (totalMs covers the whole attempt).
    expect((t?.totalMs ?? 0) >= (t?.connectMs ?? 0)).toBe(true);
    // No SSE chunk arrived (we 400'd) → firstByteMs is omitted.
    expect(t?.firstByteMs).toBeUndefined();
  });

  test('mid-stream failure dump includes firstByteMs after a real SSE byte', async () => {
    // 200 OK with a body that yields one chunk then errors out by
    // closing without [DONE] / finish_reason. The mid-stream catch
    // path captures another dump — this time `firstByteMs` should
    // be populated because at least one SSE `data` frame arrived.
    //
    // We force the path by returning a 200 OK + a body that throws
    // mid-stream; the adapter's `runStreamOnce` flags this as
    // `emptyStream` rather than throwing, so to actually exercise
    // the mid-stream catch we wire the body to surface an error.
    installFetch(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await new Promise((r) => setTimeout(r, 10));
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content: 'partial' } }],
              })}\n\n`,
            ),
          );
          // Wait briefly so firstByteMs is observable, then explode.
          await new Promise((r) => setTimeout(r, 10));
          controller.error(new Error('upstream provider crashed'));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      backend: 'openrouter',
      apiKey: 'or-test-key',
      maxAttempts: 1,
      transientMaxAttempts: 1,
      initialBackoffMs: 0,
      requestTimeoutMs: 5_000,
      dumpFailedRequests: true,
    });

    await adapter.streamChat({
      messages: [userMsg('hi')],
      onChunk: () => {},
      onDone: () => {},
    });

    await new Promise((r) => setTimeout(r, 5));

    // At least one mid-stream dump landed.
    expect(captured.length >= 1).toBe(true);
    const dump = captured[captured.length - 1];
    expect(dump?.timing).toBeDefined();
    const t = dump?.timing;
    expect(typeof t?.connectMs).toBe('number');
    expect(typeof t?.firstByteMs).toBe('number');
    expect(typeof t?.totalMs).toBe('number');
    expect((t?.firstByteMs ?? -1) >= 0).toBe(true);
  });

  test('Connection: keep-alive header is sent on every chat completion request', async () => {
    let observedHeaders: Record<string, string> | null = null;
    installFetch(async (_url, init) => {
      const h = init?.headers;
      if (h !== null && typeof h === 'object' && !Array.isArray(h)) {
        observedHeaders = h as Record<string, string>;
      }
      return delayedSseResponse(basicTextThenStop(), 0);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      backend: 'openrouter',
      apiKey: 'or-test-key',
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
    });

    await adapter.streamChat({
      messages: [userMsg('hi')],
      onChunk: () => {},
      onDone: () => {},
    });

    expect(observedHeaders).not.toBeNull();
    // Header keys are case-sensitive in our internal map but most
    // servers fold to lowercase on the wire; assert on the casing
    // we set in `buildRequestHeaders`.
    const headers = observedHeaders as unknown as Record<string, string>;
    expect(headers.Connection).toBe('keep-alive');
  });

  test('Connection: keep-alive also rides the dump payload', async () => {
    installFetch(async () => {
      return new Response('boom', { status: 500 });
    });

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      backend: 'openrouter',
      apiKey: 'or-test-key',
      // 500 is classified as transient → without overriding the
      // transient budget, OpenRouter would retry up to 6 times with
      // a 2s/4s/... ladder and the test would time out. Pin both
      // attempt caps to 1 so we capture exactly one dump and exit.
      maxAttempts: 1,
      transientMaxAttempts: 1,
      initialBackoffMs: 0,
      requestTimeoutMs: 5_000,
      dumpFailedRequests: true,
    });

    await adapter.streamChat({
      messages: [userMsg('hi')],
      onChunk: () => {},
      onDone: () => {},
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(captured.length >= 1).toBe(true);
    const dump = captured[0];
    expect(dump?.requestHeaders.Connection).toBe('keep-alive');
    // Authorization stays raw on the way IN (sanitization happens inside
    // the real `captureFailure`; our mock receives the un-redacted shape).
    expect(dump?.requestHeaders.Authorization).toBe('Bearer or-test-key');
  });

  test('totalMs grows monotonically across the attempt — never negative', async () => {
    // Sanity check against `performance.now()` skew: `totalMs` is
    // measured inside `buildTiming()` at the moment of dump capture;
    // it should always be non-negative and >= connectMs.
    installFetch(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return new Response('{"error":{"message":"x"}}', { status: 400 });
    });

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      backend: 'openrouter',
      apiKey: 'or-test-key',
      maxAttempts: 1,
      transientMaxAttempts: 1,
      initialBackoffMs: 0,
      requestTimeoutMs: 5_000,
      dumpFailedRequests: true,
    });

    await adapter.streamChat({
      messages: [userMsg('hi')],
      onChunk: () => {},
      onDone: () => {},
    });

    await new Promise((r) => setTimeout(r, 5));
    const dump = captured[0];
    const t = dump?.timing;
    expect(t).toBeDefined();
    expect((t?.totalMs ?? -1) >= 0).toBe(true);
    expect((t?.connectMs ?? -1) >= 0).toBe(true);
    expect((t?.totalMs ?? 0) >= (t?.connectMs ?? 0)).toBe(true);
  });
});
