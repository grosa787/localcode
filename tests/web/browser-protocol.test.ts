/**
 * Browser-protocol round-trip — Zod-serialise/parse every new
 * `browser_*` WS frame variant (server→client and client→server) and
 * assert the structure survives the wire intact.
 */

import { describe, expect, test } from 'bun:test';

import {
  WSClientMessageSchema,
  WSServerMessageSchema,
  type WSClientMessage,
  type WSServerMessage,
} from '@/web/protocol/messages';

function roundTripServer(msg: WSServerMessage): WSServerMessage {
  const parsed = WSServerMessageSchema.parse(JSON.parse(JSON.stringify(msg)));
  return parsed;
}

function roundTripClient(msg: WSClientMessage): WSClientMessage {
  const parsed = WSClientMessageSchema.parse(JSON.parse(JSON.stringify(msg)));
  return parsed;
}

describe('browser_* server-to-client frames', () => {
  test('browser_frame round-trips with full payload', () => {
    const msg: WSServerMessage = {
      type: 'browser_frame',
      sessionId: 'sess-1',
      frame: {
        jpegBase64: 'AAAA',
        width: 1280,
        height: 720,
        capturedAt: 1_700_000_000_000,
      },
    };
    expect(roundTripServer(msg)).toEqual(msg);
  });

  test('browser_cursor preserves coordinates and action', () => {
    const msg: WSServerMessage = {
      type: 'browser_cursor',
      sessionId: 'sess-1',
      fromX: 10,
      fromY: 20,
      toX: 100,
      toY: 200,
      durationMs: 350,
      action: 'click',
    };
    expect(roundTripServer(msg)).toEqual(msg);
  });

  test('browser_console handles optional fields', () => {
    const minimal: WSServerMessage = {
      type: 'browser_console',
      sessionId: 'sess-1',
      level: 'error',
      text: 'boom',
    };
    expect(roundTripServer(minimal)).toEqual(minimal);
    const full: WSServerMessage = {
      type: 'browser_console',
      sessionId: 'sess-1',
      level: 'warn',
      text: 'careful',
      source: 'app.js',
      line: 42,
    };
    expect(roundTripServer(full)).toEqual(full);
  });

  test('browser_state survives every status', () => {
    const statuses = ['idle', 'starting', 'ready', 'navigating', 'closed', 'error'] as const;
    for (const status of statuses) {
      const msg: WSServerMessage = {
        type: 'browser_state',
        sessionId: 'sess-1',
        status,
        ...(status === 'error' ? { errorMessage: 'oops' } : {}),
        ...(status === 'navigating' ? { url: 'https://example.com' } : {}),
        ...(status === 'ready' ? { title: 'Example' } : {}),
      };
      expect(roundTripServer(msg)).toEqual(msg);
    }
  });
});

describe('browser_user_* client-to-server frames', () => {
  test('browser_user_click round-trips with optional button', () => {
    const left: WSClientMessage = {
      type: 'browser_user_click',
      sessionId: 'sess-1',
      x: 50,
      y: 75,
    };
    expect(roundTripClient(left)).toEqual(left);
    const right: WSClientMessage = {
      type: 'browser_user_click',
      sessionId: 'sess-1',
      x: 5,
      y: 5,
      button: 'right',
    };
    expect(roundTripClient(right)).toEqual(right);
  });

  test('browser_user_key carries modifiers', () => {
    const msg: WSClientMessage = {
      type: 'browser_user_key',
      sessionId: 'sess-1',
      key: 'a',
      modifiers: ['ctrl', 'shift'],
    };
    expect(roundTripClient(msg)).toEqual(msg);
  });

  test('browser_user_scroll preserves deltaY sign', () => {
    const msg: WSClientMessage = {
      type: 'browser_user_scroll',
      sessionId: 'sess-1',
      deltaY: -120,
    };
    expect(roundTripClient(msg)).toEqual(msg);
  });

  test('browser_close_panel is a session-scoped tag', () => {
    const msg: WSClientMessage = {
      type: 'browser_close_panel',
      sessionId: 'sess-1',
    };
    expect(roundTripClient(msg)).toEqual(msg);
  });

  test('schema rejects malformed browser frames', () => {
    expect(() =>
      WSClientMessageSchema.parse({
        type: 'browser_user_click',
        sessionId: 'sess-1',
        // missing x, y
      }),
    ).toThrow();
    expect(() =>
      WSServerMessageSchema.parse({
        type: 'browser_state',
        sessionId: 'sess-1',
        status: 'bogus',
      }),
    ).toThrow();
  });
});
