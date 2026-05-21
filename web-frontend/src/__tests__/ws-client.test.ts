/**
 * WSClient — correlation, queueing, hello-on-connect, reconnect.
 *
 * Uses a hand-rolled fake WebSocket installed on `globalThis` so we can
 * deterministically advance the connection lifecycle without real I/O.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { WSClient } from '../api/ws-client';

// ------- Fake WebSocket -------

const sockets: FakeSocket[] = [];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState: number = FakeSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners[type];
    if (list === undefined) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.fire('close', { code: 1000 });
  }

  // Test helpers
  fire(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners[type] ?? []) {
      fn(ev);
    }
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.fire('open', {});
  }
  msg(payload: unknown): void {
    this.fire('message', { data: JSON.stringify(payload) });
  }
}

beforeEach(() => {
  sockets.length = 0;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WSClient', () => {
  test('sends hello on connection open', () => {
    const client = new WSClient({
      url: 'ws://localhost/ws',
      csrf: 'TOK',
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
    });
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toHaveLength(1);
    const hello = JSON.parse(sockets[0]!.sent[0] ?? '{}');
    expect(hello.type).toBe('hello');
    expect(hello.csrf).toBe('TOK');
    expect(typeof hello.clientId).toBe('string');
    client.close();
  });

  test('queues outbound messages while not yet open and drains on open', () => {
    const client = new WSClient({
      url: 'ws://localhost/ws',
      csrf: 'TOK',
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
    });
    // Socket exists but readyState is CONNECTING.
    client.send({ type: 'ping' });
    expect(sockets[0]!.sent).toHaveLength(0);
    sockets[0]!.open();
    // After open: hello first, then queued ping.
    expect(sockets[0]!.sent).toHaveLength(2);
    expect(JSON.parse(sockets[0]!.sent[1] ?? '{}').type).toBe('ping');
    client.close();
  });

  test('request() resolves on first matching frame', async () => {
    const client = new WSClient({
      url: 'ws://localhost/ws',
      csrf: 'TOK',
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
    });
    sockets[0]!.open();
    const promise = client.request(
      { type: 'subscribe_session', sessionId: 'sess-1' },
      'subscribed',
      (m) => m.type === 'subscribed' && m.sessionId === 'sess-1',
    );
    sockets[0]!.msg({
      type: 'subscribed',
      sessionId: 'sess-1',
      messages: [],
    });
    const resolved = await promise;
    expect(resolved.type).toBe('subscribed');
    client.close();
  });

  test('request() times out', async () => {
    const client = new WSClient({
      url: 'ws://localhost/ws',
      csrf: 'TOK',
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
    });
    sockets[0]!.open();
    const p = client.request({ type: 'ping' }, 'pong', undefined, 1000);
    vi.advanceTimersByTime(1500);
    await expect(p).rejects.toThrow(/timed out/);
    client.close();
  });

  test('reconnects on close with backoff and re-sends hello', () => {
    const states: string[] = [];
    const client = new WSClient({
      url: 'ws://localhost/ws',
      csrf: 'TOK',
      onMessage: () => undefined,
      onConnectionChange: (s) => states.push(s),
    });
    sockets[0]!.open();
    expect(states).toContain('open');

    // Server-initiated close → client must re-create the socket after backoff.
    sockets[0]!.close();
    expect(states).toContain('reconnecting');
    // Initial backoff is 250ms.
    vi.advanceTimersByTime(300);
    expect(sockets.length).toBe(2);
    sockets[1]!.open();
    // New socket sends hello again.
    const helloMsg = JSON.parse(sockets[1]!.sent[0] ?? '{}');
    expect(helloMsg.type).toBe('hello');
    client.close();
  });

  test('close() cancels pending requests with a rejection', async () => {
    const client = new WSClient({
      url: 'ws://localhost/ws',
      csrf: 'TOK',
      onMessage: () => undefined,
      onConnectionChange: () => undefined,
    });
    sockets[0]!.open();
    const p = client.request({ type: 'ping' }, 'pong', undefined, 60_000);
    client.close();
    await expect(p).rejects.toThrow();
  });
});
