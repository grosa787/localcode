/**
 * Adapter wire-body shape audit for multimodal content.
 *
 * We swap `globalThis.fetch` for a recorder, send a single user message
 * whose content is a `MessageContentPart[]` containing one `image_url`
 * data URI, and inspect the resulting wire body for each adapter.
 *
 * The contract under test:
 *
 *   - OpenAI / OpenRouter / LM Studio / Ollama OpenAI-compat / Custom →
 *     forward `content` as the OpenAI `image_url` array shape verbatim.
 *   - Anthropic → translate `image_url` → `image` block with a
 *     `source.type: 'base64'` (data URI) or `source.type: 'url'`
 *     (http/https) under content blocks.
 */
import { describe, test, expect } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import { AnthropicAdapter } from '@/llm/adapter-anthropic';
import type { Message } from '@/types/global';
import type { MessageContentPart } from '@/types/message';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQYV2NgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';
const DATA_URI = `data:image/png;base64,${TINY_PNG_BASE64}`;

function buildMultimodalMessage(): Message {
  const parts: MessageContentPart[] = [
    { type: 'image_url', image_url: { url: DATA_URI } },
    { type: 'text', text: 'What is in this image?' },
  ];
  return {
    id: 'm-1',
    role: 'user',
    // Cast — Message.content is typed `string` for back-compat but
    // adapters detect the array form at serialisation time.
    content: parts as unknown as string,
    createdAt: Date.now(),
  };
}

interface RecordedRequest {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Swap `globalThis.fetch` with a recorder that returns a closed empty
 * SSE response, so the adapter's stream loop terminates immediately.
 * Returns the captured request body for assertions.
 */
async function captureWireBody(
  fn: (signal: AbortSignal) => Promise<void>,
): Promise<RecordedRequest> {
  const original = globalThis.fetch;
  const captured: RecordedRequest = {
    url: '',
    body: null,
    headers: {},
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = typeof input === 'string' ? input : String(input);
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers ?? {};
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((v, k) => { headers[k] = v; });
    } else if (Array.isArray(initHeaders)) {
      for (const [k, v] of initHeaders) headers[k] = String(v);
    } else {
      for (const [k, v] of Object.entries(initHeaders)) headers[k] = String(v);
    }
    captured.headers = headers;
    if (init?.body) {
      try {
        captured.body = JSON.parse(String(init.body));
      } catch {
        captured.body = String(init.body);
      }
    }
    // Empty SSE stream so the adapter loop exits cleanly.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
    });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    await fn(controller.signal);
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

describe('multimodal wire-body — OpenAI / OpenRouter / LM Studio / Ollama / Custom', () => {
  test.each([
    { backend: 'openai' as const, baseUrl: 'https://api.openai.com', apiKey: 'sk-test' },
    { backend: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api', apiKey: 'sk-or-test' },
    { backend: 'lmstudio' as const, baseUrl: 'http://localhost:1234' },
    { backend: 'ollama' as const, baseUrl: 'http://localhost:11434' },
    { backend: 'custom' as const, baseUrl: 'https://groq.example/v1', apiKey: 'gsk-test' },
  ])(
    'forwards image_url unchanged for $backend',
    async ({ backend, baseUrl, apiKey }) => {
      const adapter = new LLMAdapter({
        backend,
        baseUrl,
        model: 'gpt-4o-mini',
        ...(apiKey !== undefined ? { apiKey } : {}),
        maxAttempts: 1,
        initialBackoffMs: 1,
        requestTimeoutMs: 5_000,
        stallTimeoutMs: 5_000,
      });
      const captured = await captureWireBody(async (signal) => {
        await adapter.streamChat({
          messages: [buildMultimodalMessage()],
          signal,
        });
      });
      const body = captured.body as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const msg = body.messages[0];
      expect(msg).toBeDefined();
      expect(msg?.role).toBe('user');
      expect(Array.isArray(msg?.content)).toBe(true);
      const content = msg?.content as MessageContentPart[];
      const imagePart = content.find((p) => p.type === 'image_url');
      const textPart = content.find((p) => p.type === 'text');
      expect(imagePart).toBeDefined();
      expect(textPart).toBeDefined();
      if (imagePart?.type === 'image_url') {
        expect(imagePart.image_url.url).toBe(DATA_URI);
      }
    },
  );
});

describe('multimodal wire-body — Anthropic', () => {
  test('translates image_url to Anthropic image block with base64 source', async () => {
    const adapter = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-6-20251001',
      maxAttempts: 1,
      initialBackoffMs: 1,
      requestTimeoutMs: 5_000,
      stallTimeoutMs: 5_000,
    });
    const captured = await captureWireBody(async (signal) => {
      await adapter.streamChat({
        messages: [buildMultimodalMessage()],
        signal,
      });
    });
    const body = captured.body as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    const msg = body.messages[0];
    expect(msg?.role).toBe('user');
    expect(Array.isArray(msg?.content)).toBe(true);
    const blocks = msg?.content ?? [];
    const imageBlock = blocks.find((b) => b.type === 'image');
    const textBlock = blocks.find((b) => b.type === 'text');
    expect(imageBlock).toBeDefined();
    expect(textBlock).toBeDefined();
    expect(imageBlock?.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: TINY_PNG_BASE64,
    });
  });

  test('translates http image_url to Anthropic url source', async () => {
    const adapter = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-6-20251001',
      maxAttempts: 1,
      initialBackoffMs: 1,
      requestTimeoutMs: 5_000,
      stallTimeoutMs: 5_000,
    });
    const parts: MessageContentPart[] = [
      { type: 'image_url', image_url: { url: 'https://example.com/foo.png' } },
    ];
    const msg: Message = {
      id: 'm-2',
      role: 'user',
      content: parts as unknown as string,
      createdAt: Date.now(),
    };
    const captured = await captureWireBody(async (signal) => {
      await adapter.streamChat({
        messages: [msg],
        signal,
      });
    });
    const body = captured.body as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const imageBlock = body.messages[0]?.content?.find((b) => b.type === 'image');
    expect(imageBlock?.source).toEqual({
      type: 'url',
      url: 'https://example.com/foo.png',
    });
  });
});
