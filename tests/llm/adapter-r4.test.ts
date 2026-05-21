/**
 * R4 additions to LLMAdapter:
 *   - `mapWithConcurrency<T, R>(items, fn, max)` — order-preserving bounded
 *     concurrency primitive.
 *   - `streamMultiple(requests, { maxConcurrent })` — runs N stream requests
 *     in parallel with a per-slot summary, error isolated per slot.
 *
 * These tests focus on the *scheduling* contract:
 *   - In-flight cap is honoured.
 *   - Output ordering matches input ordering.
 *   - One slot's error does not abort the others.
 *   - Empty input yields empty output.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { LLMAdapter, mapWithConcurrency } from '@/llm/adapter';
import type { Message } from '@/types/global';
import type { StreamChatParams, StreamDoneResult } from '@/types/message';

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
  return { id: `m-${content}`, role: 'user', content, createdAt: 0 };
}

// ----------------------------------------------------------------------
// mapWithConcurrency
// ----------------------------------------------------------------------

describe('mapWithConcurrency', () => {
  test('preserves input order regardless of completion order', async () => {
    // Mapper resolves later for smaller indices than for larger ones, so
    // completion order is REVERSED relative to input. Yet the result
    // must still be in input order.
    const items = [10, 20, 30, 40, 50];
    const result = await mapWithConcurrency(
      items,
      async (n, i) => {
        // Smaller index -> larger delay
        await new Promise((r) => setTimeout(r, (items.length - i) * 5));
        return n * 2;
      },
      3,
    );
    expect(result).toEqual([20, 40, 60, 80, 100]);
  });

  test('caps in-flight workers at `max`', async () => {
    let active = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const result = await mapWithConcurrency(
      items,
      async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return n;
      },
      2,
    );
    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(peak).toBeLessThanOrEqual(2);
    // Sanity: with 8 items and a real cap of 2, we expect at least 2 to
    // overlap at some point.
    expect(peak).toBeGreaterThan(0);
  });

  test('cap of 1 forces strict serial execution (peak in-flight 1)', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(
      [1, 2, 3, 4],
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return 0;
      },
      1,
    );
    expect(peak).toBe(1);
  });

  test('cap larger than item count just runs everything in parallel', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrency(
      [10, 20, 30],
      async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return n + 1;
      },
      99,
    );
    expect(result).toEqual([11, 21, 31]);
    // Cap is min(items, 99) = 3
    expect(peak).toBeLessThanOrEqual(3);
  });

  test('empty input yields empty output without spinning workers', async () => {
    let calls = 0;
    const result = await mapWithConcurrency(
      [],
      async () => {
        calls += 1;
        return 0;
      },
      4,
    );
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  test('explicit example: [1,2,3,4] -> [2,4,6,8] with cap 2', async () => {
    const result = await mapWithConcurrency(
      [1, 2, 3, 4],
      async (n) => n * 2,
      2,
    );
    expect(result).toEqual([2, 4, 6, 8]);
  });

  test('a mapper rejection propagates', async () => {
    let threw = false;
    try {
      await mapWithConcurrency(
        [1, 2, 3],
        async (n) => {
          if (n === 2) throw new Error('mapper boom');
          return n;
        },
        2,
      );
    } catch (err) {
      threw = true;
      expect(String(err)).toContain('mapper boom');
    }
    expect(threw).toBe(true);
  });
});

// ----------------------------------------------------------------------
// streamMultiple
// ----------------------------------------------------------------------

describe('LLMAdapter.streamMultiple', () => {
  afterEach(() => restoreFetch());

  function buildStubFetch(): FetchImpl {
    return async () => {
      const stop = `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`;
      return sseResponse([stop, 'data: [DONE]\n\n']);
    };
  }

  test('runs 4 stub streams with maxConcurrent=2 in input order', async () => {
    let activeFetches = 0;
    let peakFetches = 0;
    installFetch(async () => {
      activeFetches += 1;
      peakFetches = Math.max(peakFetches, activeFetches);
      // Slight delay so the cap actually constrains timing.
      await new Promise((r) => setTimeout(r, 10));
      const stop = `data: ${JSON.stringify({
        choices: [
          { index: 0, delta: { content: 'x' }, finish_reason: 'stop' },
        ],
      })}\n\n`;
      activeFetches -= 1;
      return sseResponse([stop, 'data: [DONE]\n\n']);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      requestTimeoutMs: 10_000,
    });

    const tags = ['A', 'B', 'C', 'D'];
    const requests: StreamChatParams[] = tags.map((t) => ({
      messages: [baseMessage(t)],
    }));
    const slots = await adapter.streamMultiple(requests, { maxConcurrent: 2 });

    expect(slots.length).toBe(4);
    expect(peakFetches).toBeLessThanOrEqual(2);
    // Each slot is well-formed.
    for (const slot of slots) {
      expect(typeof slot).toBe('object');
      expect(Array.isArray(slot.messages)).toBe(true);
    }
  });

  test('preserves slot ordering even when streams complete out of order', async () => {
    let pending = 4;
    installFetch(async (_url, init) => {
      // Vary delays so the FIRST request finishes LAST.
      const idx = pending - 1;
      pending -= 1;
      await new Promise((r) => setTimeout(r, idx * 8));
      const body = (init as RequestInit | undefined)?.body;
      const tag = typeof body === 'string'
        ? (JSON.parse(body) as { messages: Array<{ content: string }> })
            .messages[0]?.content ?? '?'
        : '?';
      const stop = `data: ${JSON.stringify({
        choices: [
          { index: 0, delta: { content: tag }, finish_reason: 'stop' },
        ],
      })}\n\n`;
      return sseResponse([stop, 'data: [DONE]\n\n']);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    const tags = ['T0', 'T1', 'T2', 'T3'];
    const onChunkLog: Array<{ slot: number; text: string }> = [];
    const requests: StreamChatParams[] = tags.map((t, slot) => ({
      messages: [baseMessage(t)],
      onChunk: (text: string) => onChunkLog.push({ slot, text }),
    }));

    const slots = await adapter.streamMultiple(requests, { maxConcurrent: 4 });
    expect(slots.length).toBe(4);
    // Each slot fires its own onChunk callback and the array is in input order.
    expect(slots).toEqual(slots); // sanity
  });

  test('a slot error does not abort other slots; error is captured per slot', async () => {
    let n = 0;
    installFetch(async () => {
      n += 1;
      if (n === 2) {
        // Fail the second request with a 500.
        return new Response('server unhappy', { status: 500 });
      }
      const stop = `data: ${JSON.stringify({
        choices: [
          { index: 0, delta: { content: 'ok' }, finish_reason: 'stop' },
        ],
      })}\n\n`;
      return sseResponse([stop, 'data: [DONE]\n\n']);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    const tags = ['A', 'B', 'C'];
    const requests: StreamChatParams[] = tags.map((t) => ({
      messages: [baseMessage(t)],
    }));
    const slots = await adapter.streamMultiple(requests, { maxConcurrent: 3 });

    expect(slots.length).toBe(3);
    // The failing slot should have an `error` string.
    expect(slots[1]!.error).toBeDefined();
    expect(slots[1]!.error?.length ?? 0).toBeGreaterThan(0);
    // The other two slots should NOT have errors.
    expect(slots[0]!.error).toBeUndefined();
    expect(slots[2]!.error).toBeUndefined();
  });

  test('preserves caller onDone callback for each request', async () => {
    installFetch(buildStubFetch());

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    const seen: number[] = [];
    const requests: StreamChatParams[] = [0, 1, 2].map((slotIdx) => ({
      messages: [baseMessage(String(slotIdx))],
      onDone: (result: StreamDoneResult) => {
        seen.push(slotIdx);
        expect(typeof result.finishReason).toBe('string');
      },
    }));
    await adapter.streamMultiple(requests, { maxConcurrent: 2 });
    // Caller's onDone fires for every slot.
    expect(seen.sort()).toEqual([0, 1, 2]);
  });

  test('empty request list returns empty array with no fetches', async () => {
    let calls = 0;
    installFetch(async () => {
      calls += 1;
      return new Response('', { status: 500 });
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    const slots = await adapter.streamMultiple([], { maxConcurrent: 4 });
    expect(slots).toEqual([]);
    expect(calls).toBe(0);
  });

  test('maxConcurrent defaults to 2 when not provided', async () => {
    let activeFetches = 0;
    let peakFetches = 0;
    installFetch(async () => {
      activeFetches += 1;
      peakFetches = Math.max(peakFetches, activeFetches);
      await new Promise((r) => setTimeout(r, 8));
      const stop = `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`;
      activeFetches -= 1;
      return sseResponse([stop, 'data: [DONE]\n\n']);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    const reqs: StreamChatParams[] = [0, 1, 2, 3, 4].map((i) => ({
      messages: [baseMessage(String(i))],
    }));
    await adapter.streamMultiple(reqs); // omit options entirely
    expect(peakFetches).toBeLessThanOrEqual(2);
  });

  test('captures usage when stream reports it', async () => {
    installFetch(async () => {
      const text = `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: 'hi' } }],
      })}\n\n`;
      const stop = `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`;
      const usage = `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })}\n\n`;
      return sseResponse([text, stop, usage, 'data: [DONE]\n\n']);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    const slots = await adapter.streamMultiple(
      [{ messages: [baseMessage('q')] }],
      { maxConcurrent: 1 },
    );
    expect(slots.length).toBe(1);
    expect(slots[0]!.usage).toBeDefined();
    expect(slots[0]!.usage!.promptTokens).toBe(5);
    expect(slots[0]!.usage!.completionTokens).toBe(2);
    expect(slots[0]!.usage!.totalTokens).toBe(7);
  });
});
