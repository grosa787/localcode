/**
 * notifications-service — WS frame → notification mapping.
 *
 * Uses the pure `mapFrameToNotification` for unit-style coverage and
 * `createNotificationsService` for an end-to-end smoke that exercises
 * the subscribe + dispatch wiring.
 */

import { describe, expect, test, vi } from 'vitest';

import type { WSServerMessage } from '../../../src/web/protocol/messages.js';

import {
  STREAM_COMPLETED_THRESHOLD_MS,
  createNotificationsService,
  mapFrameToNotification,
  type MapContext,
} from './notifications-service';

function makeCtx(over: Partial<MapContext> = {}): MapContext {
  const base: MapContext = {
    activeSessionId: null,
    streamStarts: new Map(),
  };
  if (over.activeSessionId !== undefined) base.activeSessionId = over.activeSessionId;
  if (over.streamStarts !== undefined) base.streamStarts = over.streamStarts;
  if (over.now !== undefined) base.now = over.now;
  return base;
}

describe('mapFrameToNotification', () => {
  test('agent_completed → agent_completed entry with summary body', () => {
    const msg: WSServerMessage = {
      type: 'agent_completed',
      sessionId: 's1',
      agentId: 'a1',
      summary: 'shipped',
      durationMs: 100,
    };
    const out = mapFrameToNotification(msg, makeCtx());
    expect(out?.type).toBe('agent_completed');
    expect(out?.body).toBe('shipped');
    expect(out?.sessionId).toBe('s1');
  });

  test('agent_status failed → agent_errored entry', () => {
    const msg: WSServerMessage = {
      type: 'agent_status',
      sessionId: 's1',
      agentId: 'a1',
      status: 'failed',
      error: 'boom',
    };
    const out = mapFrameToNotification(msg, makeCtx());
    expect(out?.type).toBe('agent_errored');
    expect(out?.body).toBe('boom');
  });

  test('agent_status running → null (no entry)', () => {
    const msg: WSServerMessage = {
      type: 'agent_status',
      sessionId: 's1',
      agentId: 'a1',
      status: 'running',
    };
    expect(mapFrameToNotification(msg, makeCtx())).toBeNull();
  });

  test('approval_request → entry when session is NOT active', () => {
    const msg: WSServerMessage = {
      type: 'approval_request',
      sessionId: 'other',
      toolCallId: 'tc1',
      toolName: 'write_file',
    };
    const out = mapFrameToNotification(
      msg,
      makeCtx({ activeSessionId: 'mine' }),
    );
    expect(out?.type).toBe('approval_required');
    expect(out?.body).toBe('write_file');
  });

  test('approval_request → null when session IS active', () => {
    const msg: WSServerMessage = {
      type: 'approval_request',
      sessionId: 'mine',
      toolCallId: 'tc1',
      toolName: 'write_file',
    };
    expect(
      mapFrameToNotification(msg, makeCtx({ activeSessionId: 'mine' })),
    ).toBeNull();
  });

  test('wakeups_updated empty → wakeup_fired entry', () => {
    const msg: WSServerMessage = {
      type: 'wakeups_updated',
      sessionId: 's1',
      wakeups: [],
    };
    const out = mapFrameToNotification(msg, makeCtx());
    expect(out?.type).toBe('wakeup_fired');
  });

  test('wakeups_updated non-empty → null (not a fire event)', () => {
    const msg: WSServerMessage = {
      type: 'wakeups_updated',
      sessionId: 's1',
      wakeups: [
        {
          id: 'w1',
          sessionId: 's1',
          prompt: 'p',
          reason: 'r',
          createdAt: 1,
          fireAt: 2,
        },
      ],
    };
    expect(mapFrameToNotification(msg, makeCtx())).toBeNull();
  });

  test('backend_circuit_state open → circuit_open entry', () => {
    const msg: WSServerMessage = {
      type: 'backend_circuit_state',
      backend: 'openai',
      baseUrl: 'https://api.openai.com',
      state: 'open',
      reason: 'rate limit',
    };
    const out = mapFrameToNotification(msg, makeCtx());
    expect(out?.type).toBe('circuit_open');
    expect(out?.body).toBe('rate limit');
  });

  test('backend_circuit_state closed → null', () => {
    const msg: WSServerMessage = {
      type: 'backend_circuit_state',
      backend: 'openai',
      baseUrl: 'https://api.openai.com',
      state: 'closed',
    };
    expect(mapFrameToNotification(msg, makeCtx())).toBeNull();
  });

  test('hook_blocked sniffed from tool_result error string', () => {
    const msg: WSServerMessage = {
      type: 'tool_result',
      sessionId: 's1',
      toolCallId: 'tc1',
      ok: false,
      error: 'Hook blocked: forbidden path',
    };
    const out = mapFrameToNotification(msg, makeCtx());
    expect(out?.type).toBe('hook_blocked');
  });

  test('successful tool_result → null', () => {
    const msg: WSServerMessage = {
      type: 'tool_result',
      sessionId: 's1',
      toolCallId: 'tc1',
      ok: true,
    };
    expect(mapFrameToNotification(msg, makeCtx())).toBeNull();
  });

  test('chunk + done > threshold → stream_completed entry', () => {
    const streamStarts = new Map();
    let nowVal = 1000;
    const ctx = makeCtx({ streamStarts, now: () => nowVal });

    const chunk: WSServerMessage = { type: 'chunk', sessionId: 's1', text: 'x' };
    expect(mapFrameToNotification(chunk, ctx)).toBeNull();
    expect(streamStarts.has('s1')).toBe(true);

    nowVal = 1000 + STREAM_COMPLETED_THRESHOLD_MS + 1000;
    const done: WSServerMessage = { type: 'done', sessionId: 's1' };
    const out = mapFrameToNotification(done, ctx);
    expect(out?.type).toBe('stream_completed');
    expect(streamStarts.has('s1')).toBe(false);
  });

  test('chunk + done < threshold → null (no spam for fast turns)', () => {
    const streamStarts = new Map();
    let nowVal = 1000;
    const ctx = makeCtx({ streamStarts, now: () => nowVal });

    mapFrameToNotification(
      { type: 'chunk', sessionId: 's1', text: 'x' },
      ctx,
    );
    nowVal = 1000 + 1000; // 1s, below 30s threshold
    const done: WSServerMessage = { type: 'done', sessionId: 's1' };
    expect(mapFrameToNotification(done, ctx)).toBeNull();
  });
});

describe('createNotificationsService', () => {
  test('routes mapped frames into store.pushNotification', () => {
    const pushNotification = vi.fn();
    const listenerRef: { current: ((m: WSServerMessage) => void) | null } = {
      current: null,
    };
    const unsubscribe = vi.fn();
    const service = createNotificationsService({
      subscribeFeed: (handler) => {
        listenerRef.current = handler;
        return unsubscribe;
      },
      store: {
        pushNotification,
        getBrowserNotificationsEnabled: () => false,
        getActiveSessionId: () => null,
      },
    });

    listenerRef.current?.({
      type: 'agent_completed',
      sessionId: 's1',
      agentId: 'a1',
      summary: 'done',
      durationMs: 100,
    });
    expect(pushNotification).toHaveBeenCalledTimes(1);
    expect(pushNotification.mock.calls[0]?.[0]).toMatchObject({
      type: 'agent_completed',
      sessionId: 's1',
    });

    service.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('skips browser fire when opt-in is off', () => {
    const listenerRef: { current: ((m: WSServerMessage) => void) | null } = {
      current: null,
    };
    const fire = vi.fn();
    createNotificationsService({
      subscribeFeed: (handler) => {
        listenerRef.current = handler;
        return () => undefined;
      },
      store: {
        pushNotification: () => undefined,
        getBrowserNotificationsEnabled: () => false,
        getActiveSessionId: () => null,
      },
      fire,
    });
    listenerRef.current?.({
      type: 'backend_circuit_state',
      backend: 'openai',
      baseUrl: 'https://api.openai.com',
      state: 'open',
    });
    expect(fire).not.toHaveBeenCalled();
  });

  test('invokes browser fire when opt-in is on and frame maps', () => {
    const listenerRef: { current: ((m: WSServerMessage) => void) | null } = {
      current: null,
    };
    const fire = vi.fn();
    createNotificationsService({
      subscribeFeed: (handler) => {
        listenerRef.current = handler;
        return () => undefined;
      },
      store: {
        pushNotification: () => undefined,
        getBrowserNotificationsEnabled: () => true,
        getActiveSessionId: () => null,
      },
      fire,
    });
    listenerRef.current?.({
      type: 'backend_circuit_state',
      backend: 'openai',
      baseUrl: 'https://api.openai.com',
      state: 'open',
      reason: 'down',
    });
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0]?.[0]?.type).toBe('circuit_open');
  });
});
