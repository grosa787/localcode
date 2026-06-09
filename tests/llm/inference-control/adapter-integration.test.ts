/**
 * Wave 16B — adapter integration tests for inference-control.
 *
 * Verifies that the per-REQUEST body carries `grammar` / `logit_bias` /
 * `cache_prompt` ONLY when:
 *   - the backend is local (lmstudio/ollama/custom), AND
 *   - the capability report says the knob is supported, AND
 *   - the `inference.*` mode is not 'off'.
 * And NEVER for cloud backends. Crucially the knobs land in the request
 * body, NOT the system prompt — the byte-stable prefix cache is untouched.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LLMAdapter } from '@/llm/adapter';
import type { InferenceControlConfig } from '@/llm/adapter';
import type { CapabilityReport } from '@/llm/inference-control';
import { compileToolGrammar } from '@/llm/inference-control';
import { TOOLS_SCHEMA } from '@/llm/tools-schema';
import type { Backend, Message } from '@/types/global';
import type { StreamDoneResult, ToolSchema } from '@/types/message';

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

function sseTextThenStop(): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
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

function recordingFetch(): { fetchImpl: FetchImpl; bodies: () => unknown[] } {
  const bodies: unknown[] = [];
  const fetchImpl: FetchImpl = async (_url, init) => {
    if (typeof init?.body === 'string') {
      try {
        bodies.push(JSON.parse(init.body));
      } catch {
        bodies.push(null);
      }
    }
    return sseTextThenStop();
  };
  return { fetchImpl, bodies: () => bodies };
}

function report(overrides: Partial<CapabilityReport>): CapabilityReport {
  return {
    grammar: true,
    jsonSchema: true,
    logitBias: true,
    cachePrompt: true,
    probedAt: Date.now(),
    backend: 'lmstudio',
    model: 'qwen',
    ...overrides,
  };
}

function inference(
  overrides: Partial<InferenceControlConfig>,
): InferenceControlConfig {
  return {
    report: report({}),
    grammarLock: 'auto',
    logitBanlist: 'auto',
    toolGrammar: compileToolGrammar(TOOLS_SCHEMA).gbnf,
    logitBias: { 100: 1.5 },
    ...overrides,
  };
}

const tool: ToolSchema = TOOLS_SCHEMA[0] as ToolSchema;

function userMsg(content: string): Message {
  return { id: 'm-1', role: 'user', content, createdAt: 0 };
}

async function runOnce(
  adapter: LLMAdapter,
  withTools: boolean,
): Promise<void> {
  let done: StreamDoneResult | null = null;
  await adapter.streamChat({
    messages: [userMsg('hi')],
    tools: withTools ? [tool] : undefined,
    onDone: (r) => {
      done = r;
    },
  });
  expect(done).not.toBeNull();
}

function lastBody(bodies: unknown[]): Record<string, unknown> {
  expect(bodies.length).toBeGreaterThan(0);
  const b = bodies[bodies.length - 1];
  expect(b && typeof b === 'object').toBe(true);
  return b as Record<string, unknown>;
}

describe('adapter — inference-control integration', () => {
  afterEach(() => restoreFetch());

  test('local backend + supported + enabled → grammar in request body', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen',
      backend: 'lmstudio',
      maxAttempts: 1,
      inference: inference({}),
    });
    await runOnce(adapter, /*withTools*/ true);
    const body = lastBody(bodies());
    expect(typeof body.grammar).toBe('string');
    expect(String(body.grammar)).toContain('root ::=');
    expect(body.logit_bias).toEqual({ 100: 1.5 });
    expect(body.cache_prompt).toBe(true);
  });

  test('cloud backend → NO grammar / logit_bias / cache_prompt', async () => {
    const clouds: Backend[] = ['openai', 'openrouter', 'google'];
    for (const backend of clouds) {
      const { fetchImpl, bodies } = recordingFetch();
      installFetch(fetchImpl);
      const adapter = new LLMAdapter({
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt',
        backend,
        apiKey: 'sk',
        maxAttempts: 1,
        // Even with a (nonsensical) all-true report, cloud must be excluded.
        inference: inference({ report: report({ backend }) }),
      });
      await runOnce(adapter, /*withTools*/ true);
      const body = lastBody(bodies());
      expect('grammar' in body).toBe(false);
      expect('logit_bias' in body).toBe(false);
      expect('cache_prompt' in body).toBe(false);
    }
  });

  test('grammar omitted when report.grammar is false', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen',
      backend: 'lmstudio',
      maxAttempts: 1,
      inference: inference({ report: report({ grammar: false }) }),
    });
    await runOnce(adapter, /*withTools*/ true);
    const body = lastBody(bodies());
    expect('grammar' in body).toBe(false);
    // logit_bias + cache_prompt still attached (their report bits are true).
    expect(body.logit_bias).toEqual({ 100: 1.5 });
    expect(body.cache_prompt).toBe(true);
  });

  test("grammarLock: 'off' suppresses grammar even when supported", async () => {
    const { fetchImpl, bodies } = recordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen',
      backend: 'lmstudio',
      maxAttempts: 1,
      inference: inference({ grammarLock: 'off' }),
    });
    await runOnce(adapter, /*withTools*/ true);
    const body = lastBody(bodies());
    expect('grammar' in body).toBe(false);
  });

  test("logitBanlist: 'off' suppresses logit_bias", async () => {
    const { fetchImpl, bodies } = recordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen',
      backend: 'lmstudio',
      maxAttempts: 1,
      inference: inference({ logitBanlist: 'off' }),
    });
    await runOnce(adapter, /*withTools*/ true);
    const body = lastBody(bodies());
    expect('logit_bias' in body).toBe(false);
  });

  test('grammar omitted when no tools present', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen',
      backend: 'lmstudio',
      maxAttempts: 1,
      inference: inference({}),
    });
    await runOnce(adapter, /*withTools*/ false);
    const body = lastBody(bodies());
    expect('grammar' in body).toBe(false);
    // cache_prompt is tool-independent and still attaches.
    expect(body.cache_prompt).toBe(true);
  });

  test('no inference config → legacy body (no new fields)', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen',
      backend: 'lmstudio',
      maxAttempts: 1,
    });
    await runOnce(adapter, /*withTools*/ true);
    const body = lastBody(bodies());
    expect('grammar' in body).toBe(false);
    expect('logit_bias' in body).toBe(false);
    expect('cache_prompt' in body).toBe(false);
  });

  test('empty logit_bias map is not attached', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen',
      backend: 'lmstudio',
      maxAttempts: 1,
      inference: inference({ logitBias: {} }),
    });
    await runOnce(adapter, /*withTools*/ true);
    const body = lastBody(bodies());
    expect('logit_bias' in body).toBe(false);
  });

  test('inference fields live in body, never in the system message', async () => {
    const { fetchImpl, bodies } = recordingFetch();
    installFetch(fetchImpl);
    const adapter = new LLMAdapter({
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen',
      backend: 'lmstudio',
      maxAttempts: 1,
      inference: inference({}),
    });
    let done: StreamDoneResult | null = null;
    await adapter.streamChat({
      messages: [
        { id: 's', role: 'system', content: 'STABLE SYSTEM PROMPT', createdAt: 0 },
        userMsg('hi'),
      ],
      tools: [tool],
      onDone: (r) => {
        done = r;
      },
    });
    expect(done).not.toBeNull();
    const body = lastBody(bodies());
    const messages = body.messages as { role: string; content: unknown }[];
    const sys = messages.find((m) => m.role === 'system');
    expect(sys).toBeDefined();
    // The system content must be exactly the stable prompt — no grammar /
    // logit data smuggled in.
    expect(sys?.content).toBe('STABLE SYSTEM PROMPT');
  });
});
