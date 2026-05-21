/**
 * Multimodal content round-trip tests.
 *
 * Verifies that a `Message` carrying `MessageContentPart[]` smuggled
 * through the `content` field reaches the wire payload in the right
 * shape for each adapter family:
 *
 *   - OpenAI-compatible (`LLMAdapter`) — passes the array form verbatim
 *     via the `image_url` content part.
 *   - Anthropic (`AnthropicAdapter`) — translates `image_url` to
 *     `{ type: 'image', source: ... }` blocks.
 *
 * The tests stub `globalThis.fetch` so no network call happens. They
 * intercept the JSON body, parse it, and assert on the message wire
 * shape.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import { AnthropicAdapter } from '@/llm/adapter-anthropic';
import { buildImageMessage } from '@/types/message';
import type { Message } from '@/types/global';

const TINY_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQYV2NgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';

const realFetch = globalThis.fetch;

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

function makeRecorder(
  responseBuilder: () => Response,
): {
  recorded: RecordedRequest[];
  install: () => void;
} {
  const recorded: RecordedRequest[] = [];
  return {
    recorded,
    install: () => {
      globalThis.fetch = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        let body: unknown = null;
        if (typeof init?.body === 'string') {
          try {
            body = JSON.parse(init.body);
          } catch {
            body = init.body;
          }
        }
        recorded.push({
          url: String(url),
          method: init?.method ?? 'GET',
          body,
        });
        return responseBuilder();
      }) as unknown as typeof fetch;
    },
  };
}

function openaiEmptyStream(): Response {
  // Minimal valid OpenAI SSE stream: an empty assistant delta + stop.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id: 'cmpl-1',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
          })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function anthropicEmptyStream(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: { id: 'msg-1', role: 'assistant', usage: { input_tokens: 1, output_tokens: 0 } },
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'ok' },
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
        ),
      );
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('multimodal round-trip — OpenAI-compatible adapter', () => {
  afterEach(() => restoreFetch());

  test('image_url content part is forwarded verbatim in wire body', async () => {
    const recorder = makeRecorder(() => openaiEmptyStream());
    recorder.install();
    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'gpt-4o-mini',
      backend: 'openai',
      apiKey: 'sk-test',
      maxAttempts: 1,
    });
    const imgMsg = buildImageMessage(TINY_BASE64, 'image/png', 'Describe.');
    const messages: Message[] = [imgMsg];
    await new Promise<void>((resolve) => {
      void adapter.streamChat({
        messages,
        onDone: () => resolve(),
      });
    });
    expect(recorder.recorded.length).toBe(1);
    const body = recorder.recorded[0]?.body as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const wire = body.messages[0]!;
    expect(wire.role).toBe('user');
    // The OpenAI adapter forwards the MessageContentPart[] verbatim.
    expect(Array.isArray(wire.content)).toBe(true);
    const parts = wire.content as Array<Record<string, unknown>>;
    const imagePart = parts.find((p) => p.type === 'image_url');
    expect(imagePart).toBeDefined();
    const imageUrlField = imagePart?.image_url as { url: string };
    expect(imageUrlField.url).toBe(`data:image/png;base64,${TINY_BASE64}`);
  });
});

describe('multimodal round-trip — Anthropic adapter', () => {
  afterEach(() => restoreFetch());

  test('image_url part translated to base64 image block', async () => {
    const recorder = makeRecorder(() => anthropicEmptyStream());
    recorder.install();
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    const imgMsg = buildImageMessage(TINY_BASE64, 'image/png', 'Describe.');
    const messages: Message[] = [imgMsg];
    await new Promise<void>((resolve) => {
      void adapter.streamChat({
        messages,
        onDone: () => resolve(),
      });
    });
    expect(recorder.recorded.length).toBe(1);
    const body = recorder.recorded[0]?.body as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const wire = body.messages[0]!;
    expect(wire.role).toBe('user');
    expect(Array.isArray(wire.content)).toBe(true);
    const blocks = wire.content as Array<Record<string, unknown>>;
    const imageBlock = blocks.find((b) => b.type === 'image');
    expect(imageBlock).toBeDefined();
    const source = imageBlock?.source as Record<string, unknown>;
    expect(source.type).toBe('base64');
    expect(source.media_type).toBe('image/png');
    expect(source.data).toBe(TINY_BASE64);
    // Text part also present.
    const textBlock = blocks.find((b) => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock?.text).toBe('Describe.');
  });
});
