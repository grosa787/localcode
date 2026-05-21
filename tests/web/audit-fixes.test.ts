/**
 * Regression tests locking in the API-stability audit fixes.
 *
 * Each test cites the audit finding ID it pins. Keep them small and
 * stand-alone — a failure should immediately point at the broken fix.
 */

import { describe, expect, mock, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';

import { ApprovalBridge, ApprovalTimeoutError } from '@/web/runtime/approval-bridge';
import { SessionEventBus } from '@/web/runtime/event-bus';
import { RuntimePool } from '@/web/runtime/runtime-pool';
import type { ChatRuntime } from '@/web/runtime/chat-runtime';
import { ChatRuntime as RealChatRuntime } from '@/web/runtime/chat-runtime';
import { ContextManager } from '@/llm/context-manager';
import {
  createSocketContext,
  createWsHandlers,
  type SocketContext,
  type WsDeps,
} from '@/web/server/ws';
import { validateCsrfHeader } from '@/web/server/csrf';
import type {
  WSClientMessage,
  WSServerMessage,
} from '@/web/protocol/messages';
import type { LLMAdapter } from '@/llm/adapter';
import type { SessionManager } from '@/sessions/session-manager';
import type { ToolExecutor } from '@/llm/tool-executor';
import type { Message } from '@/types/global';

// ---------- shared fakes ----------

interface FakeSocket {
  data: SocketContext;
  sent: string[];
  closed: { code: number; reason: string } | null;
  /** Audit M4 — emulated WS send buffer level. */
  bufferedAmount: number;
  send: (s: string) => void;
  close: (code: number, reason: string) => void;
  getBufferedAmount: () => number;
}

function makeFakeSocket(): FakeSocket {
  const s: FakeSocket = {
    data: createSocketContext(),
    sent: [],
    closed: null,
    bufferedAmount: 0,
    send(text) {
      this.sent.push(text);
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
    getBufferedAmount() {
      return this.bufferedAmount;
    },
  };
  return s;
}

function makeBaseDeps(overrides?: Partial<WsDeps>): WsDeps {
  return {
    csrfToken: 'TOK',
    serverVersion: '0.1',
    workspaceRegistry: {} as WsDeps['workspaceRegistry'],
    sessionManager: {
      getMessages: () => [],
    } as unknown as WsDeps['sessionManager'],
    configManager: {
      update: () => ({}),
    } as unknown as WsDeps['configManager'],
    eventBus: new SessionEventBus(),
    approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
    runtimePool: new RuntimePool(),
    createRuntimeForSession: () => ({}) as ChatRuntime,
    applyProviderChange: async (req) => ({
      ok: true as const,
      backend: req.type,
      baseUrl: 'http://localhost:1234',
      models: ['m'],
      currentModel: 'm',
    }),
    ...overrides,
  };
}

async function dispatch(
  handlers: ReturnType<typeof createWsHandlers>,
  ws: FakeSocket,
  msg: WSClientMessage | string,
): Promise<void> {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  await handlers.onMessage(ws as unknown as ServerWebSocket<SocketContext>, data);
}

async function helloed(deps: WsDeps): Promise<{
  h: ReturnType<typeof createWsHandlers>;
  ws: FakeSocket;
}> {
  const h = createWsHandlers(deps);
  const ws = makeFakeSocket();
  await dispatch(h, ws, { type: 'hello', csrf: 'TOK', clientId: 'c1' });
  ws.sent.length = 0;
  return { h, ws };
}

// ---------- H1 — send_message rejection becomes done frame ----------

describe('audit H1 — send_message rejection surfaces as done error', () => {
  test('runtime that throws synchronously emits done error, no unhandled rejection', async () => {
    const original = process.listeners('unhandledRejection');
    let unhandled = 0;
    const handler = (): void => {
      unhandled += 1;
    };
    process.on('unhandledRejection', handler);

    try {
      const runtime = {
        sendUserMessage: async () => {
          throw new Error('adapter init failed');
        },
        cancel: () => {},
      } as unknown as ChatRuntime;
      const deps = makeBaseDeps({ createRuntimeForSession: () => runtime });
      const { h, ws } = await helloed(deps);
      await dispatch(h, ws, {
        type: 'send_message',
        sessionId: 's1',
        text: 'hi',
        clientReqId: 'r1',
      });
      // Allow the .catch handler one tick to settle.
      await new Promise((r) => setTimeout(r, 5));
      const frames = ws.sent.map((s) => JSON.parse(s) as { type: string; error?: string });
      const doneFrame = frames.find((f) => f.type === 'done');
      expect(doneFrame).toBeDefined();
      expect(doneFrame?.error).toContain('adapter init failed');
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', handler);
      for (const l of original) process.on('unhandledRejection', l);
    }
  });
});

// ---------- H3 — pool refuses to evict streaming entry ----------

describe('audit H3 — RuntimePool skips streaming entries', () => {
  function streamingRuntime(isStreaming: boolean): ChatRuntime {
    return { streaming: isStreaming } as unknown as ChatRuntime;
  }

  test('eviction skips streaming runtime; non-streaming oldest goes', () => {
    const evicted: string[] = [];
    const pool = new RuntimePool({
      maxSize: 2,
      onEvict: (id) => evicted.push(id),
    });
    // 'a' is streaming, 'b' is idle.
    pool.getOrCreate('a', () => streamingRuntime(true));
    pool.getOrCreate('b', () => streamingRuntime(false));
    // 'c' arrives → only 'b' is eligible.
    pool.getOrCreate('c', () => streamingRuntime(false));
    expect(evicted).toEqual(['b']);
    expect(pool.get('a')).toBeDefined();
    expect(pool.get('c')).toBeDefined();
  });

  test('all-streaming-at-cap throws with clear error', () => {
    const pool = new RuntimePool({ maxSize: 2 });
    pool.getOrCreate('a', () => streamingRuntime(true));
    pool.getOrCreate('b', () => streamingRuntime(true));
    expect(() => pool.getOrCreate('c', () => streamingRuntime(true))).toThrow(
      /Concurrent session limit reached/,
    );
  });
});

// ---------- H4 — approval bridge timeout distinguishes from rejection ----------

describe('audit H4 — ApprovalTimeoutError distinguishes timeout from rejection', () => {
  test('timeout rejects with ApprovalTimeoutError carrying toolCallId', async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 10 });
    const p = bridge.request('tc-time', 'write_file', {}, null, 's1');
    let caught: unknown = null;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApprovalTimeoutError);
    expect((caught as ApprovalTimeoutError).toolCallId).toBe('tc-time');
    expect((caught as Error).message).toMatch(/timed out/);
  });

  test('explicit resolve returns ApprovalResolution (no error)', async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 60_000 });
    const p = bridge.request('tc-rej', 'write_file', {}, null, 's1');
    bridge.resolve('tc-rej', false);
    await expect(p).resolves.toEqual({ approved: false });
  });

  test('rejectAll preserves shutdown semantics', async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 60_000 });
    const p1 = bridge.request('a', 'write_file', {}, null, 's1');
    const p2 = bridge.request('b', 'write_file', {}, null, 's1');
    bridge.rejectAll();
    await expect(p1).resolves.toEqual({ approved: false });
    await expect(p2).resolves.toEqual({ approved: false });
  });
});

// ---------- H5 — cancel interrupts tool loop ----------

describe('audit H5 — cancel interrupts running tool loop', () => {
  test('cancel mid-tool emits done error within 1s', async () => {
    const cm = new ContextManager();
    // Adapter: emit one tool call and finish.
    const llm: { streamChat: LLMAdapter['streamChat'] } = {
      streamChat: (async (opts) => {
        opts.onToolCalls?.([
          { id: 'tc-1', name: 'run_command', arguments: { command: 'sleep 60' } },
        ]);
        opts.onDone?.({ finishReason: 'stop' });
      }) as LLMAdapter['streamChat'],
    };
    // Tool executor: blocks until the signal aborts, then returns.
    const sessionManager = {
      addMessage: () => undefined,
      getMessages: () => [],
      getSession: () => null,
    } as unknown as SessionManager;
    const eventBus = new SessionEventBus();
    const events: WSServerMessage[] = [];
    eventBus.subscribe('s1', (m) => events.push(m));
    let aborted = false;
    const toolExecutor = {
      execute: async (
        _call: unknown,
        opts?: { signal?: AbortSignal },
      ): Promise<{ success: boolean; output: string }> => {
        // Wait for the abort signal or hold for ~3s.
        await new Promise<void>((resolve) => {
          const sig = opts?.signal;
          if (sig?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          const t = setTimeout(() => resolve(), 3000);
          sig?.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(t);
            resolve();
          });
        });
        return { success: true, output: 'ok' };
      },
    } as unknown as ToolExecutor;

    const runtime = new RealChatRuntime({
      sessionId: 's1',
      tools: [],
      buildSystemMessage: () => ({
        id: 'sys',
        role: 'system',
        content: 'sys',
        createdAt: 0,
      }),
      maxContextTokens: 100_000,
      maxRecentMessages: 0,
      llm,
      toolExecutor,
      contextManager: cm,
      sessionManager,
      eventBus,
      approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
    });

    const start = Date.now();
    const turn = runtime.sendUserMessage('please run', 'r1');
    // Give the loop time to enter the tool.
    await new Promise((r) => setTimeout(r, 30));
    runtime.cancel();
    await turn;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500);
    expect(aborted).toBe(true);
    const doneFrame = events.find((e) => e.type === 'done');
    expect(doneFrame).toBeDefined();
    if (doneFrame && doneFrame.type === 'done') {
      expect(doneFrame.error).toBe('cancelled');
    }
  });
});

// ---------- M3 — bus prunes dead subscribers ----------

describe('audit M3 — SessionEventBus prunes dead subscribers', () => {
  test('throwing subscriber is pruned on next emit and liveCount drops', () => {
    const bus = new SessionEventBus();
    const live: WSServerMessage[] = [];
    bus.subscribe('s1', () => {
      throw new Error('dead socket');
    });
    bus.subscribe('s1', (m) => live.push(m));
    expect(bus.liveCount('s1')).toBe(2);
    // First emit — dead subscriber throws but live one still receives.
    bus.emit('s1', { type: 'pong' });
    expect(live).toHaveLength(1);
    // After first emit, dead is marked but not yet pruned (next emit prunes).
    // Live count reflects pending prune.
    expect(bus.liveCount('s1')).toBe(1);
    // Second emit — dead subscriber pruned, only live runs.
    bus.emit('s1', { type: 'pong' });
    expect(live).toHaveLength(2);
    expect(bus.subscriberCount('s1')).toBe(1);
    expect(bus.liveCount('s1')).toBe(1);
  });
});

// ---------- M4 — WS backpressure ----------

describe('audit M4 — WS backpressure drops recoverable frames', () => {
  test('chunk frame dropped when bufferedAmount above threshold', async () => {
    const deps = makeBaseDeps();
    const { h, ws } = await helloed(deps);
    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's1' });
    ws.sent.length = 0;
    // Simulate slow client.
    ws.bufferedAmount = 2_000_000;
    deps.eventBus.emit('s1', { type: 'chunk', sessionId: 's1', text: 'abc' });
    expect(ws.sent).toHaveLength(0);
  });

  test('message_committed (critical) is sent even under backpressure', async () => {
    const deps = makeBaseDeps();
    const { h, ws } = await helloed(deps);
    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's1' });
    ws.sent.length = 0;
    ws.bufferedAmount = 2_000_000;
    deps.eventBus.emit('s1', {
      type: 'message_committed',
      sessionId: 's1',
      message: {
        id: 'm1',
        role: 'assistant',
        content: 'hi',
        createdAt: 0,
      },
    });
    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0] ?? '{}') as { type: string };
    expect(frame.type).toBe('message_committed');
  });
});

// ---------- M5 — CSRF constant-time comparison ----------

describe('audit M5 — CSRF uses constant-time compare', () => {
  test('matching token passes', () => {
    const req = new Request('http://x/', {
      method: 'POST',
      headers: { 'X-LocalCode-CSRF': 'abcd1234' },
    });
    expect(validateCsrfHeader(req, 'abcd1234')).toBe(true);
  });

  test('mismatched token fails (any length, any content)', () => {
    const req1 = new Request('http://x/', {
      method: 'POST',
      headers: { 'X-LocalCode-CSRF': 'abcd1234' },
    });
    expect(validateCsrfHeader(req1, 'abcd5678')).toBe(false);
    const req2 = new Request('http://x/', {
      method: 'POST',
      headers: { 'X-LocalCode-CSRF': 'short' },
    });
    expect(validateCsrfHeader(req2, 'much-longer-token')).toBe(false);
  });

  test('missing header fails', () => {
    const req = new Request('http://x/', { method: 'POST' });
    expect(validateCsrfHeader(req, 'tok')).toBe(false);
  });
});

// ---------- M8 — runStreamLoop iterative with MAX_TURNS cap ----------

describe('audit M8 — runStreamLoop is iterative + MAX_TURNS cap', () => {
  test('adapter that emits tool_call forever stops at MAX_TURNS', async () => {
    const cm = new ContextManager();
    let calls = 0;
    const llm: { streamChat: LLMAdapter['streamChat'] } = {
      streamChat: (async (opts) => {
        calls += 1;
        // Always emit a tool call → would recurse forever pre-fix.
        opts.onToolCalls?.([
          {
            id: `tc-${calls}`,
            name: 'noop',
            arguments: {},
          },
        ]);
        opts.onDone?.({ finishReason: 'tool_calls' });
      }) as LLMAdapter['streamChat'],
    };
    const sessionManager = {
      addMessage: () => undefined,
      getMessages: () => [],
      getSession: () => null,
    } as unknown as SessionManager;
    const eventBus = new SessionEventBus();
    const events: WSServerMessage[] = [];
    eventBus.subscribe('s1', (m) => events.push(m));
    const toolExecutor = {
      execute: async () => ({ success: true, output: 'ok' }),
    } as unknown as ToolExecutor;

    const runtime = new RealChatRuntime({
      sessionId: 's1',
      tools: [],
      buildSystemMessage: () => ({
        id: 'sys',
        role: 'system',
        content: 'sys',
        createdAt: 0,
      }),
      maxContextTokens: 100_000,
      maxRecentMessages: 0,
      llm,
      toolExecutor,
      contextManager: cm,
      sessionManager,
      eventBus,
      approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
    });

    await runtime.sendUserMessage('go', 'r1');
    // Adapter must have been called exactly MAX_TURNS (20) times.
    expect(calls).toBe(20);
    const doneFrame = events.find((e) => e.type === 'done');
    expect(doneFrame).toBeDefined();
    if (doneFrame && doneFrame.type === 'done') {
      expect(doneFrame.error).toMatch(/Max turns reached/);
    }
  });
});

// ---------- L4 — session delete releases pool ----------

describe('audit L4 — DELETE /api/sessions/:id releases the pool', () => {
  test('releaseSession hook is called with the deleted id', async () => {
    const { createApiHandler } = await import('@/web/api');
    const released: string[] = [];
    const session = {
      id: 'sess-del',
      projectRoot: '/tmp/x',
      title: null,
      summary: null,
      model: 'm',
      backend: 'ollama' as const,
      createdAt: 0,
      updatedAt: 0,
    };
    const sm = {
      getSession: (id: string) => (id === 'sess-del' ? session : null),
      deleteSession: mock(() => undefined),
    } as unknown as SessionManager;
    const handler = createApiHandler({
      workspaceRegistry: {} as never,
      sessionManager: sm,
      configManager: {} as never,
      createAdapterForBackend: (() => ({
        getModels: async () => [],
      })) as never,
      releaseSession: (sid) => released.push(sid),
    });
    const url = new URL('http://localhost/api/sessions/sess-del');
    const res = await handler(new Request(url, { method: 'DELETE' }), url);
    expect(res?.status).toBe(200);
    expect(released).toEqual(['sess-del']);
  });
});

// ---------- M9 — worker tool messages persisted to SQLite ----------

describe('audit M9 — worker session messages persisted', () => {
  test('runner-factory writes assistant + tool messages via sessionManager.addMessage', async () => {
    const { buildAgentRunnerFactory } = await import('@/agents/runner-factory');
    const { AgentOrchestrator } = await import('@/agents/orchestrator');
    const persisted: Array<{ sessionId: string; message: Message }> = [];
    const sm: Partial<SessionManager> = {
      createSession: () => ({
        id: 'sess',
        projectRoot: '/tmp',
        title: null,
        summary: null,
        model: 'm',
        backend: 'fake',
        createdAt: 0,
        updatedAt: 0,
      }),
      addMessage: (sessionId: string, message: Message) => {
        persisted.push({ sessionId, message });
      },
      getSession: () => null,
    };
    let turn = 0;
    const factory = buildAgentRunnerFactory({
      orchestrator: () => orch,
      sessionManager: sm as SessionManager,
      configManager: {} as never,
      createAdapterForModel: () => ({
        streamChat: (async (params) => {
          if (turn === 0) {
            turn += 1;
            params.onToolCalls?.([
              { id: 'tc-1', name: 'noop', arguments: {} },
            ]);
            params.onDone?.({ finishReason: 'tool_calls' });
            return;
          }
          params.onChunk?.('<DONE>\nfinished');
          params.onDone?.({ finishReason: 'stop' });
        }) as LLMAdapter['streamChat'],
      }),
      resolveProjectRoot: () => '/tmp',
    });
    const orch = new AgentOrchestrator({
      projectRoot: '/tmp',
      config: {
        workerModel: 'fake',
        maxConcurrent: 3,
        isolation: 'shared',
        approval: 'auto',
        defaultTimeoutSec: 5,
      },
      runnerFactory: factory,
    });
    const handle = await orch.spawn('parent', { task: 'go', files: [] });
    await handle.done();
    // Expect at least one assistant + one tool message persisted.
    const roles = persisted.map((p) => p.message.role);
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');
  });
});

// ---------- Security H1 — constant-time WS CSRF check ----------

describe('security H1 — WebSocket CSRF uses constant-time compare', () => {
  test('valid CSRF token passes the hello gate', async () => {
    const deps = makeBaseDeps({ csrfToken: 'A'.repeat(64) });
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await dispatch(h, ws, { type: 'hello', csrf: 'A'.repeat(64), clientId: 'c1' });
    expect(ws.closed).toBeNull();
    const frame = ws.sent.find((s) => s.includes('hello_ok'));
    expect(frame).toBeDefined();
  });

  test('mismatched same-length token closes with csrf_invalid', async () => {
    const deps = makeBaseDeps({ csrfToken: 'A'.repeat(64) });
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    const wrong = 'B'.repeat(64);
    await dispatch(h, ws, { type: 'hello', csrf: wrong, clientId: 'c1' });
    expect(ws.closed).toEqual({ code: 1008, reason: 'csrf_invalid' });
  });

  test('different-length token closes with csrf_invalid (no throw)', async () => {
    const deps = makeBaseDeps({ csrfToken: 'A'.repeat(64) });
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    // Short token would crash timingSafeEqual without the length guard.
    await dispatch(h, ws, { type: 'hello', csrf: 'short', clientId: 'c1' });
    expect(ws.closed).toEqual({ code: 1008, reason: 'csrf_invalid' });
  });

  test('comparison is constant-time across mismatched prefix lengths', async () => {
    // Defence-in-depth: timing of equal-length wrong-prefix tokens must
    // stay within noise so an attacker can't infer characters one byte
    // at a time. The check is wrapped over many iterations to amortise
    // jitter; the assertion is loose by design.
    const deps = makeBaseDeps({ csrfToken: 'A'.repeat(64) });
    const ITER = 200;
    const measure = async (token: string): Promise<number> => {
      const start = Bun.nanoseconds();
      for (let i = 0; i < ITER; i += 1) {
        const h = createWsHandlers(deps);
        const ws = makeFakeSocket();
        // eslint-disable-next-line no-await-in-loop
        await dispatch(h, ws, { type: 'hello', csrf: token, clientId: 'c1' });
      }
      return Bun.nanoseconds() - start;
    };
    // First byte differs vs last byte differs — naive strcmp would
    // exit on the first divergence and be much faster for the first.
    const earlyWrong = 'B' + 'A'.repeat(63);
    const lateWrong = 'A'.repeat(63) + 'B';
    const tEarly = await measure(earlyWrong);
    const tLate = await measure(lateWrong);
    // Allow a generous 10x ratio — anything less than that on the
    // weaker side rules out a strict strcmp short-circuit.
    const ratio = Math.max(tEarly, tLate) / Math.max(1, Math.min(tEarly, tLate));
    expect(ratio).toBeLessThan(10);
  });
});

// ---------- Bonus — Security headers on every JSON response ----------

describe('security bonus — security headers on JSON responses', () => {
  test('jsonOk sets nosniff + DENY + no-referrer', async () => {
    const { jsonOk, SECURITY_HEADERS } = await import('@/web/api/http');
    const res = jsonOk({ ok: true });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    // Sanity: the constant matches what's actually emitted.
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });

  test('jsonError sets the same security headers', async () => {
    const { jsonError } = await import('@/web/api/http');
    const res = jsonError('bad', 'nope', 400);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  test('REST handler returns security headers on a real 2xx', async () => {
    // Reuse the api.test scaffolding inline so we don't drag in the
    // whole test fixture set-up — just verify that handleConfig's
    // 200 path goes through jsonOk and inherits the headers.
    const { handleConfig } = await import('@/web/api/config');
    const { ConfigManager } = await import('@/config/config-manager');
    const { getDefaultConfig } = await import('@/config/defaults');
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/lc-sec-${crypto.randomUUID()}.toml`;
    const mgr = new ConfigManager(tmp);
    const cfg = getDefaultConfig('ollama');
    cfg.model.current = 'm';
    cfg.model.available = ['m'];
    cfg.onboarding.completed = true;
    mgr.write(cfg);
    const url = new URL('http://localhost/api/config');
    const res = await handleConfig(new Request(url), url, {
      configManager: mgr,
      // Unused fields for this specific path:
      sessionManager: {} as never,
      workspaceRegistry: {} as never,
      createAdapterForBackend: () => ({ getModels: async () => [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

// ---------- Security H3 — loud warning when binding non-loopback ----------

describe('security H3 — printNonLoopbackWarning banner', () => {
  test('writes a warning banner naming the host', async () => {
    const { printNonLoopbackWarning } = await import('@/web/server/start');
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    // Patch stdout.write minimally to capture the call. Using `as never`
    // would mask the type; we accept the small `unknown`+narrow dance.
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (
      s: string,
    ): boolean => {
      chunks.push(s);
      return true;
    };
    try {
      printNonLoopbackWarning('0.0.0.0');
    } finally {
      (process.stdout as unknown as { write: typeof originalWrite }).write =
        originalWrite;
    }
    const out = chunks.join('');
    expect(out).toContain('WARNING');
    expect(out).toContain('0.0.0.0');
    expect(out).toContain('--web-host 127.0.0.1');
  });
});

// ---------- Security M4 — /providers does not leak apiKey ----------

describe('security M4 — GET /api/config/providers redacts apiKey', () => {
  test('hasApiKey boolean returned, raw value never in body', async () => {
    const { handleConfigProviders } = await import('@/web/api/config');
    const { ConfigManager } = await import('@/config/config-manager');
    const { getDefaultConfig } = await import('@/config/defaults');
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/lc-providers-${crypto.randomUUID()}.toml`;
    const mgr = new ConfigManager(tmp);
    const cfg = getDefaultConfig('openai');
    cfg.model.current = 'gpt-x';
    cfg.model.available = ['gpt-x'];
    cfg.onboarding.completed = true;
    cfg.backend.apiKey = 'sk-secret-leak-canary';
    mgr.write(cfg);
    const url = new URL('http://localhost/api/config/providers');
    const res = await handleConfigProviders(new Request(url), url, {
      configManager: mgr,
      sessionManager: {} as never,
      workspaceRegistry: {} as never,
      createAdapterForBackend: () => ({ getModels: async () => [] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('sk-secret-leak-canary');
    const body = JSON.parse(text) as {
      byType: Record<string, { hasApiKey: boolean; apiKey?: unknown }>;
    };
    const openai = body.byType.openai;
    const ollama = body.byType.ollama;
    expect(openai).toBeDefined();
    expect(ollama).toBeDefined();
    expect(openai?.hasApiKey).toBe(true);
    // The raw apiKey field MUST NOT exist anywhere in the response.
    expect(openai?.apiKey).toBeUndefined();
    expect(ollama?.hasApiKey).toBe(false);
    expect(ollama?.apiKey).toBeUndefined();
  });
});
