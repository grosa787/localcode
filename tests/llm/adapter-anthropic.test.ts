/**
 * R7 (Agent 9) — AnthropicAdapter tests.
 *
 * Covers the dedicated Messages-API adapter (separate from the
 * OpenAI-compat `LLMAdapter`):
 *   - constructor validation (apiKey + model are required),
 *   - request shape (endpoint = `/v1/messages`, headers carry
 *     `x-api-key` + `anthropic-version`),
 *   - body translation (system messages → top-level `system`,
 *     consecutive same-role messages coalesced, OpenAI-shaped tool
 *     schemas → `input_schema`, tool-result messages echoed as user
 *     `tool_result` blocks),
 *   - SSE event dispatch (`text_delta` → `onChunk`, `input_json_delta`
 *     accumulated, `thinking_delta` → `onThinkingChunk`,
 *     `message_stop` → `onDone` fires with `finishReason: 'stop'`),
 *   - error response handling (401 surfaces in `onDone({ error })`),
 *   - `getModels()` returns the hardcoded list (newest first),
 *   - `ping()` returns boolean.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { AnthropicAdapter } from '@/llm/adapter-anthropic';
import type { Message, ToolCall } from '@/types/global';
import type {
  StreamDoneResult,
  ToolSchema,
} from '@/types/message';

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

function userMessage(content: string, id = 'm-1'): Message {
  return { id, role: 'user', content, createdAt: 0 };
}

function systemMessage(content: string, id = 's-1'): Message {
  return { id, role: 'system', content, createdAt: 0 };
}

function assistantMessage(content: string, id = 'a-1'): Message {
  return { id, role: 'assistant', content, createdAt: 0 };
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeRecorder(
  responseBuilder: () => Response,
): {
  fetchImpl: FetchImpl;
  recorded: RecordedRequest[];
} {
  const recorded: RecordedRequest[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string> | Headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k] = v;
        });
      } else {
        for (const [k, v] of Object.entries(h)) headers[k] = String(v);
      }
    }
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
      headers,
      body,
    });
    return responseBuilder();
  };
  return { fetchImpl, recorded };
}

/** Build a complete Anthropic SSE event sequence for a simple text reply. */
function happyTextStream(): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_01abc',
        role: 'assistant',
        usage: { input_tokens: 10, output_tokens: 0 },
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
      delta: { type: 'text_delta', text: 'Hello' },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' world' },
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
}

// ---------- Constructor ----------

describe('AnthropicAdapter — constructor validation', () => {
  test('throws when apiKey is empty', () => {
    expect(() => {
      new AnthropicAdapter({
        apiKey: '',
        model: 'claude-3-5-sonnet-20241022',
      });
    }).toThrow();
  });

  test('throws when apiKey is missing', () => {
    expect(() => {
      new AnthropicAdapter({
        // @ts-expect-error — exercising runtime guard
        apiKey: undefined,
        model: 'claude-3-5-sonnet-20241022',
      });
    }).toThrow();
  });

  test('throws when model is empty', () => {
    expect(() => {
      new AnthropicAdapter({ apiKey: 'sk-ant', model: '' });
    }).toThrow();
  });

  test('constructs successfully with apiKey + model', () => {
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-3-5-sonnet-20241022',
    });
    expect(adapter).toBeDefined();
  });
});

// ---------- Endpoint + headers ----------

describe('AnthropicAdapter.streamChat — endpoint + headers', () => {
  afterEach(() => restoreFetch());

  test('POSTs to /v1/messages (NOT /chat/completions)', async () => {
    const { fetchImpl, recorded } = makeRecorder(() =>
      sseFromEvents(happyTextStream()),
    );
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [userMessage('hi')],
      onDone: () => {
        /* noop */
      },
    });
    expect(recorded.length).toBeGreaterThan(0);
    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(last.url).toContain('/v1/messages');
    expect(last.url).not.toContain('chat/completions');
    expect(last.method).toBe('POST');
  });

  test('headers include x-api-key, anthropic-version, Content-Type', async () => {
    const { fetchImpl, recorded } = makeRecorder(() =>
      sseFromEvents(happyTextStream()),
    );
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-magic',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [userMessage('hi')],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(
      last.headers['x-api-key'] ?? last.headers['X-Api-Key'],
    ).toBe('sk-ant-magic');
    expect(
      last.headers['anthropic-version'] ?? last.headers['Anthropic-Version'],
    ).toBe('2023-06-01');
    expect(
      last.headers['Content-Type'] ?? last.headers['content-type'],
    ).toBe('application/json');
    // No `Authorization: Bearer` — Anthropic doesn't use that.
    expect(last.headers.Authorization).toBeUndefined();
    expect(last.headers.authorization).toBeUndefined();
  });

  test('customHeaders override canonical headers (last write wins)', async () => {
    const { fetchImpl, recorded } = makeRecorder(() =>
      sseFromEvents(happyTextStream()),
    );
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      customHeaders: { 'anthropic-version': '2024-99-99' },
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [userMessage('hi')],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    expect(
      last.headers['anthropic-version'] ?? last.headers['Anthropic-Version'],
    ).toBe('2024-99-99');
  });
});

// ---------- Body shape: system, coalesce, tools ----------

describe('AnthropicAdapter — request body translation', () => {
  afterEach(() => restoreFetch());

  test('system messages are extracted to top-level `system` field', async () => {
    const { fetchImpl, recorded } = makeRecorder(() =>
      sseFromEvents(happyTextStream()),
    );
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [
        systemMessage('You are a helpful assistant.'),
        userMessage('hi'),
      ],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    const body = last.body as Record<string, unknown>;
    // Cache marker round: `system` is now emitted in array-of-content-blocks
    // form so a `cache_control: { type: 'ephemeral' }` marker can attach.
    const sys = body.system as Array<Record<string, unknown>>;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys.length).toBe(1);
    const sysBlock = sys[0] as Record<string, unknown>;
    expect(sysBlock.type).toBe('text');
    expect(sysBlock.text).toBe('You are a helpful assistant.');
    expect(sysBlock.cache_control).toEqual({ type: 'ephemeral' });
    // The wire `messages` array must NOT contain a system role.
    const wireMessages = body.messages as Array<{ role: string }>;
    expect(wireMessages.every((m) => m.role !== 'system')).toBe(true);
  });

  test('multiple system messages joined with blank lines', async () => {
    const { fetchImpl, recorded } = makeRecorder(() =>
      sseFromEvents(happyTextStream()),
    );
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [
        systemMessage('First rule.', 's-1'),
        systemMessage('Second rule.', 's-2'),
        userMessage('hi'),
      ],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    const body = last.body as Record<string, unknown>;
    // Array-of-content-blocks form (cache marker round) — joined text
    // lives on `system[0].text`.
    const sys = body.system as Array<Record<string, unknown>>;
    expect(Array.isArray(sys)).toBe(true);
    const sysBlock = sys[0] as Record<string, unknown>;
    expect(sysBlock.text).toBe('First rule.\n\nSecond rule.');
    expect(sysBlock.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('consecutive same-role messages are coalesced', async () => {
    const { fetchImpl, recorded } = makeRecorder(() =>
      sseFromEvents(happyTextStream()),
    );
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    await adapter.streamChat({
      messages: [
        userMessage('First user msg.', 'u-1'),
        userMessage('Second user msg.', 'u-2'),
        assistantMessage('Reply.', 'a-1'),
        userMessage('Third user msg.', 'u-3'),
      ],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    const body = last.body as Record<string, unknown>;
    const wireMessages = body.messages as Array<{
      role: string;
      content: unknown;
    }>;
    // Two adjacent user messages must coalesce into one. Total count
    // becomes 3 (user-merged, assistant, user) instead of the input 4.
    expect(wireMessages.length).toBe(3);
    const firstUser = wireMessages[0] as { role: string; content: string };
    expect(firstUser.role).toBe('user');
    expect(firstUser.content).toContain('First user msg.');
    expect(firstUser.content).toContain('Second user msg.');
  });

  test('tool schema translates function.parameters → input_schema', async () => {
    const { fetchImpl, recorded } = makeRecorder(() =>
      sseFromEvents(happyTextStream()),
    );
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    const tool: ToolSchema = {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
    };
    await adapter.streamChat({
      messages: [userMessage('hi')],
      tools: [tool],
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    const body = last.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(1);
    const t = tools[0] as Record<string, unknown>;
    expect(t.name).toBe('read_file');
    expect(t.description).toBe('Read a file');
    // Renamed: parameters → input_schema; no `function` wrapper.
    expect(t.input_schema).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    expect(t.function).toBeUndefined();
    expect(t.parameters).toBeUndefined();
  });

  test('tool-role messages wrap as user role with tool_result content block', async () => {
    const { fetchImpl, recorded } = makeRecorder(() =>
      sseFromEvents(happyTextStream()),
    );
    installFetch(fetchImpl);
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    const messages: Message[] = [
      userMessage('Read this file', 'u-1'),
      {
        id: 'a-1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'toolu_01abc',
            name: 'read_file',
            arguments: { path: '/etc/hosts' },
          },
        ],
        createdAt: 0,
      },
      {
        id: 't-1',
        role: 'tool',
        toolCallId: 'toolu_01abc',
        toolName: 'read_file',
        content: '127.0.0.1 localhost',
        createdAt: 0,
      },
    ];
    await adapter.streamChat({
      messages,
      onDone: () => {
        /* noop */
      },
    });
    const last = recorded[recorded.length - 1] as RecordedRequest;
    const body = last.body as Record<string, unknown>;
    const wireMessages = body.messages as Array<{
      role: string;
      content: unknown;
    }>;
    // Last wire message must be a `user` role with a single tool_result block.
    const toolResultMsg = wireMessages[wireMessages.length - 1] as {
      role: string;
      content: Array<Record<string, unknown>>;
    };
    expect(toolResultMsg.role).toBe('user');
    expect(Array.isArray(toolResultMsg.content)).toBe(true);
    const block = toolResultMsg.content[0] as Record<string, unknown>;
    expect(block.type).toBe('tool_result');
    expect(block.tool_use_id).toBe('toolu_01abc');
    expect(block.content).toBe('127.0.0.1 localhost');
  });
});

// ---------- SSE event handling ----------

describe('AnthropicAdapter.streamChat — synthetic SSE event stream', () => {
  afterEach(() => restoreFetch());

  test('text_delta events fire onChunk; message_stop fires onDone(stop)', async () => {
    installFetch(async () => sseFromEvents(happyTextStream()));
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    const chunks: string[] = [];
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMessage('hi')],
      onChunk: (t) => chunks.push(t),
      onDone: (r) => {
        done = r;
      },
    });
    expect(chunks.join('')).toBe('Hello world');
    expect(done).not.toBeNull();
    const d = done as unknown as StreamDoneResult;
    expect(d.finishReason).toBe('stop');
  });

  test('thinking_delta is routed to onThinkingChunk (not onChunk)', async () => {
    const events: string[] = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_thinking', role: 'assistant' },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Hmm, let me think...' },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Answer.' },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 1,
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 3 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({
        type: 'message_stop',
      })}\n\n`,
    ];
    installFetch(async () => sseFromEvents(events));
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    const visible: string[] = [];
    const thinking: string[] = [];
    await adapter.streamChat({
      messages: [userMessage('hi')],
      onChunk: (t) => visible.push(t),
      onThinkingChunk: (t) => thinking.push(t),
      onDone: () => {
        /* noop */
      },
    });
    expect(thinking.join('')).toBe('Hmm, let me think...');
    expect(visible.join('')).toBe('Answer.');
  });

  test('tool_use blocks accumulate input_json_delta and fire onToolCalls once', async () => {
    const events: string[] = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_tool', role: 'assistant' },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_01xyz',
          name: 'read_file',
          input: {},
        },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"/etc/hosts"}' },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 8 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({
        type: 'message_stop',
      })}\n\n`,
    ];
    installFetch(async () => sseFromEvents(events));
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    let toolCalls: ToolCall[] | null = null;
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMessage('Read /etc/hosts')],
      onToolCalls: (calls) => {
        toolCalls = calls;
      },
      onDone: (r) => {
        done = r;
      },
    });
    expect(toolCalls).not.toBeNull();
    const tcs = toolCalls as unknown as ToolCall[];
    expect(tcs.length).toBe(1);
    expect(tcs[0]?.id).toBe('toolu_01xyz');
    expect(tcs[0]?.name).toBe('read_file');
    expect(tcs[0]?.arguments).toEqual({ path: '/etc/hosts' });
    expect(done).not.toBeNull();
    const d = done as unknown as StreamDoneResult;
    expect(d.finishReason).toBe('stop');
  });

  test('message_start usage populates promptTokens', async () => {
    installFetch(async () => sseFromEvents(happyTextStream()));
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMessage('hi')],
      onDone: (r) => {
        done = r;
      },
    });
    const d = done as unknown as StreamDoneResult;
    expect(d.usage?.promptTokens).toBe(10);
    expect(d.usage?.completionTokens).toBe(5);
  });

  test('max_tokens stop_reason surfaces as length finishReason', async () => {
    const events: string[] = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_mt', role: 'assistant' },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'partial' },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens' },
        usage: { output_tokens: 1 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({
        type: 'message_stop',
      })}\n\n`,
    ];
    installFetch(async () => sseFromEvents(events));
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
    });
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMessage('hi')],
      onDone: (r) => {
        done = r;
      },
    });
    const d = done as unknown as StreamDoneResult;
    expect(d.finishReason).toBe('length');
    expect(d.error ?? '').toContain('max_tokens');
  });
});

// ---------- Error response ----------

describe('AnthropicAdapter — error response', () => {
  afterEach(() => restoreFetch());

  test('401 invalid key surfaces friendly error in onDone', async () => {
    installFetch(async () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'invalid x-api-key',
          },
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-bad',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMessage('hi')],
      onDone: (r) => {
        done = r;
      },
    });
    expect(done).not.toBeNull();
    const d = done as unknown as StreamDoneResult;
    expect(d.finishReason).toBe('error');
    expect(d.error ?? '').toContain('401');
  });

  test('mid-stream `error` event surfaces via onDone({ error })', async () => {
    const events: string[] = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_err', role: 'assistant' },
      })}\n\n`,
      `event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: 'service overloaded',
        },
      })}\n\n`,
    ];
    installFetch(async () => sseFromEvents(events));
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [userMessage('hi')],
      onDone: (r) => {
        done = r;
      },
    });
    const d = done as unknown as StreamDoneResult;
    expect(d.finishReason).toBe('error');
    expect(d.error ?? '').toContain('overloaded');
  });
});

// ---------- getModels + ping ----------

describe('AnthropicAdapter.getModels', () => {
  test('returns hardcoded list with newest model first', async () => {
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
    });
    const models = await adapter.getModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    // First entry should be the newest (claude-opus-4-7 family).
    expect(models[0]).toContain('claude');
    // Should include some recognised models.
    expect(models.some((m) => m.startsWith('claude-3-5-sonnet'))).toBe(true);
  });

  test('returns a fresh array each call (does not leak the internal const)', async () => {
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
    });
    const a = await adapter.getModels();
    const b = await adapter.getModels();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('AnthropicAdapter.ping', () => {
  afterEach(() => restoreFetch());

  test('returns true on 2xx response', async () => {
    installFetch(async () =>
      new Response(
        JSON.stringify({ id: 'ping-ok' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
    });
    const result = await adapter.ping();
    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);
  });

  test('returns false on 401 (invalid key)', async () => {
    installFetch(async () =>
      new Response('{"error":"unauth"}', { status: 401 }),
    );
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-bad',
      model: 'claude-3-5-sonnet-20241022',
    });
    const result = await adapter.ping();
    expect(typeof result).toBe('boolean');
    expect(result).toBe(false);
  });

  test('returns false on network error', async () => {
    installFetch(async () => {
      throw new Error('network unreachable');
    });
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-1',
      model: 'claude-3-5-sonnet-20241022',
    });
    const result = await adapter.ping();
    expect(result).toBe(false);
  });
});
