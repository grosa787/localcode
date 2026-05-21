/**
 * R26 (Agent A) — adapter additions for ROADMAP batch 2+3:
 *   - Chunk batching (#6) — `chunkBatchMs` ctor option coalesces text
 *     deltas before invoking onChunk.
 *   - JSON mode (#12) — `useJsonMode` ctor option adds
 *     `response_format: { type: 'json_object' }` when tools are present.
 *   - Adaptive temperature (#13) — `inferTemperatureForTask` helper +
 *     `adaptiveTemperature: true` ctor option apply per-turn temperature.
 *   - Tool-result trim wiring (#5) — adapter passes messages through
 *     `trimOldToolResults` before serialising to wire form.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { LLMAdapter, inferTemperatureForTask } from '@/llm/adapter';
import type { Message, ToolCall } from '@/types/global';
import type {
  StreamChatParams,
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

function captureBodyFetch(capture: {
  body: Record<string, unknown> | null;
}): FetchImpl {
  return async (_url, init) => {
    const raw = (init as RequestInit | undefined)?.body;
    if (typeof raw === 'string') {
      try {
        capture.body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        capture.body = null;
      }
    } else {
      capture.body = null;
    }
    const stop = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
    })}\n\n`;
    return sseResponse([stop, 'data: [DONE]\n\n']);
  };
}

function userMsg(content: string): Message {
  return { id: `u-${Math.random()}`, role: 'user', content, createdAt: 0 };
}

function asstWithToolCalls(
  toolCalls: ReadonlyArray<{ id: string; name: string; arguments: Record<string, unknown> }>,
): Message {
  return {
    id: `a-${Math.random()}`,
    role: 'assistant',
    content: '',
    toolCalls: toolCalls.map((c) => ({ ...c })),
    createdAt: 0,
  };
}

function toolReply(
  toolCallId: string,
  toolName: string,
  content: string,
): Message {
  return {
    id: `t-${Math.random()}`,
    role: 'tool',
    content,
    toolCallId,
    toolName,
    createdAt: 0,
  };
}

const fakeToolSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};

// ---------- ROADMAP #5 — tool-result trim wired into adapter body ----------

describe('LLMAdapter — tool-result trimming wires into wire body (R26 #5)', () => {
  afterEach(() => restoreFetch());

  test('default trim keeps the last 3 tool messages verbatim', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    // Assistant caller opens all 8 tool_call ids so the new
    // orphan-tool sanitiser pass keeps the replies on the wire.
    const callerToolCalls = Array.from({ length: 8 }, (_, i) => ({
      id: `c-${i}`, name: 'read_file', arguments: { path: `f-${i}.ts` },
    }));
    const messages: Message[] = [
      userMsg('go'),
      asstWithToolCalls(callerToolCalls),
    ];
    for (let i = 0; i < 8; i += 1) {
      messages.push(toolReply(`c-${i}`, 'read_file', `BODY-${i}`.repeat(20)));
    }

    await adapter.streamChat({ messages });

    const wireMsgs = (
      captured.body as { messages: Array<{ role: string; content: string }> }
    ).messages;
    // Token-economy default tightened from 5 → 3: first 5 of 8 tool
    // messages are collapsed; last 3 survive verbatim.
    const tools = wireMsgs.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(8);
    expect(tools[0]?.content).toContain('bytes collapsed');
    expect(tools[4]?.content).toContain('bytes collapsed');
    expect(tools[5]?.content).toBe('BODY-5'.repeat(20));
    expect(tools[7]?.content).toBe('BODY-7'.repeat(20));
  });

  test('explicit trimToolResultsAfter override is honoured', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      trimToolResultsAfter: 1, // keep only the most recent tool message
    });

    const messages: Message[] = [
      userMsg('go'),
      asstWithToolCalls([
        { id: 'c-0', name: 'read_file', arguments: { path: 'a.ts' } },
        { id: 'c-1', name: 'read_file', arguments: { path: 'b.ts' } },
        { id: 'c-2', name: 'read_file', arguments: { path: 'c.ts' } },
      ]),
      toolReply('c-0', 'read_file', 'A'.repeat(50)),
      toolReply('c-1', 'read_file', 'B'.repeat(50)),
      toolReply('c-2', 'read_file', 'C'.repeat(50)),
    ];
    await adapter.streamChat({ messages });

    const wireMsgs = (
      captured.body as { messages: Array<{ role: string; content: string }> }
    ).messages;
    const tools = wireMsgs.filter((m) => m.role === 'tool');
    expect(tools[0]?.content).toContain('bytes collapsed');
    expect(tools[1]?.content).toContain('bytes collapsed');
    expect(tools[2]?.content).toBe('C'.repeat(50));
  });

  test('Infinity disables the trim entirely', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      trimToolResultsAfter: Number.POSITIVE_INFINITY,
    });

    const messages: Message[] = [
      userMsg('go'),
      asstWithToolCalls([
        { id: 'c-0', name: 'read_file', arguments: { path: 'a.ts' } },
        { id: 'c-1', name: 'read_file', arguments: { path: 'b.ts' } },
      ]),
      toolReply('c-0', 'read_file', 'A'.repeat(50)),
      toolReply('c-1', 'read_file', 'B'.repeat(50)),
    ];
    await adapter.streamChat({ messages });

    const wireMsgs = (
      captured.body as { messages: Array<{ role: string; content: string }> }
    ).messages;
    const tools = wireMsgs.filter((m) => m.role === 'tool');
    // No collapse — both tool messages verbatim.
    expect(tools[0]?.content).toBe('A'.repeat(50));
    expect(tools[1]?.content).toBe('B'.repeat(50));
  });
});

// ---------- ROADMAP #6 — chunk batching ----------

describe('LLMAdapter — chunk batching (R26 #6)', () => {
  afterEach(() => restoreFetch());

  test('batches multiple small deltas into fewer onChunk fires', async () => {
    // 10 single-char deltas + a stop frame. With a 30ms window and no
    // newline, the first delta fires immediately; the rest coalesce
    // into one or a few flushes.
    installFetch(async () => {
      const frames: string[] = [];
      for (const c of 'abcdefghij') {
        frames.push(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: c } }],
          })}\n\n`,
        );
      }
      frames.push(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      );
      frames.push('data: [DONE]\n\n');
      return sseResponse(frames);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      chunkBatchMs: 30,
    });

    const calls: string[] = [];
    await adapter.streamChat({
      messages: [userMsg('hi')],
      onChunk: (text) => calls.push(text),
    });

    // The total text reached the user.
    expect(calls.join('')).toBe('abcdefghij');
    // Far fewer than 10 calls — first delta + at most a few coalesced
    // flushes. Strict bound: <= 5 calls.
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(calls.length).toBeGreaterThan(0);
  });

  test('first delta always fires immediately (no perceived latency)', async () => {
    installFetch(async () => {
      return sseResponse([
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: 'X' } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: 'Y' } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      chunkBatchMs: 200, // long window — should NOT delay the first delta
    });

    const calls: Array<{ text: string; at: number }> = [];
    const startedAt = Date.now();
    await adapter.streamChat({
      messages: [userMsg('hi')],
      onChunk: (text) => calls.push({ text, at: Date.now() - startedAt }),
    });

    expect(calls.length).toBeGreaterThan(0);
    // The first call lands well under the 200ms window — server is local
    // and the first push always flushes. <100ms is generous.
    const first = calls[0];
    expect(first).toBeDefined();
    expect(first!.at).toBeLessThan(150);
    // Total visible text stays correct.
    expect(calls.map((c) => c.text).join('')).toBe('XY');
  });

  test('newline triggers an immediate flush', async () => {
    installFetch(async () => {
      return sseResponse([
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: 'first' } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: '\nsecond' } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      chunkBatchMs: 5_000, // huge window — only newline / first / end can flush
    });

    const calls: string[] = [];
    await adapter.streamChat({
      messages: [userMsg('hi')],
      onChunk: (t) => calls.push(t),
    });

    expect(calls.join('')).toBe('first\nsecond');
    // 'first' → first-push flush. '\nsecond' → newline flush. Then
    // the stream-end flush has nothing left (already flushed).
    expect(calls.length).toBe(2);
  });

  test('chunkBatchMs=0 disables batching (every delta fires)', async () => {
    installFetch(async () => {
      const frames: string[] = [];
      for (const c of 'abc') {
        frames.push(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: c } }],
          })}\n\n`,
        );
      }
      frames.push(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      );
      frames.push('data: [DONE]\n\n');
      return sseResponse(frames);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      chunkBatchMs: 0,
    });

    const calls: string[] = [];
    await adapter.streamChat({
      messages: [userMsg('hi')],
      onChunk: (t) => calls.push(t),
    });

    expect(calls).toEqual(['a', 'b', 'c']);
  });

  test('stream-end always drains the batcher', async () => {
    // Single delta that's small enough to be held by the buffer; the
    // stream then ends without emitting a newline. Final flush in
    // `runStreamOnce`'s finally must drain the buffer or the user
    // would lose the tail.
    installFetch(async () => {
      return sseResponse([
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: 'X' } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: 'TAIL' } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      chunkBatchMs: 5_000,
    });

    const calls: string[] = [];
    await adapter.streamChat({
      messages: [userMsg('hi')],
      onChunk: (t) => calls.push(t),
    });

    expect(calls.join('')).toBe('XTAIL');
  });
});

// ---------- ROADMAP #12 — JSON mode ----------

describe('LLMAdapter — JSON mode for tool calls (R26 #12)', () => {
  afterEach(() => restoreFetch());

  test('useJsonMode + tools → response_format injected', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      useJsonMode: true,
    });

    const params: StreamChatParams = {
      messages: [userMsg('go')],
      tools: [fakeToolSchema],
    };
    await adapter.streamChat(params);

    const body = captured.body as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  test('useJsonMode WITHOUT tools → response_format is NOT injected', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      useJsonMode: true,
    });

    await adapter.streamChat({ messages: [userMsg('plain text')] });

    const body = captured.body as Record<string, unknown>;
    expect(body.response_format).toBeUndefined();
  });

  test('useJsonMode default (false) does NOT inject the field even with tools', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
    });

    await adapter.streamChat({
      messages: [userMsg('go')],
      tools: [fakeToolSchema],
    });

    const body = captured.body as Record<string, unknown>;
    expect(body.response_format).toBeUndefined();
  });
});

// ---------- ROADMAP #13 — adaptive temperature ----------

describe('inferTemperatureForTask (R26 #13)', () => {
  test('coding verb → temperature 0.1', () => {
    expect(
      inferTemperatureForTask([userMsg('write a sort function')], 0.7),
    ).toBe(0.1);
    expect(
      inferTemperatureForTask([userMsg('implement caching here')], 0.7),
    ).toBe(0.1);
    expect(
      inferTemperatureForTask([userMsg('fix the off-by-one bug')], 0.7),
    ).toBe(0.1);
  });

  test('Russian coding verb → 0.1', () => {
    expect(inferTemperatureForTask([userMsg('напиши функцию sort')], 0.7))
      .toBe(0.1);
    expect(inferTemperatureForTask([userMsg('исправь баг здесь')], 0.7))
      .toBe(0.1);
  });

  test('brainstorm verb → preserve baseTemp', () => {
    expect(
      inferTemperatureForTask([userMsg('explain how closures work')], 0.7),
    ).toBe(0.7);
    expect(
      inferTemperatureForTask([userMsg('почему React медленный?')], 0.7),
    ).toBe(0.7);
  });

  test('tool-call in flight → temperature 0.0', () => {
    const toolCall: ToolCall = {
      id: 'c-0',
      name: 'read_file',
      arguments: { path: 'a.ts' },
    };
    const messages: Message[] = [
      userMsg('look at the file'),
      asstWithToolCalls([toolCall]),
      // No tool reply yet — model is mid-flight.
    ];
    expect(inferTemperatureForTask(messages, 0.7)).toBe(0);
  });

  test('tool-call already replied to → not 0', () => {
    const toolCall: ToolCall = {
      id: 'c-0',
      name: 'read_file',
      arguments: { path: 'a.ts' },
    };
    const messages: Message[] = [
      userMsg('look'),
      asstWithToolCalls([toolCall]),
      toolReply('c-0', 'read_file', '...'),
    ];
    // The last user message is the original — "look" doesn't match a
    // coding verb, so we fall through to baseTemp.
    expect(inferTemperatureForTask(messages, 0.7)).toBe(0.7);
  });

  test('no clear signal → preserve baseTemp', () => {
    expect(inferTemperatureForTask([userMsg('hello')], 0.5)).toBe(0.5);
  });

  test('empty messages → preserve baseTemp', () => {
    expect(inferTemperatureForTask([], 0.5)).toBe(0.5);
  });

  test('NaN / negative baseTemp → conservative 0.2 fallback', () => {
    expect(inferTemperatureForTask([userMsg('hi')], Number.NaN)).toBe(0.2);
    expect(inferTemperatureForTask([userMsg('hi')], -1)).toBe(0.2);
  });

  test('"explain" in the middle of a coding sentence → still coding (verb match wins by order)', () => {
    // "implement and explain" — coding regex hits first.
    expect(
      inferTemperatureForTask([userMsg('implement and explain it')], 0.7),
    ).toBe(0.1);
  });
});

describe('LLMAdapter — adaptiveTemperature wired into request body (R26 #13)', () => {
  afterEach(() => restoreFetch());

  test('LM Studio: top-level temperature gets adapted on coding prompt', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      adaptiveTemperature: true,
      generation: {
        temperature: 0.7,
        topP: 0.9,
        repeatPenalty: 1.0,
        maxTokens: 256,
      },
    });

    await adapter.streamChat({
      messages: [userMsg('write a sort function')],
    });

    const body = captured.body as Record<string, unknown>;
    expect(body.temperature).toBe(0.1);
  });

  test('Ollama: options.temperature gets adapted', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:11434',
      model: 'test',
      backend: 'ollama',
      maxAttempts: 1,
      initialBackoffMs: 1,
      adaptiveTemperature: true,
      generation: {
        temperature: 0.7,
        topP: 0.9,
        repeatPenalty: 1.0,
        maxTokens: 256,
      },
    });

    await adapter.streamChat({
      messages: [userMsg('refactor the resolver')],
    });

    const body = captured.body as { options?: Record<string, unknown> };
    expect(body.options?.temperature).toBe(0.1);
  });

  test('default (adaptiveTemperature=false) preserves the static generation.temperature', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      generation: {
        temperature: 0.7,
        topP: 0.9,
        repeatPenalty: 1.0,
        maxTokens: 256,
      },
    });

    await adapter.streamChat({
      messages: [userMsg('write code please')],
    });

    const body = captured.body as Record<string, unknown>;
    // adaptiveTemperature was off — the static value wins.
    expect(body.temperature).toBe(0.7);
  });

  test('brainstorm prompt with adaptive on → preserves baseTemp', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    installFetch(captureBodyFetch(captured));

    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      backend: 'lmstudio',
      maxAttempts: 1,
      initialBackoffMs: 1,
      adaptiveTemperature: true,
      generation: {
        temperature: 0.7,
        topP: 0.9,
        repeatPenalty: 1.0,
        maxTokens: 256,
      },
    });

    await adapter.streamChat({
      messages: [userMsg('explain why monads are useful')],
    });

    const body = captured.body as Record<string, unknown>;
    expect(body.temperature).toBe(0.7);
  });
});
