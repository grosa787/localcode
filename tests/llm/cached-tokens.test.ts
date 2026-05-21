/**
 * Cached-tokens extraction across providers.
 *
 * Verifies that the LLMAdapter (OpenAI / OpenRouter shape) and the
 * AnthropicAdapter both populate `StreamUsage.cachedInputTokens` and
 * the derived `freshInputTokens` field when the provider reports a
 * prefix-cache hit. Local providers (Ollama / LM Studio) leave the
 * fields undefined — that's covered too.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import { AnthropicAdapter } from '@/llm/adapter-anthropic';
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

function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function userMsg(text: string): Message {
  return { id: 'u1', role: 'user', content: text, createdAt: 0 };
}

// ---------- OpenAI / OpenRouter shape ----------

describe('LLMAdapter — cached-tokens parsing (OpenAI / OpenRouter)', () => {
  afterEach(() => restoreFetch());

  test('extracts prompt_tokens_details.cached_tokens and computes freshInputTokens', async () => {
    const frame1 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'hi' } }],
    })}\n\n`;
    const frame2 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 25,
        total_tokens: 1025,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    })}\n\n`;
    const frame3 = 'data: [DONE]\n\n';
    installFetch(async () => sseResponse([frame1, frame2, frame3]));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'gpt-4o',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      requestTimeoutMs: 2_000,
      pingTimeoutMs: 500,
    });

    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('hello')],
      onDone: (r) => {
        done = r;
      },
    });
    expect(done).not.toBeNull();
    const usage = (done as unknown as StreamDoneResult).usage;
    expect(usage).toBeDefined();
    expect(usage?.promptTokens).toBe(1000);
    expect(usage?.completionTokens).toBe(25);
    expect(usage?.cachedInputTokens).toBe(800);
    expect(usage?.freshInputTokens).toBe(200);
  });

  test('omits cached fields when provider returns no cache info (local)', async () => {
    const frame1 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'hi' } }],
    })}\n\n`;
    const frame2 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
      },
    })}\n\n`;
    const frame3 = 'data: [DONE]\n\n';
    installFetch(async () => sseResponse([frame1, frame2, frame3]));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      requestTimeoutMs: 2_000,
      pingTimeoutMs: 500,
    });

    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('hello')],
      onDone: (r) => {
        done = r;
      },
    });
    const usage = (done as unknown as StreamDoneResult).usage;
    expect(usage?.cachedInputTokens).toBeUndefined();
    expect(usage?.freshInputTokens).toBeUndefined();
  });

  test('extracts DeepSeek prompt_cache_hit_tokens + prompt_cache_miss_tokens', async () => {
    // DeepSeek pairs prompt_cache_hit_tokens with prompt_cache_miss_tokens.
    // freshInputTokens should come directly from the miss field, not be
    // derived by subtraction.
    const frame1 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'hi' } }],
    })}\n\n`;
    const frame2 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
      },
    })}\n\n`;
    const frame3 = 'data: [DONE]\n\n';
    installFetch(async () => sseResponse([frame1, frame2, frame3]));

    const adapter = new LLMAdapter({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      backend: 'custom',
      apiKey: 'sk-test',
      maxAttempts: 1,
      initialBackoffMs: 1,
      requestTimeoutMs: 2_000,
      pingTimeoutMs: 500,
    });

    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('hello')],
      onDone: (r) => {
        done = r;
      },
    });
    const usage = (done as unknown as StreamDoneResult).usage;
    expect(usage?.promptTokens).toBe(1000);
    expect(usage?.completionTokens).toBe(50);
    expect(usage?.cachedInputTokens).toBe(800);
    expect(usage?.freshInputTokens).toBe(200);
  });

  test('GLM-style prompt_cache_hit_tokens without miss field derives fresh from prompt_tokens', async () => {
    // GLM (Zhipu) reports only prompt_cache_hit_tokens (no miss pair).
    // freshInputTokens must be derived from prompt_tokens - cachedInputTokens.
    const frame1 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'hi' } }],
    })}\n\n`;
    const frame2 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1500,
        completion_tokens: 30,
        total_tokens: 1530,
        prompt_cache_hit_tokens: 1200,
      },
    })}\n\n`;
    const frame3 = 'data: [DONE]\n\n';
    installFetch(async () => sseResponse([frame1, frame2, frame3]));

    const adapter = new LLMAdapter({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4',
      backend: 'custom',
      apiKey: 'sk-test',
      maxAttempts: 1,
      initialBackoffMs: 1,
      requestTimeoutMs: 2_000,
      pingTimeoutMs: 500,
    });

    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('hello')],
      onDone: (r) => {
        done = r;
      },
    });
    const usage = (done as unknown as StreamDoneResult).usage;
    expect(usage?.promptTokens).toBe(1500);
    expect(usage?.cachedInputTokens).toBe(1200);
    expect(usage?.freshInputTokens).toBe(300);
  });

  test('OpenRouter unified usage.cached_tokens (no nested details) parses correctly', async () => {
    // Some OpenRouter responses normalise upstream cache info into a
    // flat top-level `cached_tokens` field. Verify the fallback path.
    const frame1 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'hi' } }],
    })}\n\n`;
    const frame2 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 800,
        completion_tokens: 40,
        total_tokens: 840,
        cached_tokens: 500,
      },
    })}\n\n`;
    const frame3 = 'data: [DONE]\n\n';
    installFetch(async () => sseResponse([frame1, frame2, frame3]));

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'meta-llama/llama-3.3-70b-instruct',
      backend: 'openrouter',
      apiKey: 'sk-or-test',
      maxAttempts: 1,
      initialBackoffMs: 1,
      requestTimeoutMs: 2_000,
      pingTimeoutMs: 500,
    });

    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('hello')],
      onDone: (r) => {
        done = r;
      },
    });
    const usage = (done as unknown as StreamDoneResult).usage;
    expect(usage?.promptTokens).toBe(800);
    expect(usage?.cachedInputTokens).toBe(500);
    expect(usage?.freshInputTokens).toBe(300);
  });

  test('priority: prompt_tokens_details wins over prompt_cache_hit_tokens (OpenAI > DeepSeek)', async () => {
    // Pathological case where a response carries BOTH OpenAI-style nested
    // details AND DeepSeek-style flat fields. Detection priority must
    // pick the OpenAI shape first.
    const frame1 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'hi' } }],
    })}\n\n`;
    const frame2 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 60,
        total_tokens: 2060,
        prompt_tokens_details: { cached_tokens: 1500 },
        prompt_cache_hit_tokens: 999,
        prompt_cache_miss_tokens: 1001,
      },
    })}\n\n`;
    const frame3 = 'data: [DONE]\n\n';
    installFetch(async () => sseResponse([frame1, frame2, frame3]));

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'gpt-4o',
      backend: 'openrouter',
      apiKey: 'sk-or-test',
      maxAttempts: 1,
      initialBackoffMs: 1,
      requestTimeoutMs: 2_000,
      pingTimeoutMs: 500,
    });

    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('hello')],
      onDone: (r) => {
        done = r;
      },
    });
    const usage = (done as unknown as StreamDoneResult).usage;
    // OpenAI nested wins for cached.
    expect(usage?.cachedInputTokens).toBe(1500);
    // miss field still wins for fresh because we read it independently
    // (it's a separate signal). Document the behaviour: when OpenAI
    // shape is selected, miss tokens (DeepSeek-only) are still consumed
    // when present — this is intentional, the miss field ALWAYS wins
    // over derivation if it's there.
    expect(usage?.freshInputTokens).toBe(1001);
  });

  test('garbage cache fields (negative / NaN / non-numeric) are skipped silently', async () => {
    // Defensive parse: malformed cache values must not corrupt the
    // usage block. cachedInputTokens should remain undefined rather
    // than carry through the negative.
    const frame1 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'hi' } }],
    })}\n\n`;
    const frame2 = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 500,
        completion_tokens: 20,
        total_tokens: 520,
        prompt_cache_hit_tokens: -1,
        cached_tokens: 'oops',
        prompt_tokens_details: { cached_tokens: null },
      },
    })}\n\n`;
    const frame3 = 'data: [DONE]\n\n';
    installFetch(async () => sseResponse([frame1, frame2, frame3]));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'glm',
      backend: 'custom',
      apiKey: 'sk-test',
      maxAttempts: 1,
      initialBackoffMs: 1,
      requestTimeoutMs: 2_000,
      pingTimeoutMs: 500,
    });

    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('hello')],
      onDone: (r) => {
        done = r;
      },
    });
    const usage = (done as unknown as StreamDoneResult).usage;
    // Underlying counts still present, but cache fields drop.
    expect(usage?.promptTokens).toBe(500);
    expect(usage?.cachedInputTokens).toBeUndefined();
    expect(usage?.freshInputTokens).toBeUndefined();
  });
});

// ---------- Anthropic shape ----------

describe('AnthropicAdapter — cached-tokens parsing', () => {
  afterEach(() => restoreFetch());

  test('extracts cache_read_input_tokens + cache_creation_input_tokens', async () => {
    const events: string[] = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_x',
          role: 'assistant',
          usage: {
            input_tokens: 50,
            output_tokens: 0,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 150,
          },
        },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 12 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({
        type: 'message_stop',
      })}\n\n`,
    ];
    installFetch(async () => sseResponse(events));

    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20241022',
    });

    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('hi')],
      onDone: (r) => {
        done = r;
      },
    });
    const usage = (done as unknown as StreamDoneResult).usage;
    expect(usage).toBeDefined();
    // promptTokens = input + cache_creation + cache_read = 50 + 150 + 800.
    expect(usage?.promptTokens).toBe(1000);
    expect(usage?.completionTokens).toBe(12);
    expect(usage?.cachedInputTokens).toBe(800);
    expect(usage?.freshInputTokens).toBe(200);
    expect(usage?.cacheCreationTokens).toBe(150);
  });

  test('leaves cached fields undefined when no cache hit', async () => {
    const events: string[] = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_y',
          role: 'assistant',
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({
        type: 'message_stop',
      })}\n\n`,
    ];
    installFetch(async () => sseResponse(events));

    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20241022',
    });

    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMsg('hi')],
      onDone: (r) => {
        done = r;
      },
    });
    const usage = (done as unknown as StreamDoneResult).usage;
    expect(usage?.cachedInputTokens).toBeUndefined();
    expect(usage?.cacheCreationTokens).toBeUndefined();
    expect(usage?.freshInputTokens).toBeUndefined();
  });
});
