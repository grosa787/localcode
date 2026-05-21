/**
 * Per-backend retry budget — Fix 1.
 *
 * OpenRouter wraps upstream provider blips as a transient `HttpError`
 * (400 "Provider returned error"). The adapter's transient-attempt
 * budget is widened to 6 (vs 3 for the regular budget) so a brief
 * upstream outage doesn't fail the whole turn.
 *
 * Coverage:
 *   - OpenRouter transient errors get retried up to 6 times before
 *     giving up — 6× transient + 1× ok succeeds.
 *   - Other backends (OpenAI, LM Studio) keep the legacy 3-attempt cap
 *     so we don't accidentally turn every transient retry into a
 *     minute-long stall on local providers.
 *   - The friendly "failed after N retries over Ns" error message is
 *     surfaced once the budget is exhausted.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import type { Backend } from '@/types/global';
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

function transientResponse(): Response {
  // Body shape that the adapter recognises as a transient OpenRouter
  // upstream wrap → HttpError(transient: true).
  return new Response('Provider returned error', {
    status: 400,
    statusText: 'Bad Request',
    headers: { 'content-type': 'text/plain' },
  });
}

function successSse(): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
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

function makeAdapter(opts: {
  backend: Backend;
  maxAttempts?: number;
  transientMaxAttempts?: number;
}): LLMAdapter {
  return new LLMAdapter({
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'test-model',
    backend: opts.backend,
    apiKey: 'sk-test',
    maxAttempts: opts.maxAttempts ?? 3,
    ...(opts.transientMaxAttempts !== undefined
      ? { transientMaxAttempts: opts.transientMaxAttempts }
      : {}),
    initialBackoffMs: 1,
    maxBackoffMs: 4,
    requestTimeoutMs: 5_000,
    pingTimeoutMs: 500,
  });
}

afterEach(() => restoreFetch());

describe('LLMAdapter — per-backend retry budget', () => {
  test('OpenRouter retries transient errors up to 6 attempts then succeeds', async () => {
    let calls = 0;
    installFetch(async () => {
      calls += 1;
      // 5 transient failures + 1 success = 6 total attempts (the cap).
      if (calls <= 5) return transientResponse();
      return successSse();
    });

    const adapter = makeAdapter({ backend: 'openrouter' });
    const chunks: string[] = [];
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onChunk: (t) => chunks.push(t),
      onDone: (r) => { done = r; },
    });
    expect(calls).toBe(6);
    expect(chunks).toEqual(['ok']);
    const d = done as unknown as StreamDoneResult;
    expect(d.error).toBeUndefined();
    expect(d.finishReason).toBe('stop');
  }, 10_000);

  test('Default transient budget is 3 for OpenAI (no widening)', async () => {
    let calls = 0;
    installFetch(async () => {
      calls += 1;
      // OpenAI 5xx is also transient, exercises the same path without
      // OpenRouter-specific 400 wrap.
      return new Response('upstream broken', { status: 503 });
    });

    const adapter = makeAdapter({ backend: 'openai' });
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: (r) => { done = r; },
    });
    // maxAttempts === transientMaxAttempts === 3 for non-OpenRouter
    // backends, so we should see exactly 3 attempts.
    expect(calls).toBe(3);
    const d = done as unknown as StreamDoneResult;
    expect(d.finishReason).toBe('error');
  }, 10_000);

  test('Friendly exhausted error names the attempt count', async () => {
    let calls = 0;
    installFetch(async () => {
      calls += 1;
      return transientResponse();
    });
    const adapter = makeAdapter({ backend: 'openrouter' });
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onDone: (r) => { done = r; },
    });
    expect(calls).toBe(6);
    const d = done as unknown as StreamDoneResult;
    expect(d.finishReason).toBe('error');
    expect(d.error ?? '').toMatch(/Failed after 6 retries/);
    expect(d.error ?? '').toMatch(/upstream provider is sustained-down/);
  }, 15_000);

  test('onRetryAttempt callback fires before each retry sleep', async () => {
    let calls = 0;
    installFetch(async () => {
      calls += 1;
      if (calls <= 2) return transientResponse();
      return successSse();
    });
    const adapter = makeAdapter({ backend: 'openrouter' });
    const retries: Array<{ attempt: number; maxAttempts: number; nextDelayMs: number }> = [];
    await adapter.streamChat({
      messages: [baseMessage('hi')],
      onRetryAttempt: (info) => {
        retries.push({
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          nextDelayMs: info.nextDelayMs,
        });
      },
    });
    expect(retries.length).toBe(2);
    expect(retries[0]?.attempt).toBe(1);
    expect(retries[1]?.attempt).toBe(2);
    expect(retries[0]?.maxAttempts).toBe(6);
    expect(retries[0]?.nextDelayMs).toBeGreaterThan(0);
  }, 10_000);
});
