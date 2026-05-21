/**
 * Parallel multi-session support — backend isolation.
 *
 * These tests verify that:
 *  - `RuntimePool` returns distinct `ChatRuntime` instances per session.
 *  - Two `subscribe_session` frames on a single socket retain BOTH
 *    subscriptions (no replace-on-second-subscribe semantics).
 *  - Bus events for sessionA do not leak into sessionB subscribers.
 *  - Concurrent `send_message` frames hit each session's runtime
 *    independently (different runtimes, no shared lock).
 *  - Unsubscribe of one session leaves the other intact.
 *  - Re-subscribing to an already-subscribed session is a no-op.
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
import type {
  WSClientMessage,
  WSServerMessage,
} from '@/web/protocol/messages';

interface FakeSocket {
  data: SocketContext;
  sent: WSServerMessage[];
  closed: { code: number; reason: string } | null;
  send: (s: string) => void;
  close: (code: number, reason: string) => void;
}

function makeFakeSocket(): FakeSocket {
  const s: FakeSocket = {
    data: createSocketContext(),
    sent: [],
    closed: null,
    send(text: string): void {
      try {
        s.sent.push(JSON.parse(text) as WSServerMessage);
      } catch {
        // Ignore non-JSON sends in tests.
      }
    },
    close(code: number, reason: string): void {
      s.closed = { code, reason };
    },
  };
  return s;
}

interface FakeRuntime {
  sentMessages: { text: string; reqId: string }[];
  cancelled: number;
}

function makeFakeRuntime(): FakeRuntime & ChatRuntime {
  const f: FakeRuntime = { sentMessages: [], cancelled: 0 };
  // Cast through unknown — only the methods exercised here need to exist.
  const rt = {
    sendUserMessage(text: string, reqId: string): Promise<void> {
      f.sentMessages.push({ text, reqId });
      return Promise.resolve();
    },
    cancel(): void {
      f.cancelled += 1;
    },
  };
  return Object.assign(rt, f) as unknown as FakeRuntime & ChatRuntime;
}

function makeDeps(overrides?: Partial<WsDeps>): WsDeps & {
  pool: RuntimePool;
  bus: SessionEventBus;
  factories: Map<string, FakeRuntime & ChatRuntime>;
} {
  const eventBus = new SessionEventBus();
  const approvalBridge = new ApprovalBridge({ timeoutMs: 60_000 });
  const runtimePool = new RuntimePool();
  const factories = new Map<string, FakeRuntime & ChatRuntime>();

  const deps: WsDeps = {
    csrfToken: 'TOKEN',
    serverVersion: '1.0',
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
    createRuntimeForSession: (sid: string) => {
      const rt = makeFakeRuntime();
      factories.set(sid, rt);
      return rt;
    },
    applyProviderChange: async () => ({
      ok: true as const,
      backend: 'ollama',
      baseUrl: 'http://localhost:11434',
      models: ['m1'],
      currentModel: 'm1',
    }),
    ...overrides,
  };
  return Object.assign(deps, { pool: runtimePool, bus: eventBus, factories });
}

async function dispatch(
  handlers: ReturnType<typeof createWsHandlers>,
  ws: FakeSocket,
  msg: WSClientMessage | string,
): Promise<void> {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  await handlers.onMessage(
    ws as unknown as ServerWebSocket<SocketContext>,
    data,
  );
}

async function helloed(
  h: ReturnType<typeof createWsHandlers>,
  ws: FakeSocket,
): Promise<void> {
  await dispatch(h, ws, { type: 'hello', csrf: 'TOKEN', clientId: 'c1' });
  ws.sent.length = 0;
}

describe('parallel multi-session support', () => {
  test('RuntimePool returns distinct instances per session', () => {
    const pool = new RuntimePool();
    const a = pool.getOrCreate('sess-a', () => makeFakeRuntime());
    const b = pool.getOrCreate('sess-b', () => makeFakeRuntime());
    expect(a).not.toBe(b);
    // Repeated lookups return the same instance.
    expect(pool.get('sess-a')).toBe(a);
    expect(pool.get('sess-b')).toBe(b);
  });

  test('subscribing to two sessions retains BOTH subscriptions', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await helloed(h, ws);

    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's1' });
    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's2' });

    expect(ws.data.subscribedSessions.has('s1')).toBe(true);
    expect(ws.data.subscribedSessions.has('s2')).toBe(true);
    expect(deps.bus.subscriberCount('s1')).toBe(1);
    expect(deps.bus.subscriberCount('s2')).toBe(1);
  });

  test('events for sessionA do not bleed into sessionB stream', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await helloed(h, ws);

    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's1' });
    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's2' });
    ws.sent.length = 0;

    deps.bus.emit('s1', { type: 'chunk', sessionId: 's1', text: 'A1' });
    deps.bus.emit('s2', { type: 'chunk', sessionId: 's2', text: 'B1' });
    deps.bus.emit('s1', { type: 'chunk', sessionId: 's1', text: 'A2' });

    const chunksForS1 = ws.sent.filter(
      (m): m is WSServerMessage & { sessionId: string; text: string } =>
        m.type === 'chunk' && 'sessionId' in m && m.sessionId === 's1',
    );
    const chunksForS2 = ws.sent.filter(
      (m): m is WSServerMessage & { sessionId: string; text: string } =>
        m.type === 'chunk' && 'sessionId' in m && m.sessionId === 's2',
    );
    expect(chunksForS1.map((m) => m.text)).toEqual(['A1', 'A2']);
    expect(chunksForS2.map((m) => m.text)).toEqual(['B1']);
  });

  test('concurrent send_message hits distinct runtimes (no shared lock)', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await helloed(h, ws);

    await Promise.all([
      dispatch(h, ws, {
        type: 'send_message',
        sessionId: 'sa',
        text: 'hello A',
        clientReqId: 'r1',
      }),
      dispatch(h, ws, {
        type: 'send_message',
        sessionId: 'sb',
        text: 'hello B',
        clientReqId: 'r2',
      }),
    ]);

    const rtA = deps.factories.get('sa');
    const rtB = deps.factories.get('sb');
    expect(rtA).toBeDefined();
    expect(rtB).toBeDefined();
    expect(rtA).not.toBe(rtB);
    expect(rtA?.sentMessages).toEqual([{ text: 'hello A', reqId: 'r1' }]);
    expect(rtB?.sentMessages).toEqual([{ text: 'hello B', reqId: 'r2' }]);
  });

  test('unsubscribing one session leaves the other intact', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await helloed(h, ws);

    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's1' });
    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's2' });
    await dispatch(h, ws, { type: 'unsubscribe_session', sessionId: 's1' });

    expect(ws.data.subscribedSessions.has('s1')).toBe(false);
    expect(ws.data.subscribedSessions.has('s2')).toBe(true);
    expect(deps.bus.subscriberCount('s1')).toBe(0);
    expect(deps.bus.subscriberCount('s2')).toBe(1);

    ws.sent.length = 0;
    deps.bus.emit('s1', { type: 'chunk', sessionId: 's1', text: 'gone' });
    deps.bus.emit('s2', { type: 'chunk', sessionId: 's2', text: 'live' });
    const texts = ws.sent
      .filter((m): m is WSServerMessage & { text: string } => m.type === 'chunk')
      .map((m) => m.text);
    expect(texts).toEqual(['live']);
  });

  test('re-subscribing to a session is a no-op (does not duplicate)', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await helloed(h, ws);

    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's1' });
    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's1' });
    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 's1' });

    expect(deps.bus.subscriberCount('s1')).toBe(1);

    ws.sent.length = 0;
    deps.bus.emit('s1', { type: 'chunk', sessionId: 's1', text: 'once' });
    const chunks = ws.sent.filter((m) => m.type === 'chunk');
    expect(chunks).toHaveLength(1);
  });
});
