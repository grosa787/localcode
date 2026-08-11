/**
 * Unsloth Studio — wire-contract tests.
 *
 * The premise of the Unsloth integration is that it needs NO new adapter
 * and NO new SSE parser: it is plain OpenAI over `/v1/chat/completions`,
 * plus a bearer token. This file is what makes that premise falsifiable.
 * If a future change makes the Unsloth path diverge from plain OpenAI —
 * by adding a proprietary body field, by depending on a `usage` object
 * Unsloth may never send, or by breaking tool-call reconstruction — one
 * of these tests goes red.
 *
 * Auth (the highest-risk line) lives in `adapter-unsloth-auth.test.ts`.
 *
 * Two deliberate design notes:
 *
 *  1. The "no usage object" case is not hypothetical hardening. Whether
 *     Unsloth returns `usage` at all is UNVERIFIED upstream — the docs
 *     don't say. Rather than guess, we prove both shapes parse.
 *  2. Everything here runs off an injected `globalThis.fetch` and
 *     `chunkBatchMs: 0`, so there is no wall-clock dependency.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import type { Message } from '@/types/global';
import type { StreamDoneResult, ToolSchema } from '@/types/message';

type FetchImpl = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface RecordedRequest {
  url: string;
  method: string;
  body: string | null;
}

const realFetch = globalThis.fetch;

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function sseResponse(frames: readonly string[]): Response {
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(build: () => Response): RecordedRequest[] {
  const recorded: RecordedRequest[] = [];
  const impl: FetchImpl = async (url, init) => {
    recorded.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return build();
  };
  globalThis.fetch = impl as unknown as typeof fetch;
  return recorded;
}

function makeAdapter(): LLMAdapter {
  return new LLMAdapter({
    baseUrl: 'http://localhost:8888/v1',
    model: 'unsloth/qwen3-coder-30B-A3B-Instruct-GGUF',
    backend: 'unsloth',
    apiKey: 'sk-unsloth-test-key',
    maxAttempts: 1,
    initialBackoffMs: 1,
    // Batching is a wall-clock behaviour; disable it so `onChunk`
    // assertions are deterministic.
    chunkBatchMs: 0,
    requestTimeoutMs: 5_000,
    pingTimeoutMs: 500,
  });
}

const userMessage: Message = {
  id: 'm-1',
  role: 'user',
  content: 'list the files',
  createdAt: 0,
};

/** `data: <json>\n\n`, the only frame shape Unsloth documents. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const DONE_FRAME = 'data: [DONE]\n\n';

/** Two content deltas then `finish_reason: stop`, no usage object. */
function textStreamWithoutUsage(): string[] {
  return [
    frame({ choices: [{ index: 0, delta: { content: 'Hello' } }] }),
    frame({ choices: [{ index: 0, delta: { content: ', world' } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    DONE_FRAME,
  ];
}

/** Parse the JSON body of the recorded chat-completions POST. */
function chatBodyOf(recorded: readonly RecordedRequest[]): Record<string, unknown> {
  const post = [...recorded]
    .reverse()
    .find((r) => r.url.includes('/chat/completions'));
  expect(post).toBeDefined();
  const raw = post?.body;
  expect(typeof raw).toBe('string');
  const parsed: unknown = JSON.parse(raw as string);
  expect(typeof parsed).toBe('object');
  return parsed as Record<string, unknown>;
}

// ---------- request body ----------

describe('unsloth — request body is plain OpenAI', () => {
  afterEach(() => restoreFetch());

  test('posts to /v1/chat/completions with the standard fields', async () => {
    const recorded = installFetch(() => sseResponse(textStreamWithoutUsage()));

    await makeAdapter().streamChat({ messages: [userMessage] });

    const body = chatBodyOf(recorded);
    expect(body.model).toBe('unsloth/qwen3-coder-30B-A3B-Instruct-GGUF');
    expect(body.stream).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  test('sends NONE of the Unsloth-proprietary body fields', async () => {
    // Unsloth accepts `enable_thinking` / `enable_tools` / `enabled_tools`
    // / `session_id`. We deliberately never send them: `enable_tools` in
    // particular re-enables the server-side tool loop that `--disable-tools`
    // exists to switch off, which would swallow every tool call LocalCode
    // depends on. Keeping the body plain-OpenAI is what lets this backend
    // share the adapter with every other provider.
    const recorded = installFetch(() => sseResponse(textStreamWithoutUsage()));

    await makeAdapter().streamChat({ messages: [userMessage] });

    const body = chatBodyOf(recorded);
    for (const forbidden of [
      'enable_thinking',
      'enable_tools',
      'enabled_tools',
      'session_id',
    ]) {
      expect(Object.hasOwn(body, forbidden)).toBe(false);
    }
  });

  test('sends none of the OpenRouter routing fields either', async () => {
    // `route` / `transforms` / `provider` are OpenRouter-gateway
    // concepts. An unrecognised field on a llama.cpp-backed server is at
    // best ignored and at worst a 400.
    const recorded = installFetch(() => sseResponse(textStreamWithoutUsage()));

    await makeAdapter().streamChat({ messages: [userMessage] });

    const body = chatBodyOf(recorded);
    for (const forbidden of ['route', 'transforms', 'provider']) {
      expect(Object.hasOwn(body, forbidden)).toBe(false);
    }
  });

  test('does not use the Ollama-shaped `options` envelope', async () => {
    // Ollama nests generation knobs under `options`; every other
    // OpenAI-compatible server (Unsloth included) takes them top-level.
    const recorded = installFetch(() => sseResponse(textStreamWithoutUsage()));

    await makeAdapter().streamChat({ messages: [userMessage] });

    const body = chatBodyOf(recorded);
    expect(Object.hasOwn(body, 'options')).toBe(false);
    expect(Object.hasOwn(body, 'keep_alive')).toBe(false);
  });

  test('tools go out in the standard OpenAI schema', async () => {
    const recorded = installFetch(() => sseResponse(textStreamWithoutUsage()));

    const tools: ToolSchema[] = [
      {
        type: 'function',
        function: {
          name: 'list_dir',
          description: 'List a directory',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ];

    await makeAdapter().streamChat({ messages: [userMessage], tools });

    const body = chatBodyOf(recorded);
    expect(body.tool_choice).toBe('auto');
    const sent = body.tools;
    expect(Array.isArray(sent)).toBe(true);
    const first = (sent as unknown[])[0] as {
      type?: string;
      function?: { name?: string };
    };
    expect(first.type).toBe('function');
    expect(first.function?.name).toBe('list_dir');
  });
});

// ---------- GET /v1/models ----------

describe('unsloth — /v1/models parsing', () => {
  afterEach(() => restoreFetch());

  test('parses the documented response shape', async () => {
    // Verbatim from Unsloth's API docs: an object/list envelope whose
    // entries carry `id`, `object: "model"`, `owned_by: "local"`.
    installFetch(() =>
      jsonResponse({
        object: 'list',
        data: [
          {
            id: 'unsloth/gemma-4-26B-A4B-it-GGUF',
            object: 'model',
            owned_by: 'local',
          },
          {
            id: 'unsloth/qwen3-coder-30B-A3B-Instruct-GGUF',
            object: 'model',
            owned_by: 'local',
          },
        ],
      }),
    );

    const models = await makeAdapter().getModels();

    expect(models).toEqual([
      'unsloth/gemma-4-26B-A4B-it-GGUF',
      'unsloth/qwen3-coder-30B-A3B-Instruct-GGUF',
    ]);
  });

  test('an empty catalogue is an empty list, not a throw', async () => {
    // `unsloth studio` with no model loaded is a legitimate state; the
    // model picker must render "none" rather than blow up onboarding.
    installFetch(() => jsonResponse({ object: 'list', data: [] }));

    expect(await makeAdapter().getModels()).toEqual([]);
  });

  test('unknown extra fields on a model entry are tolerated', async () => {
    // Unsloth is under active development and may add fields at any
    // time. Zod parsing must not be strict here.
    installFetch(() =>
      jsonResponse({
        object: 'list',
        data: [
          {
            id: 'unsloth/gemma-4-26B-A4B-it-GGUF',
            object: 'model',
            owned_by: 'local',
            created: 1_700_000_000,
            quantization: 'Q4_K_M',
            context_length: 32_768,
          },
        ],
      }),
    );

    expect(await makeAdapter().getModels()).toEqual([
      'unsloth/gemma-4-26B-A4B-it-GGUF',
    ]);
  });
});

// ---------- SSE streaming ----------

describe('unsloth — SSE streaming', () => {
  afterEach(() => restoreFetch());

  test('content deltas arrive in order and finish with stop', async () => {
    installFetch(() => sseResponse(textStreamWithoutUsage()));

    const chunks: string[] = [];
    let done: StreamDoneResult | undefined;

    await makeAdapter().streamChat({
      messages: [userMessage],
      onChunk: (t) => chunks.push(t),
      onDone: (r) => {
        done = r;
      },
    });

    expect(chunks.join('')).toBe('Hello, world');
    expect(done?.finishReason).toBe('stop');
    expect(done?.error).toBeUndefined();
  });

  test('a stream with NO usage object still completes cleanly', async () => {
    // Whether Unsloth emits `usage` is unverified upstream. A missing
    // usage object must never be an error: the turn completes, the text
    // is intact, and any numbers surfaced are flagged `estimated` so no
    // consumer mistakes a local guess for a server-reported count.
    installFetch(() => sseResponse(textStreamWithoutUsage()));

    let done: StreamDoneResult | undefined;
    await makeAdapter().streamChat({
      messages: [userMessage],
      onDone: (r) => {
        done = r;
      },
    });

    expect(done?.error).toBeUndefined();
    expect(done?.finishReason).toBe('stop');
    if (done?.usage !== undefined) {
      expect(done.usage.estimated).toBe(true);
      // Never invent a prompt-token count we were not given.
      expect(done.usage.promptTokens).toBeUndefined();
    }
  });

  test('when usage IS present it is read as server truth', async () => {
    installFetch(() =>
      sseResponse([
        frame({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        frame({
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 8,
            total_tokens: 128,
          },
        }),
        DONE_FRAME,
      ]),
    );

    let done: StreamDoneResult | undefined;
    await makeAdapter().streamChat({
      messages: [userMessage],
      onDone: (r) => {
        done = r;
      },
    });

    expect(done?.usage?.promptTokens).toBe(120);
    expect(done?.usage?.completionTokens).toBe(8);
    expect(done?.usage?.estimated).toBeUndefined();
  });

  test('usage without cached-token details leaves the cache fields unset', async () => {
    // Also unverified upstream: whether Unsloth reports
    // `prompt_tokens_details.cached_tokens`. Absent must mean "unknown",
    // never "0 cached" — the UI annotation simply does not render.
    installFetch(() =>
      sseResponse([
        frame({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        frame({
          choices: [],
          usage: { prompt_tokens: 50, completion_tokens: 2, total_tokens: 52 },
        }),
        DONE_FRAME,
      ]),
    );

    let done: StreamDoneResult | undefined;
    await makeAdapter().streamChat({
      messages: [userMessage],
      onDone: (r) => {
        done = r;
      },
    });

    expect(done?.usage?.cachedInputTokens).toBeUndefined();
    expect(done?.usage?.cacheCreationTokens).toBeUndefined();
  });

  test('cached_tokens ARE picked up if Unsloth turns out to report them', async () => {
    // No code change would be needed — the OpenAI-shaped reader already
    // handles it. This pins that so the capability isn't lost silently.
    installFetch(() =>
      sseResponse([
        frame({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        frame({
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 4,
            total_tokens: 104,
            prompt_tokens_details: { cached_tokens: 90 },
          },
        }),
        DONE_FRAME,
      ]),
    );

    let done: StreamDoneResult | undefined;
    await makeAdapter().streamChat({
      messages: [userMessage],
      onDone: (r) => {
        done = r;
      },
    });

    expect(done?.usage?.cachedInputTokens).toBe(90);
    expect(done?.usage?.freshInputTokens).toBe(10);
  });

  test('a stream that ends without [DONE] still resolves', async () => {
    // Defensive: a killed `unsloth run` closes the socket mid-stream.
    // The turn must terminate rather than hang the TUI forever.
    installFetch(() =>
      sseResponse([
        frame({ choices: [{ index: 0, delta: { content: 'partial' } }] }),
      ]),
    );

    let done: StreamDoneResult | undefined;
    const chunks: string[] = [];
    await makeAdapter().streamChat({
      messages: [userMessage],
      onChunk: (t) => chunks.push(t),
      onDone: (r) => {
        done = r;
      },
    });

    expect(chunks.join('')).toBe('partial');
    expect(done).toBeDefined();
  });
});

// ---------- tool calls ----------

describe('unsloth — tool calls round-trip in the OpenAI schema', () => {
  afterEach(() => restoreFetch());

  test('split tool_call deltas reassemble into one call', async () => {
    // This is the path `--disable-tools` protects. When the flag is set,
    // Unsloth hands tool calls back to the client in exactly this
    // OpenAI-delta shape; when it is missing, the server consumes them
    // and none of these frames ever arrive.
    installFetch(() =>
      sseResponse([
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'list_dir' } },
                ],
              },
            },
          ],
        }),
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"path"' } }],
              },
            },
          ],
        }),
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: ':"src"}' } }],
              },
            },
          ],
        }),
        frame({
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        }),
        DONE_FRAME,
      ]),
    );

    let emissions = 0;
    let captured: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }> = [];
    let done: StreamDoneResult | undefined;

    await makeAdapter().streamChat({
      messages: [userMessage],
      onToolCalls: (calls) => {
        emissions += 1;
        captured = calls;
      },
      onDone: (r) => {
        done = r;
      },
    });

    expect(emissions).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.id).toBe('call_1');
    expect(captured[0]?.name).toBe('list_dir');
    expect(captured[0]?.arguments).toEqual({ path: 'src' });
    // The adapter deliberately collapses `tool_calls` into `stop` for
    // `onDone` — the tool-call signal travels on `onToolCalls`, not on
    // the finish reason. Asserting `stop` here pins that Unsloth takes
    // the same normalisation path as every other OpenAI-compat backend.
    expect(done?.finishReason).toBe('stop');
    expect(done?.error).toBeUndefined();
  });

  test('two parallel tool calls both survive', async () => {
    installFetch(() =>
      sseResponse([
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_a',
                    function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
                  },
                  {
                    index: 1,
                    id: 'call_b',
                    function: { name: 'read_file', arguments: '{"path":"b.ts"}' },
                  },
                ],
              },
            },
          ],
        }),
        frame({
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        }),
        DONE_FRAME,
      ]),
    );

    let captured: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    await makeAdapter().streamChat({
      messages: [userMessage],
      onToolCalls: (calls) => {
        captured = calls;
      },
    });

    expect(captured).toHaveLength(2);
    expect(captured[0]?.arguments).toEqual({ path: 'a.ts' });
    expect(captured[1]?.arguments).toEqual({ path: 'b.ts' });
  });

  test('a tool-call turn with no usage object is still fine', async () => {
    // The two unknowns compound: a tool-calling turn that also omits
    // `usage` is the most likely real-world Unsloth response, so assert
    // the combination explicitly rather than trusting the parts.
    installFetch(() =>
      sseResponse([
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'list_dir', arguments: '{"path":"."}' },
                  },
                ],
              },
            },
          ],
        }),
        frame({
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        }),
        DONE_FRAME,
      ]),
    );

    let captured: Array<{ name: string }> = [];
    let done: StreamDoneResult | undefined;
    await makeAdapter().streamChat({
      messages: [userMessage],
      onToolCalls: (calls) => {
        captured = calls;
      },
      onDone: (r) => {
        done = r;
      },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.name).toBe('list_dir');
    expect(done?.error).toBeUndefined();
    expect(done?.usage?.promptTokens).toBeUndefined();
  });
});
