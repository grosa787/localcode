/**
 * OpenRouter prompt-cache pass-through tests.
 *
 * OpenRouter mirrors the OpenAI Chat Completions surface but accepts
 * Anthropic-style `cache_control: { type: 'ephemeral' }` markers nested
 * into message content blocks (array-of-parts form) and forwards them
 * to Anthropic verbatim.
 *
 * The {@link LLMAdapter} adds these markers ONLY when:
 *   - `backend === 'openrouter'`, AND
 *   - the resolved model id starts with `anthropic/`.
 *
 * For other model namespaces (`openai/*`, `deepseek/*`, etc.) we leave
 * the standard OpenAI shape untouched — those providers either auto-cache
 * (OpenAI: stable prefixes ≥1024 tokens) or don't support cache markers
 * at all, and unknown fields would risk a 400.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import type { Message } from '@/types/global';
import type { ToolSchema } from '@/types/message';

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

function userMsg(content: string): Message {
  return { id: 'u-1', role: 'user', content, createdAt: 0 };
}

function sysMsg(content: string): Message {
  return { id: 's-1', role: 'system', content, createdAt: 0 };
}

interface Recorded {
  body: Record<string, unknown>;
}

function makeRecordingFetch(): { fetchImpl: FetchImpl; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const fetchImpl: FetchImpl = async (_url, init) => {
    let parsed: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        const p: unknown = JSON.parse(init.body);
        if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
          parsed = p as Record<string, unknown>;
        }
      } catch {
        parsed = {};
      }
    }
    recorded.push({ body: parsed });
    return sseResponse(basicTextThenStop());
  };
  return { fetchImpl, recorded };
}

function buildTool(name: string): ToolSchema {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} tool`,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  };
}

afterEach(() => {
  restoreFetch();
});

describe('OpenRouter prompt-cache pass-through', () => {
  test('anthropic/claude-3.5-sonnet — system msg becomes content-blocks with cache_control', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch();
    installFetch(fetchImpl);

    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      backend: 'openrouter',
      apiKey: 'or-test',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [sysMsg('You are LocalCode.'), userMsg('Hi')],
      onDone: () => {
        /* noop */
      },
    });

    expect(recorded.length).toBe(1);
    const body = recorded[0]?.body as Record<string, unknown>;
    const msgs = body.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const sys = msgs[0] as { role: string; content: unknown };
    expect(sys.role).toBe('system');
    // Content was rewritten from a plain string to an array-of-parts
    // with a cache_control marker on the text part.
    expect(Array.isArray(sys.content)).toBe(true);
    const parts = sys.content as Array<Record<string, unknown>>;
    expect(parts.length).toBe(1);
    const part = parts[0] as Record<string, unknown>;
    expect(part.type).toBe('text');
    expect(part.text).toBe('You are LocalCode.');
    expect(part.cache_control).toEqual({ type: 'ephemeral' });
    // Other (non-system) messages are unchanged: still string content.
    const u = msgs[1] as { role: string; content: unknown };
    expect(u.role).toBe('user');
    expect(typeof u.content).toBe('string');
  });

  test('anthropic/claude-3.5-sonnet — last tool gets cache_control; earlier tools do not', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      backend: 'openrouter',
      apiKey: 'or-test',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [sysMsg('Sys'), userMsg('Hi')],
      tools: [buildTool('read_file'), buildTool('list_dir'), buildTool('write_file')],
      onDone: () => {
        /* noop */
      },
    });
    const body = recorded[0]?.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.length).toBe(3);
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toBeUndefined();
    expect(tools[2]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('openai/gpt-4o — no cache_control markers (relies on OpenAI auto-cache)', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o',
      backend: 'openrouter',
      apiKey: 'or-test',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [sysMsg('Sys'), userMsg('Hi')],
      tools: [buildTool('read_file'), buildTool('write_file')],
      onDone: () => {
        /* noop */
      },
    });
    const body = recorded[0]?.body as Record<string, unknown>;
    // System remains a plain string — no rewrite.
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]?.role).toBe('system');
    expect(typeof msgs[0]?.content).toBe('string');
    // No tool carries cache_control.
    const tools = body.tools as Array<Record<string, unknown>>;
    for (const t of tools) {
      expect(t.cache_control).toBeUndefined();
    }
  });

  test('deepseek/deepseek-coder — no cache_control markers (provider does not support them)', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-coder',
      backend: 'openrouter',
      apiKey: 'or-test',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [sysMsg('Sys'), userMsg('Hi')],
      tools: [buildTool('read_file')],
      onDone: () => {
        /* noop */
      },
    });
    const body = recorded[0]?.body as Record<string, unknown>;
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    expect(typeof msgs[0]?.content).toBe('string');
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.cache_control).toBeUndefined();
  });

  test('anthropic/claude-3-haiku-20240307 — markers present (any anthropic/* prefix qualifies)', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3-haiku-20240307',
      backend: 'openrouter',
      apiKey: 'or-test',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [sysMsg('Sys'), userMsg('Hi')],
      tools: [buildTool('read_file')],
      onDone: () => {
        /* noop */
      },
    });
    const body = recorded[0]?.body as Record<string, unknown>;
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    expect(Array.isArray(msgs[0]?.content)).toBe(true);
    const parts = msgs[0]?.content as Array<Record<string, unknown>>;
    expect(parts[0]?.cache_control).toEqual({ type: 'ephemeral' });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('openrouter+anthropic — params.model overrides config.model when classifying as anthropic/*', async () => {
    // Build adapter with a non-anthropic default model, then override
    // via params.model — markers should still attach because the
    // classifier consults the resolved model id.
    const { fetchImpl, recorded } = makeRecordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o',
      backend: 'openrouter',
      apiKey: 'or-test',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [sysMsg('Sys'), userMsg('Hi')],
      model: 'anthropic/claude-3.5-sonnet',
      onDone: () => {
        /* noop */
      },
    });
    const body = recorded[0]?.body as Record<string, unknown>;
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    expect(Array.isArray(msgs[0]?.content)).toBe(true);
  });
});
