/**
 * WS round-trip — exercises `createWsHandlers` against a fake socket and
 * stub deps. Complements `tests/web/runtime.test.ts` (handshake, basic
 * dispatch) by drilling into the long-tail message types: `set_provider`,
 * `set_model`, `cancel_stream`, `unsubscribe_session`, and the catch-up
 * approval re-emit on subscribe.
 */

import { describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';

import { ApprovalBridge } from '@/web/runtime/approval-bridge';
import { SessionEventBus } from '@/web/runtime/event-bus';
import { RuntimePool } from '@/web/runtime/runtime-pool';
import type { ChatRuntime } from '@/web/runtime/chat-runtime';
import {
  createSocketContext,
  createWsHandlers,
  type SocketContext,
  type WsDeps,
} from '@/web/server/ws';
import type { WSClientMessage } from '@/web/protocol/messages';

interface FakeSocket {
  data: SocketContext;
  sent: string[];
  closed: { code: number; reason: string } | null;
  send: (s: string) => void;
  close: (code: number, reason: string) => void;
}

function makeFakeSocket(): FakeSocket {
  const s: FakeSocket = {
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
  return s;
}

interface StubRuntime {
  cancelled: number;
  sent: Array<{ text: string; clientReqId: string }>;
}

function makeRuntimeStub(): { runtime: ChatRuntime; state: StubRuntime } {
  const state: StubRuntime = { cancelled: 0, sent: [] };
  const runtime = {
    sendUserMessage: async (text: string, clientReqId: string) => {
      state.sent.push({ text, clientReqId });
    },
    cancel: () => {
      state.cancelled += 1;
    },
  } as unknown as ChatRuntime;
  return { runtime, state };
}

function makeDeps(overrides?: Partial<WsDeps>): WsDeps {
  const eventBus = new SessionEventBus();
  const approvalBridge = new ApprovalBridge({ timeoutMs: 60_000 });
  const runtimePool = new RuntimePool();
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
    eventBus,
    approvalBridge,
    runtimePool,
    createRuntimeForSession: () => ({} as ChatRuntime),
    applyProviderChange: async (req) => ({
      ok: true as const,
      backend: req.type,
      baseUrl: 'http://localhost:1234',
      models: ['stub-model'],
      currentModel: 'stub-model',
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

async function helloed(
  deps: WsDeps,
): Promise<{
  h: ReturnType<typeof createWsHandlers>;
  ws: FakeSocket;
}> {
  const h = createWsHandlers(deps);
  const ws = makeFakeSocket();
  await dispatch(h, ws, { type: 'hello', csrf: 'TOK', clientId: 'c1' });
  ws.sent.length = 0;
  return { h, ws };
}

describe('createWsHandlers — round-trips', () => {
  test('ping → pong', async () => {
    const deps = makeDeps();
    const { h, ws } = await helloed(deps);
    await dispatch(h, ws, { type: 'ping' });
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0] ?? '{}').type).toBe('pong');
  });

  test('send_message reaches the runtime', async () => {
    const { runtime, state } = makeRuntimeStub();
    const deps = makeDeps({ createRuntimeForSession: () => runtime });
    const { h, ws } = await helloed(deps);
    await dispatch(h, ws, {
      type: 'send_message',
      sessionId: 's1',
      text: 'hi',
      clientReqId: 'r1',
    });
    // sendUserMessage is fire-and-forget — give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(state.sent).toEqual([{ text: 'hi', clientReqId: 'r1' }]);
  });

  test('cancel_stream invokes runtime.cancel', async () => {
    const { runtime, state } = makeRuntimeStub();
    const deps = makeDeps({ createRuntimeForSession: () => runtime });
    const { h, ws } = await helloed(deps);
    // Prime the pool by sending a message first.
    await dispatch(h, ws, {
      type: 'send_message',
      sessionId: 's1',
      text: 'hi',
      clientReqId: 'r1',
    });
    await new Promise((r) => setTimeout(r, 0));

    await dispatch(h, ws, { type: 'cancel_stream', sessionId: 's1' });
    expect(state.cancelled).toBe(1);
  });

  test('approval_response settles the bridge', async () => {
    const deps = makeDeps();
    const { h, ws } = await helloed(deps);
    const pending = deps.approvalBridge.request(
      'tc-1',
      'write_file',
      { path: 'a.ts' },
      null,
      's1',
    );
    await dispatch(h, ws, {
      type: 'approval_response',
      toolCallId: 'tc-1',
      approved: true,
    });
    await expect(pending).resolves.toEqual({ approved: true });
  });

  test('set_provider emits provider_changed', async () => {
    const deps = makeDeps();
    const { h, ws } = await helloed(deps);
    await dispatch(h, ws, {
      type: 'set_provider',
      backend: 'openai',
      apiKey: 'sk',
      clientReqId: 'p1',
    });
    expect(ws.sent).toHaveLength(1);
    const msg = JSON.parse(ws.sent[0] ?? '{}');
    expect(msg.type).toBe('provider_changed');
    expect(msg.backend).toBe('openai');
    expect(msg.currentModel).toBe('stub-model');
    expect(msg.clientReqId).toBe('p1');
  });

  test('set_provider failures surface as error frame', async () => {
    const deps = makeDeps({
      applyProviderChange: async () => {
        throw new Error('connection refused');
      },
    });
    const { h, ws } = await helloed(deps);
    await dispatch(h, ws, { type: 'set_provider', backend: 'ollama' });
    expect(ws.sent).toHaveLength(1);
    const msg = JSON.parse(ws.sent[0] ?? '{}');
    expect(msg.type).toBe('error');
    expect(msg.message).toContain('set_provider_failed');
    expect(msg.message).toContain('connection refused');
  });

  test('set_model calls configManager.update', async () => {
    let captured: unknown = null;
    const deps = makeDeps({
      configManager: {
        update: (patch: unknown) => {
          captured = patch;
          return {};
        },
      } as unknown as WsDeps['configManager'],
    });
    const { h, ws } = await helloed(deps);
    await dispatch(h, ws, {
      type: 'set_model',
      sessionId: 's1',
      model: 'gpt-5',
    });
    expect(captured).toEqual({ model: { current: 'gpt-5' } });
    // No error frame.
    expect(ws.sent).toHaveLength(0);
  });

  test('subscribe_session emits subscribed and forwards events', async () => {
    const deps = makeDeps();
    const { h, ws } = await helloed(deps);
    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's1' });
    expect(JSON.parse(ws.sent[0] ?? '{}').type).toBe('subscribed');

    deps.eventBus.emit('s1', { type: 'chunk', sessionId: 's1', text: 'hi' });
    expect(JSON.parse(ws.sent[1] ?? '{}').type).toBe('chunk');
  });

  test('subscribe re-emits any pending approvals for the session', async () => {
    const deps = makeDeps();
    void deps.approvalBridge.request(
      'tc-99',
      'write_file',
      { path: 'a.ts' },
      { kind: 'diff', path: 'a.ts', oldContent: '', newContent: 'x' },
      's1',
    );
    const { h, ws } = await helloed(deps);
    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's1' });
    // First frame is `subscribed`, second is the catch-up approval.
    const types = ws.sent.map((s) => JSON.parse(s).type);
    expect(types).toEqual(['subscribed', 'approval_request']);
    deps.approvalBridge.resolve('tc-99', false);
  });

  test('unsubscribe_session removes the bus subscription', async () => {
    const deps = makeDeps();
    const { h, ws } = await helloed(deps);
    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's1' });
    expect(deps.eventBus.subscriberCount('s1')).toBe(1);
    await dispatch(h, ws, { type: 'unsubscribe_session', sessionId: 's1' });
    expect(deps.eventBus.subscriberCount('s1')).toBe(0);
  });

  test('hello arriving twice is silently ignored (no extra frames, no close)', async () => {
    const deps = makeDeps();
    const { h, ws } = await helloed(deps);
    await dispatch(h, ws, { type: 'hello', csrf: 'TOK', clientId: 'c2' });
    expect(ws.closed).toBeNull();
    expect(ws.sent).toHaveLength(0);
  });
});
