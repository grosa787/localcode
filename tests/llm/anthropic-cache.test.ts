/**
 * Anthropic prompt-cache marker tests.
 *
 * Verifies that {@link AnthropicAdapter} emits explicit
 * `cache_control: { type: 'ephemeral' }` markers in the request body
 * so Anthropic's prompt-caching kicks in (90% discount on cached input
 * tokens, 5-minute TTL):
 *
 *   - `body.system` is an ARRAY of content blocks (not a string), with
 *     a single text block carrying the marker.
 *   - `body.tools[last]` carries `cache_control` (and only the last
 *     tool — earlier tools have none, so the cache "before-and-including"
 *     scope spans the full tool list).
 *   - User / assistant message blocks DO NOT carry markers (we only
 *     cache the static prefix; per-turn message bodies vary).
 *   - The `LOCALCODE_DISABLE_PROMPT_CACHE=1` opt-out preserves the
 *     legacy `system: string` shape for callers that want it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AnthropicAdapter } from '@/llm/adapter-anthropic';
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

function sseFromEvents(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function happyTextStream(): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: { id: 'msg', role: 'assistant', usage: { input_tokens: 1 } },
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
      usage: { output_tokens: 1 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({
      type: 'message_stop',
    })}\n\n`,
  ];
}

function userMessage(content: string, id = 'm-1'): Message {
  return { id, role: 'user', content, createdAt: 0 };
}

function systemMessage(content: string, id = 's-1'): Message {
  return { id, role: 'system', content, createdAt: 0 };
}

interface RecordedRequest {
  body: Record<string, unknown>;
}

function makeRecorder(): {
  fetchImpl: FetchImpl;
  recorded: RecordedRequest[];
} {
  const recorded: RecordedRequest[] = [];
  const fetchImpl: FetchImpl = async (_url, init) => {
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        const parsed: unknown = JSON.parse(init.body);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed)
        ) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        body = {};
      }
    }
    recorded.push({ body });
    return sseFromEvents(happyTextStream());
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
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  };
}

describe('AnthropicAdapter — prompt-cache markers', () => {
  afterEach(() => restoreFetch());

  test('system is emitted as array form with cache_control on the text block', async () => {
    const { fetchImpl, recorded } = makeRecorder();
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [
        systemMessage('You are LocalCode, a TUI coding agent.'),
        userMessage('Hi'),
      ],
      onDone: () => {
        /* noop */
      },
    });
    expect(recorded.length).toBe(1);
    const body = recorded[0]?.body as Record<string, unknown>;
    const sys = body.system;
    expect(Array.isArray(sys)).toBe(true);
    const arr = sys as Array<Record<string, unknown>>;
    expect(arr.length).toBe(1);
    const block = arr[0] as Record<string, unknown>;
    expect(block.type).toBe('text');
    expect(block.text).toBe('You are LocalCode, a TUI coding agent.');
    expect(block.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('cache_control attaches only to the LAST tool when 3 tools are sent', async () => {
    const { fetchImpl, recorded } = makeRecorder();
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [
        systemMessage('You are LocalCode.'),
        userMessage('Hi'),
      ],
      tools: [
        buildTool('read_file'),
        buildTool('list_dir'),
        buildTool('write_file'),
      ],
      onDone: () => {
        /* noop */
      },
    });
    const body = recorded[0]?.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(3);
    // Earlier tools — NO cache_control.
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toBeUndefined();
    // Last tool — cache_control marker present.
    expect(tools[2]?.cache_control).toEqual({ type: 'ephemeral' });
    // Each tool retains its name + input_schema (cache_control doesn't
    // strip the wire fields).
    expect(tools[0]?.name).toBe('read_file');
    expect(tools[2]?.name).toBe('write_file');
    expect(tools[2]?.input_schema).toBeDefined();
  });

  test('single tool gets cache_control (last == first when length==1)', async () => {
    const { fetchImpl, recorded } = makeRecorder();
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [userMessage('Hi')],
      tools: [buildTool('read_file')],
      onDone: () => {
        /* noop */
      },
    });
    const body = recorded[0]?.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.length).toBe(1);
    expect(tools[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('user / assistant message blocks DO NOT carry cache_control', async () => {
    const { fetchImpl, recorded } = makeRecorder();
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [
        systemMessage('Sys'),
        userMessage('First user msg', 'u-1'),
        { id: 'a-1', role: 'assistant', content: 'reply', createdAt: 0 },
        userMessage('Second user msg', 'u-2'),
      ],
      onDone: () => {
        /* noop */
      },
    });
    const body = recorded[0]?.body as Record<string, unknown>;
    const wireMsgs = body.messages as Array<{
      role: string;
      content: unknown;
    }>;
    // Walk every message and assert none of them carry a cache_control
    // anywhere — neither at the message level, nor on any of their
    // content blocks (when the content is an array form).
    for (const m of wireMsgs) {
      const asRecord = m as unknown as Record<string, unknown>;
      expect(asRecord.cache_control).toBeUndefined();
      const c = m.content;
      if (Array.isArray(c)) {
        for (const block of c) {
          const bRec = block as unknown as Record<string, unknown>;
          expect(bRec.cache_control).toBeUndefined();
        }
      }
    }
  });

  test('LOCALCODE_DISABLE_PROMPT_CACHE=1 falls back to legacy string system + bare tools', async () => {
    const original = process.env.LOCALCODE_DISABLE_PROMPT_CACHE;
    process.env.LOCALCODE_DISABLE_PROMPT_CACHE = '1';
    try {
      const { fetchImpl, recorded } = makeRecorder();
      installFetch(fetchImpl);
      const adapter = new AnthropicAdapter({
        apiKey: 'sk-ant-test',
        model: 'claude-3-5-sonnet-20241022',
        maxAttempts: 1,
      });
      await adapter.streamChat({
        messages: [systemMessage('Sys'), userMessage('Hi')],
        tools: [buildTool('read_file')],
        onDone: () => {
          /* noop */
        },
      });
      const body = recorded[0]?.body as Record<string, unknown>;
      // Legacy: system is a plain string.
      expect(typeof body.system).toBe('string');
      expect(body.system).toBe('Sys');
      // Legacy: tools have NO cache_control.
      const tools = body.tools as Array<Record<string, unknown>>;
      expect(tools[0]?.cache_control).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.LOCALCODE_DISABLE_PROMPT_CACHE;
      } else {
        process.env.LOCALCODE_DISABLE_PROMPT_CACHE = original;
      }
    }
  });
});
