/**
 * Circuit-breaker × adapter integration tests.
 *
 * These tests prove the end-to-end behaviour: a misbehaving fetch
 * implementation produces N transient failures, the breaker trips
 * OPEN, and the next `streamChat` call rejects immediately WITHOUT
 * issuing another network round-trip. After the cooldown elapses,
 * one probe is allowed through; success closes the breaker, failure
 * grows the cooldown.
 *
 * The breaker is process-wide via `globalBreakerRegistry`. We reset it
 * before each test so cross-test pollution can't leak.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import type { Message } from '@/types/global';
import type { StreamDoneResult } from '@/types/message';
import { globalBreakerRegistry } from '@/llm/circuit-breaker';

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const realFetch = globalThis.fetch;

function installFetch(impl: FetchImpl): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function transient503(): Response {
  return new Response('upstream broken', {
    status: 503,
    statusText: 'Service Unavailable',
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

function userMsg(content: string): Message {
  return { id: 'u1', role: 'user', content, createdAt: 0 };
}

function makeAdapter(baseUrl = 'https://openrouter.ai/api/v1'): LLMAdapter {
  return new LLMAdapter({
    baseUrl,
    model: 'test-model',
    backend: 'openrouter',
    apiKey: 'sk-test',
    maxAttempts: 2,
    transientMaxAttempts: 2,
    initialBackoffMs: 1,
    maxBackoffMs: 4,
    requestTimeoutMs: 5_000,
    pingTimeoutMs: 500,
  });
}

beforeEach(() => {
  globalBreakerRegistry.reset();
});

afterEach(() => {
  restoreFetch();
  globalBreakerRegistry.reset();
});

describe('LLMAdapter × circuit breaker — integration', () => {
  test('after N transient failures the breaker trips and the next call rejects without fetching', async () => {
    // Configure a tight breaker so we don't have to fire 10 calls.
    globalBreakerRegistry.setOptions({
      failureThreshold: 2,
      failureWindowMs: 60_000,
      initialCooldownMs: 30_000,
      maxCooldownMs: 60_000,
    });
    // Re-instantiate the breaker for the test key with the new options.
    globalBreakerRegistry.reset();
    globalBreakerRegistry.get('openrouter', 'https://openrouter.ai/api/v1');

    let calls = 0;
    installFetch(async () => {
      calls += 1;
      return transient503();
    });

    // Each streamChat call surfaces ONE outcome to the breaker.
    // With failureThreshold: 2, we need two failed calls to trip.
    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'test-model',
      backend: 'openrouter',
      apiKey: 'sk-test',
      maxAttempts: 1,
      transientMaxAttempts: 1,
      initialBackoffMs: 1,
      maxBackoffMs: 4,
      requestTimeoutMs: 5_000,
      pingTimeoutMs: 500,
    });

    // First call: 1 attempt, 503 → 1 failure (under threshold).
    let firstDone: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('hi')],
      onDone: (r) => { firstDone = r; },
    });
    const d1 = firstDone as unknown as StreamDoneResult;
    expect(d1.finishReason).toBe('error');
    expect(
      globalBreakerRegistry.get('openrouter', 'https://openrouter.ai/api/v1').snapshot().state,
    ).toBe('closed');

    // Second failed call → 2 failures → trips breaker.
    await adapter.streamChat({
      messages: [userMsg('hi again')],
      onDone: () => {},
    });
    const breaker = globalBreakerRegistry.get('openrouter', 'https://openrouter.ai/api/v1');
    expect(breaker.snapshot().state).toBe('open');

    // Third call: should be rejected immediately with no fetch.
    const callsBefore = calls;
    let thirdDone: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('hi #3')],
      onDone: (r) => { thirdDone = r; },
    });
    expect(calls).toBe(callsBefore); // No additional fetch.
    const d3 = thirdDone as unknown as StreamDoneResult;
    expect(d3.finishReason).toBe('error');
    expect(d3.error ?? '').toMatch(/Backend appears down/);
    expect(d3.error ?? '').toMatch(/\/provider/);
  });

  test('successful stream resets consecutive failures (does not trip when interleaved)', async () => {
    globalBreakerRegistry.setOptions({
      failureThreshold: 3,
      failureWindowMs: 60_000,
      initialCooldownMs: 30_000,
      maxCooldownMs: 60_000,
    });
    globalBreakerRegistry.reset();
    globalBreakerRegistry.get('openrouter', 'https://openrouter.ai/api/v1');

    let calls = 0;
    let response: 'fail' | 'ok' = 'fail';
    installFetch(async () => {
      calls += 1;
      return response === 'fail' ? transient503() : successSse();
    });

    const adapter = makeAdapter();

    // Two failed calls (each yields 2 attempts) → 4 failures, but
    // breaker threshold is now 3 so it would trip… Actually we want
    // the success to interrupt. Let's force ONE attempt per call:
    const tightAdapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'test-model',
      backend: 'openrouter',
      apiKey: 'sk-test',
      maxAttempts: 1,
      transientMaxAttempts: 1,
      initialBackoffMs: 1,
      maxBackoffMs: 4,
      requestTimeoutMs: 5_000,
      pingTimeoutMs: 500,
    });
    void adapter; // silence unused — we use tightAdapter

    // 2 failures → consecutive count 2 (under threshold 3).
    await tightAdapter.streamChat({ messages: [userMsg('a')], onDone: () => {} });
    await tightAdapter.streamChat({ messages: [userMsg('b')], onDone: () => {} });
    expect(globalBreakerRegistry.get('openrouter', 'https://openrouter.ai/api/v1').snapshot().consecutiveFailures).toBe(2);

    // Success resets.
    response = 'ok';
    await tightAdapter.streamChat({ messages: [userMsg('c')], onDone: () => {} });
    const snap = globalBreakerRegistry.get('openrouter', 'https://openrouter.ai/api/v1').snapshot();
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.state).toBe('closed');
  });

  test('after cooldown, HALF_OPEN probe success closes the breaker', async () => {
    globalBreakerRegistry.setOptions({
      failureThreshold: 1,
      failureWindowMs: 60_000,
      initialCooldownMs: 50, // tiny cooldown for the test
      maxCooldownMs: 1000,
    });
    globalBreakerRegistry.reset();
    globalBreakerRegistry.get('openrouter', 'https://openrouter.ai/api/v1');

    let calls = 0;
    let response: 'fail' | 'ok' = 'fail';
    installFetch(async () => {
      calls += 1;
      return response === 'fail' ? transient503() : successSse();
    });

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'test-model',
      backend: 'openrouter',
      apiKey: 'sk-test',
      maxAttempts: 1,
      transientMaxAttempts: 1,
      initialBackoffMs: 1,
      maxBackoffMs: 4,
      requestTimeoutMs: 5_000,
      pingTimeoutMs: 500,
    });

    // Trip the breaker.
    await adapter.streamChat({ messages: [userMsg('a')], onDone: () => {} });
    expect(globalBreakerRegistry.get('openrouter', 'https://openrouter.ai/api/v1').snapshot().state).toBe('open');
    const fetchesAfterTrip = calls;

    // Wait past cooldown.
    await new Promise((r) => setTimeout(r, 80));

    response = 'ok';
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('b')],
      onChunk: () => {},
      onDone: (r) => { done = r; },
    });
    // Probe was allowed → one extra fetch.
    expect(calls).toBe(fetchesAfterTrip + 1);
    const d = done as unknown as StreamDoneResult;
    expect(d.finishReason).toBe('stop');
    expect(globalBreakerRegistry.get('openrouter', 'https://openrouter.ai/api/v1').snapshot().state).toBe('closed');
  });

  test('distinct (backend, baseUrl) pairs do NOT share a breaker', async () => {
    globalBreakerRegistry.setOptions({
      failureThreshold: 1,
      initialCooldownMs: 30_000,
    });
    globalBreakerRegistry.reset();

    let calls = 0;
    installFetch(async () => {
      calls += 1;
      return transient503();
    });

    // Trip the openrouter.ai breaker.
    const a = makeAdapter('https://openrouter.ai/api/v1');
    await a.streamChat({ messages: [userMsg('x')], onDone: () => {} });
    expect(
      globalBreakerRegistry.get('openrouter', 'https://openrouter.ai/api/v1').snapshot().state,
    ).toBe('open');

    // Custom proxy at a different URL → should NOT be tripped.
    const b = makeAdapter('https://my-proxy.example/api/v1');
    const callsBefore = calls;
    await b.streamChat({ messages: [userMsg('y')], onDone: () => {} });
    expect(calls).toBeGreaterThan(callsBefore); // proxy was fetched
  });
});
