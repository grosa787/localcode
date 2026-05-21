/**
 * OpenRouter request-shape contract tests.
 *
 * These assertions back the audit in `docs/DEBUGGING_OPENROUTER.md`:
 * what we send must conform to OpenRouter's chat-completion spec
 * (https://openrouter.ai/docs/api-reference/chat-completion) AND the
 * tool schemas must satisfy the strictest known upstream limits so a
 * paid Qwen / DeepSeek / Gemini Flash route doesn't 400 us partway
 * through a session.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import { TOOLS_SCHEMA } from '@/llm/tools-schema';
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
  headers: Record<string, string>;
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
    const headersOut: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
        headersOut[k] = v;
      }
    }
    recorded.push({ url: String(url), body: parsed, headers: headersOut });
    return sseResponse(basicTextThenStop());
  };
  return { fetchImpl, recorded };
}

afterEach(() => {
  restoreFetch();
});

describe('OpenRouter request shape — spec conformance', () => {
  test('headers + body match OpenRouter spec', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch();
    installFetch(fetchImpl);

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen-2.5-coder-32b-instruct',
      backend: 'openrouter',
      apiKey: 'or-test-key',
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
    });

    await adapter.streamChat({
      messages: [baseMessage('hi')],
      tools: [...TOOLS_SCHEMA],
      onDone: () => {
        /* noop */
      },
    });

    const last = recorded[recorded.length - 1];
    expect(last).toBeDefined();
    const body = last?.body as Record<string, unknown>;
    const headers = last?.headers ?? {};

    // 1. App-tagging headers (OpenRouter recommended).
    expect(headers['HTTP-Referer']).toBe('https://github.com/localcode');
    expect(headers['X-Title']).toBe('LocalCode');

    // 2. Streaming flags.
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });

    // 3. Top-level OpenRouter routing knobs.
    expect(body.route).toBe('fallback');
    expect(body.transforms).toEqual(['middle-out']);

    // 4. Provider sub-block.
    const provider = body.provider as Record<string, unknown> | undefined;
    expect(provider).toBeDefined();
    expect(provider?.allow_fallbacks).toBe(true);

    // 5. Every tool's parameters.type === 'object' (some upstream
    //    providers — notably Together's wrappers — reject other shapes).
    const tools = body.tools as Array<{ function: { parameters: { type: string } } }>;
    expect(Array.isArray(tools)).toBe(true);
    for (const t of tools) {
      expect(t.function.parameters.type).toBe('object');
    }

    // 6. Tool descriptions are bounded — some providers truncate or
    //    reject descriptions > 1024 chars.
    const tools2 = body.tools as Array<{ function: { description: string } }>;
    for (const t of tools2) {
      expect(t.function.description.length).toBeLessThanOrEqual(1024);
    }

    // 7. Tool count ≤ 32 (Anthropic's hard limit; OpenRouter passes
    //    through to providers with similar limits).
    expect(tools.length).toBeLessThanOrEqual(32);

    // 8. Tool names match `[a-zA-Z0-9_]+` (some providers reject
    //    other characters).
    const tools3 = body.tools as Array<{ function: { name: string } }>;
    for (const t of tools3) {
      expect(t.function.name).toMatch(/^[a-zA-Z0-9_]+$/);
    }
  });
});
