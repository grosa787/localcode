/**
 * Runtime / WS bridge tests — Agent C.
 *
 * Covers:
 *   - SessionEventBus subscribe / unsubscribe / multi-subscriber /
 *     throwing-subscriber isolation.
 *   - ApprovalBridge resolve / timeout / duplicate / multi-resolve
 *     idempotency / listPending.
 *   - RuntimePool LRU eviction + idle reaping.
 *   - WS handlers hello-gate (CSRF mismatch closes; valid passes) and
 *     basic dispatch (subscribe → subscribed event, ping → pong).
 *
 * No real WebSocket / SQLite — every collaborator is a thin fake so
 * the suite stays fast and deterministic.
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

// ---------- SessionEventBus ----------

describe('SessionEventBus', () => {
  test('emit dispatches to every subscriber for a session', () => {
    const bus = new SessionEventBus();
    const a: WSServerMessage[] = [];
    const b: WSServerMessage[] = [];
    bus.subscribe('s1', (m) => a.push(m));
    bus.subscribe('s1', (m) => b.push(m));
    bus.emit('s1', { type: 'pong' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toEqual({ type: 'pong' });
  });

  test('subscribers for other sessions are not invoked', () => {
    const bus = new SessionEventBus();
    const a: WSServerMessage[] = [];
    bus.subscribe('s1', (m) => a.push(m));
    bus.emit('s2', { type: 'pong' });
    expect(a).toHaveLength(0);
    expect(bus.hasSubscribers('s1')).toBe(true);
    expect(bus.hasSubscribers('s2')).toBe(false);
  });

  test('unsubscribe removes a single callback', () => {
    const bus = new SessionEventBus();
    const a: WSServerMessage[] = [];
    const unsub = bus.subscribe('s1', (m) => a.push(m));
    unsub();
    bus.emit('s1', { type: 'pong' });
    expect(a).toHaveLength(0);
    expect(bus.subscriberCount('s1')).toBe(0);
  });

  test('throwing subscriber does not break other subscribers', () => {
    const bus = new SessionEventBus();
    const seen: WSServerMessage[] = [];
    bus.subscribe('s1', () => {
      throw new Error('boom');
    });
    bus.subscribe('s1', (m) => seen.push(m));
    bus.emit('s1', { type: 'pong' });
    expect(seen).toHaveLength(1);
  });
});

// ---------- ApprovalBridge ----------

describe('ApprovalBridge', () => {
  test('resolve settles the pending promise', async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 60_000 });
    const p = bridge.request('tc-1', 'write_file', { path: 'a.ts' }, null, 's1');
    expect(bridge.size()).toBe(1);
    const ok = bridge.resolve('tc-1', true);
    expect(ok).toBe(true);
    await expect(p).resolves.toEqual({ approved: true });
    expect(bridge.size()).toBe(0);
  });

  test('timeout rejects the promise with ApprovalTimeoutError (audit H4)', async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 5 });
    const p = bridge.request('tc-2', 'run_command', { command: 'ls' }, null, 's1');
    let caught: unknown = null;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('ApprovalTimeoutError');
    expect((caught as Error).message).toContain('timed out');
    expect(bridge.size()).toBe(0);
  });

  test('resolving an unknown id returns false (idempotent)', () => {
    const bridge = new ApprovalBridge();
    expect(bridge.resolve('nope', true)).toBe(false);
  });

  test('duplicate request for same id throws', () => {
    const bridge = new ApprovalBridge();
    void bridge.request('tc-3', 'write_file', {}, null, 's1');
    expect(() => bridge.request('tc-3', 'write_file', {}, null, 's1')).toThrow();
    bridge.resolve('tc-3', false);
  });

  test('listPending exposes outstanding requests', async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 60_000 });
    const p = bridge.request(
      'tc-4',
      'write_file',
      { path: 'x.ts' },
      { kind: 'diff', path: 'x.ts', oldContent: '', newContent: 'a' },
      'session-A',
    );
    const list = bridge.listPending();
    expect(list).toHaveLength(1);
    expect(list[0]?.toolCallId).toBe('tc-4');
    expect(list[0]?.sessionId).toBe('session-A');
    bridge.resolve('tc-4', false);
    await p;
  });

  test('rejectAll settles every pending request as false', async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 60_000 });
    const p1 = bridge.request('a', 'write_file', {}, null, 's1');
    const p2 = bridge.request('b', 'write_file', {}, null, 's1');
    bridge.rejectAll();
    await expect(p1).resolves.toEqual({ approved: false });
    await expect(p2).resolves.toEqual({ approved: false });
    expect(bridge.size()).toBe(0);
  });
});

// ---------- RuntimePool ----------

describe('RuntimePool', () => {
  function fakeRuntime(): ChatRuntime {
    return {} as ChatRuntime;
  }

  test('getOrCreate returns the same instance for the same id', () => {
    const pool = new RuntimePool();
    const r1 = pool.getOrCreate('s1', fakeRuntime);
    const r2 = pool.getOrCreate('s1', fakeRuntime);
    expect(r1).toBe(r2);
    expect(pool.size()).toBe(1);
  });

  test('LRU eviction drops the oldest entry past maxSize', async () => {
    const evicted: string[] = [];
    const pool = new RuntimePool({
      maxSize: 2,
      onEvict: (id) => evicted.push(id),
    });
    pool.getOrCreate('a', fakeRuntime);
    // Ensure measurable timestamp gap so LRU ordering is unambiguous.
    await new Promise((r) => setTimeout(r, 2));
    pool.getOrCreate('b', fakeRuntime);
    await new Promise((r) => setTimeout(r, 2));
    // Touch 'a' so 'b' becomes the oldest.
    pool.getOrCreate('a', fakeRuntime);
    await new Promise((r) => setTimeout(r, 2));
    pool.getOrCreate('c', fakeRuntime);
    expect(pool.size()).toBe(2);
    expect(evicted).toContain('b');
    expect(pool.get('b')).toBeUndefined();
    expect(pool.get('a')).toBeDefined();
    expect(pool.get('c')).toBeDefined();
  });

  test('release drops a specific entry', () => {
    const pool = new RuntimePool();
    pool.getOrCreate('s1', fakeRuntime);
    pool.release('s1');
    expect(pool.size()).toBe(0);
  });

  test('idle reaping evicts stale entries on next access', async () => {
    const pool = new RuntimePool({ idleTimeoutMs: 1 });
    pool.getOrCreate('old', fakeRuntime);
    await new Promise((r) => setTimeout(r, 10));
    pool.getOrCreate('fresh', fakeRuntime);
    expect(pool.get('old')).toBeUndefined();
    expect(pool.get('fresh')).toBeDefined();
  });
});

// ---------- WS handlers ----------

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

function makeDeps(overrides?: Partial<WsDeps>): WsDeps {
  const eventBus = new SessionEventBus();
  const approvalBridge = new ApprovalBridge({ timeoutMs: 60_000 });
  const runtimePool = new RuntimePool();
  return {
    csrfToken: 'TOKEN-XYZ',
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
    createRuntimeForSession: () => ({}) as ChatRuntime,
    applyProviderChange: async () => ({
      ok: true as const,
      backend: 'ollama',
      baseUrl: 'http://localhost:11434',
      models: ['m1'],
      currentModel: 'm1',
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

describe('createWsHandlers — hello gate', () => {
  test('first non-hello frame closes with policy code 1008', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await dispatch(h, ws, { type: 'ping' });
    expect(ws.closed?.code).toBe(1008);
    expect(ws.closed?.reason).toBe('expected_hello_first');
  });

  test('mismatched CSRF token closes', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await dispatch(h, ws, { type: 'hello', csrf: 'WRONG', clientId: 'c1' });
    expect(ws.closed?.code).toBe(1008);
    expect(ws.closed?.reason).toBe('csrf_invalid');
  });

  test('valid hello replies with hello_ok and unlocks dispatch', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await dispatch(h, ws, { type: 'hello', csrf: 'TOKEN-XYZ', clientId: 'c1' });
    expect(ws.closed).toBeNull();
    expect(ws.sent).toHaveLength(1);
    const helloOk = JSON.parse(ws.sent[0] ?? '{}');
    expect(helloOk.type).toBe('hello_ok');
    expect(ws.data.csrfHelloed).toBe(true);
    expect(ws.data.clientId).toBe('c1');

    await dispatch(h, ws, { type: 'ping' });
    expect(JSON.parse(ws.sent[1] ?? '{}').type).toBe('pong');
  });

  test('invalid JSON / schema produces an error frame without closing', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await dispatch(h, ws, '{not json');
    expect(ws.closed).toBeNull();
    expect(JSON.parse(ws.sent[0] ?? '{}')).toEqual({
      type: 'error',
      message: 'invalid_json',
    });
  });
});

describe('createWsHandlers — dispatch', () => {
  test('subscribe_session emits subscribed and forwards bus events', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await dispatch(h, ws, { type: 'hello', csrf: 'TOKEN-XYZ', clientId: 'c1' });
    ws.sent.length = 0;

    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 'sess-1' });
    expect(ws.sent).toHaveLength(1);
    const subscribed = JSON.parse(ws.sent[0] ?? '{}');
    expect(subscribed.type).toBe('subscribed');
    expect(subscribed.sessionId).toBe('sess-1');

    deps.eventBus.emit('sess-1', { type: 'chunk', sessionId: 'sess-1', text: 'hi' });
    const chunk = JSON.parse(ws.sent[1] ?? '{}');
    expect(chunk.type).toBe('chunk');
    expect(chunk.text).toBe('hi');
  });

  test('approval_response settles the pending promise via the bridge', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await dispatch(h, ws, { type: 'hello', csrf: 'TOKEN-XYZ', clientId: 'c1' });
    const pending = deps.approvalBridge.request(
      'tc-9',
      'write_file',
      { path: 'a.ts' },
      null,
      'sess-1',
    );
    await dispatch(h, ws, {
      type: 'approval_response',
      toolCallId: 'tc-9',
      approved: true,
    });
    await expect(pending).resolves.toEqual({ approved: true });
  });

  test('onClose drops every subscription this socket held', async () => {
    const deps = makeDeps();
    const h = createWsHandlers(deps);
    const ws = makeFakeSocket();
    await dispatch(h, ws, { type: 'hello', csrf: 'TOKEN-XYZ', clientId: 'c1' });
    await dispatch(h, ws, { type: 'subscribe_session', sessionId: 'sess-1' });
    expect(deps.eventBus.subscriberCount('sess-1')).toBe(1);

    h.onClose(ws as unknown as ServerWebSocket<SocketContext>);
    expect(deps.eventBus.subscriberCount('sess-1')).toBe(0);
    expect(ws.data.subscribedSessions.size).toBe(0);
  });
});
