/**
 * BrowserSession ↔ ChatRuntime wiring tests.
 *
 * Drives a `ChatRuntime` with a fake LLM that emits a single
 * `browser_navigate` tool call, a no-op `ToolExecutor`, and a scripted
 * fake `BrowserSession`. Asserts that:
 *   - browser_state(starting → ready → navigating → closed) fires
 *   - browser_frame / browser_cursor / browser_console events forward
 *   - user-input forward methods route into the session
 *   - dispose() tears down the subscription
 */

import { describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';

import {
  ChatRuntime,
  type BrowserSession,
  type BrowserSessionSubscribeHandlers,
  type ChatRuntimeDeps,
} from '@/web/runtime/chat-runtime';
import { SessionEventBus } from '@/web/runtime/event-bus';
import { ApprovalBridge } from '@/web/runtime/approval-bridge';
import { RuntimePool } from '@/web/runtime/runtime-pool';
import {
  createSocketContext,
  createWsHandlers,
  type SocketContext,
  type WsDeps,
} from '@/web/server/ws';
import type { Message, ToolCall } from '@/types/global';
import type { WSClientMessage, WSServerMessage } from '@/web/protocol/messages';

// ---------- Fake BrowserSession ----------

interface FakeBrowserSession extends BrowserSession {
  handlers: BrowserSessionSubscribeHandlers | null;
  closed: number;
  clicks: Array<{ x: number; y: number; button?: 'left' | 'right' }>;
  keys: Array<{ key: string; modifiers?: readonly ('shift' | 'ctrl' | 'alt' | 'meta')[] }>;
  scrolls: number[];
}

function makeFakeBrowserSession(): FakeBrowserSession {
  const fake: FakeBrowserSession = {
    handlers: null,
    closed: 0,
    clicks: [],
    keys: [],
    scrolls: [],
    subscribe(handlers) {
      fake.handlers = handlers;
      return () => {
        fake.handlers = null;
      };
    },
    forwardUserClick(x, y, button) {
      fake.clicks.push(button !== undefined ? { x, y, button } : { x, y });
    },
    forwardUserKey(key, modifiers) {
      fake.keys.push(modifiers !== undefined ? { key, modifiers } : { key });
    },
    forwardUserScroll(deltaY) {
      fake.scrolls.push(deltaY);
    },
    close() {
      fake.closed += 1;
    },
  };
  return fake;
}

// ---------- Fake LLM + ToolExecutor + supporting deps ----------

interface ScriptedTurn {
  text?: string;
  toolCalls?: ToolCall[];
}

function makeRuntime(opts: {
  turns: ScriptedTurn[];
  factory: () => BrowserSession;
}): { runtime: ChatRuntime; bus: SessionEventBus; events: WSServerMessage[] } {
  const bus = new SessionEventBus();
  const events: WSServerMessage[] = [];
  bus.subscribe('sess-1', (m) => events.push(m));

  let turn = 0;
  const llm: ChatRuntimeDeps['llm'] = {
    streamChat: async (params) => {
      const t = opts.turns[turn] ?? { text: '' };
      turn += 1;
      if (t.text !== undefined && t.text.length > 0) {
        params.onChunk?.(t.text);
      }
      if (t.toolCalls !== undefined && t.toolCalls.length > 0) {
        params.onToolCalls?.(t.toolCalls);
      }
      params.onDone?.({ finishReason: 'stop' });
    },
  } as ChatRuntimeDeps['llm'];

  const toolExecutor = {
    execute: async (call: ToolCall) => ({
      success: true,
      output: `ran ${call.name}`,
    }),
    setOnAutoCheckResult: () => {},
  } as unknown as ChatRuntimeDeps['toolExecutor'];

  const messages: Message[] = [];
  const contextManager = {
    add: (m: Message) => {
      messages.push(m);
    },
    getMessages: () => messages,
    maybeSummarize: async () => {},
    recordUsage: () => {},
  } as unknown as ChatRuntimeDeps['contextManager'];

  const sessionManager = {
    addMessage: () => {},
    getMessages: () => [],
    getSession: () => null,
  } as unknown as ChatRuntimeDeps['sessionManager'];

  const runtime = new ChatRuntime({
    sessionId: 'sess-1',
    tools: [],
    buildSystemMessage: () =>
      ({ id: 'sys', role: 'system', content: '', createdAt: 0 }) as Message,
    maxContextTokens: 8000,
    llm,
    toolExecutor,
    contextManager,
    sessionManager,
    eventBus: bus,
    approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
    createBrowserSession: opts.factory,
  });

  return { runtime, bus, events };
}

// ---------- Tests ----------

describe('ChatRuntime browser-session lifecycle', () => {
  test('lazy-creates a session on first browser_* tool call and emits state', async () => {
    const fake = makeFakeBrowserSession();
    const { runtime, events } = makeRuntime({
      turns: [
        {
          toolCalls: [
            { id: 't1', name: 'browser_navigate', arguments: { url: 'https://example.com' } },
          ],
        },
        { text: 'done' },
      ],
      factory: () => fake,
    });

    await runtime.sendUserMessage('go', 'req-1');

    const states = events
      .filter((e): e is Extract<WSServerMessage, { type: 'browser_state' }> => e.type === 'browser_state')
      .map((e) => e.status);
    expect(states).toContain('starting');
    expect(states).toContain('navigating');
    expect(runtime.getBrowserSession()).toBe(fake);
  });

  test('forwards onFrame / onCursor / onConsole events as WS frames', async () => {
    const fake = makeFakeBrowserSession();
    const { runtime, events } = makeRuntime({
      turns: [
        {
          toolCalls: [
            { id: 't1', name: 'browser_screenshot', arguments: {} },
          ],
        },
        { text: '' },
      ],
      factory: () => fake,
    });
    await runtime.sendUserMessage('shoot', 'req-1');
    expect(fake.handlers).not.toBeNull();

    fake.handlers?.onFrame?.({
      jpegBase64: 'AAAA',
      width: 800,
      height: 600,
      capturedAt: 1234,
    });
    fake.handlers?.onCursor?.({
      fromX: 1,
      fromY: 2,
      toX: 10,
      toY: 20,
      durationMs: 50,
      action: 'hover',
    });
    fake.handlers?.onConsole?.({ level: 'log', text: 'hi' });

    const types = events.map((e) => e.type);
    expect(types).toContain('browser_frame');
    expect(types).toContain('browser_cursor');
    expect(types).toContain('browser_console');

    // First frame triggers a `ready` state.
    const ready = events.find(
      (e) => e.type === 'browser_state' && e.status === 'ready',
    );
    expect(ready).toBeDefined();
  });

  test('onError emits browser_state error', async () => {
    const fake = makeFakeBrowserSession();
    const { runtime, events } = makeRuntime({
      turns: [{ toolCalls: [{ id: 't1', name: 'browser_navigate', arguments: {} }] }, {}],
      factory: () => fake,
    });
    await runtime.sendUserMessage('go', 'req-1');
    fake.handlers?.onError?.(new Error('crashed'));
    const errState = events.find(
      (e): e is Extract<WSServerMessage, { type: 'browser_state' }> =>
        e.type === 'browser_state' && e.status === 'error',
    );
    expect(errState?.errorMessage).toBe('crashed');
  });

  test('forwardBrowser* routes into the session, returns false when none bound', async () => {
    const fake = makeFakeBrowserSession();
    const { runtime } = makeRuntime({
      turns: [{ toolCalls: [{ id: 't1', name: 'browser_navigate', arguments: {} }] }, {}],
      factory: () => fake,
    });

    // Before any tool call: no session bound.
    expect(await runtime.forwardBrowserClick(1, 2)).toBe(false);

    await runtime.sendUserMessage('go', 'req-1');
    expect(await runtime.forwardBrowserClick(10, 20, 'right')).toBe(true);
    expect(await runtime.forwardBrowserKey('Enter', ['shift'])).toBe(true);
    expect(await runtime.forwardBrowserScroll(-120)).toBe(true);

    expect(fake.clicks).toEqual([{ x: 10, y: 20, button: 'right' }]);
    expect(fake.keys).toEqual([{ key: 'Enter', modifiers: ['shift'] }]);
    expect(fake.scrolls).toEqual([-120]);
  });

  test('closeBrowserSession emits closed state and tears down subscription', async () => {
    const fake = makeFakeBrowserSession();
    const { runtime, events } = makeRuntime({
      turns: [{ toolCalls: [{ id: 't1', name: 'browser_navigate', arguments: {} }] }, {}],
      factory: () => fake,
    });
    await runtime.sendUserMessage('go', 'req-1');
    expect(fake.handlers).not.toBeNull();

    await runtime.closeBrowserSession();
    expect(fake.closed).toBe(1);
    expect(fake.handlers).toBeNull();
    expect(runtime.getBrowserSession()).toBeNull();
    const closed = events.find(
      (e) => e.type === 'browser_state' && e.status === 'closed',
    );
    expect(closed).toBeDefined();
  });
});

// ---------- WS server input dispatch ----------

interface FakeSocket {
  data: SocketContext;
  sent: string[];
  closed: { code: number; reason: string } | null;
  send: (s: string) => void;
  close: (code: number, reason: string) => void;
}
function makeFakeSocket(): FakeSocket {
  return {
    data: createSocketContext(),
    sent: [],
    closed: null,
    send(text) {
      this.sent.push(text);
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
  };
}

describe('WS server browser_user_* dispatch', () => {
  test('forwards click/key/scroll into the bound BrowserSession', async () => {
    const fake = makeFakeBrowserSession();
    const { runtime } = makeRuntime({
      turns: [{ toolCalls: [{ id: 't1', name: 'browser_navigate', arguments: {} }] }, {}],
      factory: () => fake,
    });
    await runtime.sendUserMessage('go', 'req-1');

    const pool = new RuntimePool();
    pool.getOrCreate('sess-1', () => runtime);

    const deps: WsDeps = {
      csrfToken: 'TOK',
      serverVersion: '0.1',
      workspaceRegistry: {} as WsDeps['workspaceRegistry'],
      sessionManager: { getMessages: () => [] } as unknown as WsDeps['sessionManager'],
      configManager: { update: () => ({}) } as unknown as WsDeps['configManager'],
      eventBus: new SessionEventBus(),
      approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
      runtimePool: pool,
      createRuntimeForSession: () => runtime,
      applyProviderChange: async () => ({
        ok: true as const,
        backend: 'ollama',
        baseUrl: 'http://localhost:11434',
        models: ['m1'],
        currentModel: 'm1',
      }),
    };
    const handlers = createWsHandlers(deps);
    const ws = makeFakeSocket();

    async function send(msg: WSClientMessage): Promise<void> {
      await handlers.onMessage(
        ws as unknown as ServerWebSocket<SocketContext>,
        JSON.stringify(msg),
      );
    }
    await send({ type: 'hello', csrf: 'TOK', clientId: 'c1' });
    await send({ type: 'browser_user_click', sessionId: 'sess-1', x: 10, y: 20 });
    await send({
      type: 'browser_user_key',
      sessionId: 'sess-1',
      key: 'a',
      modifiers: ['ctrl'],
    });
    await send({ type: 'browser_user_scroll', sessionId: 'sess-1', deltaY: 50 });

    expect(fake.clicks).toEqual([{ x: 10, y: 20 }]);
    expect(fake.keys).toEqual([{ key: 'a', modifiers: ['ctrl'] }]);
    expect(fake.scrolls).toEqual([50]);
  });

  test('browser_close_panel closes the session', async () => {
    const fake = makeFakeBrowserSession();
    const { runtime } = makeRuntime({
      turns: [{ toolCalls: [{ id: 't1', name: 'browser_navigate', arguments: {} }] }, {}],
      factory: () => fake,
    });
    await runtime.sendUserMessage('go', 'req-1');
    const pool = new RuntimePool();
    pool.getOrCreate('sess-1', () => runtime);
    const deps: WsDeps = {
      csrfToken: 'TOK',
      serverVersion: '0.1',
      workspaceRegistry: {} as WsDeps['workspaceRegistry'],
      sessionManager: { getMessages: () => [] } as unknown as WsDeps['sessionManager'],
      configManager: { update: () => ({}) } as unknown as WsDeps['configManager'],
      eventBus: new SessionEventBus(),
      approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
      runtimePool: pool,
      createRuntimeForSession: () => runtime,
      applyProviderChange: async () => ({
        ok: true as const,
        backend: 'ollama',
        baseUrl: 'http://localhost:11434',
        models: ['m1'],
        currentModel: 'm1',
      }),
    };
    const handlers = createWsHandlers(deps);
    const ws = makeFakeSocket();
    async function send(msg: WSClientMessage): Promise<void> {
      await handlers.onMessage(
        ws as unknown as ServerWebSocket<SocketContext>,
        JSON.stringify(msg),
      );
    }
    await send({ type: 'hello', csrf: 'TOK', clientId: 'c1' });
    await send({ type: 'browser_close_panel', sessionId: 'sess-1' });
    expect(fake.closed).toBe(1);
  });
});
