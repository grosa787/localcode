/**
 * Presence tests — multi-user collaboration (Wave 9).
 *
 * Covers:
 *   - ChatRuntime presence state model (applyPresence, markPresenceOffline,
 *     reapStalePresence) is correct.
 *   - WSServerMessageSchema validates `presence` frames in both directions.
 *
 * We don't exercise the full ws.ts handler here because the existing
 * `runtime.test.ts` doesn't either — those handlers tightly couple to
 * Bun's `ServerWebSocket` type which is hard to spin up in a unit test.
 * The data model + schema are the load-bearing additions and that's
 * what these tests pin down.
 */

import { describe, expect, test } from 'bun:test';

import type { ApprovalBridge } from '@/web/runtime/approval-bridge';
import { ChatRuntime, PRESENCE_REAP_AFTER_MS } from '@/web/runtime/chat-runtime';
import type { ContextManager } from '@/llm/context-manager';
import type { LLMLike } from '@/web/runtime/chat-runtime';
import type { SessionManager } from '@/sessions/session-manager';
import type { ToolExecutor } from '@/llm/tool-executor';
import { SessionEventBus } from '@/web/runtime/event-bus';
import type { Message } from '@/types/global';
import {
  WSClientMessageSchema,
  WSServerMessageSchema,
} from '@/web/protocol/messages';

function makeRuntime(): ChatRuntime {
  const eventBus = new SessionEventBus();
  const llm: LLMLike = {
    streamChat: async () => {
      // Never called by these tests — runtime only used for presence state.
    },
  };
  const ctxMgr: ContextManager = {
    add: () => {},
    getMessages: () => [],
    maybeSummarize: async () => false,
    recordUsage: () => {},
  } as unknown as ContextManager;
  const sessionMgr: SessionManager = {
    addMessage: () => {},
    getSession: () => null,
    getMessages: () => [],
    getTodos: () => [],
  } as unknown as SessionManager;
  const toolExec: ToolExecutor = {
    execute: async () => ({ success: true, output: '' }),
  } as unknown as ToolExecutor;
  const approval: ApprovalBridge = {
    resolve: () => {},
    listPending: () => [],
  } as unknown as ApprovalBridge;
  const buildSystemMessage = (): Message => ({
    id: 'sys-1',
    role: 'system',
    content: '',
    createdAt: 0,
  });
  return new ChatRuntime({
    sessionId: 'sess-presence',
    tools: [],
    buildSystemMessage,
    maxContextTokens: 4_000,
    llm,
    toolExecutor: toolExec,
    contextManager: ctxMgr,
    sessionManager: sessionMgr,
    eventBus,
    approvalBridge: approval,
  });
}

describe('ChatRuntime presence state', () => {
  test('applyPresence stamps server time and stores the peer', async () => {
    const rt = makeRuntime();
    try {
      const before = Date.now();
      const info = rt.applyPresence({
        userId: 'u1',
        displayName: 'Alice',
        typing: true,
      });
      const after = Date.now();
      expect(info.userId).toBe('u1');
      expect(info.displayName).toBe('Alice');
      expect(info.typing).toBe(true);
      expect(info.lastSeenMs).toBeGreaterThanOrEqual(before);
      expect(info.lastSeenMs).toBeLessThanOrEqual(after);

      const snapshot = rt.listPresence();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]?.userId).toBe('u1');
    } finally {
      await rt.dispose();
    }
  });

  test('applyPresence is idempotent and overwrites typing state', async () => {
    const rt = makeRuntime();
    try {
      rt.applyPresence({ userId: 'u1', displayName: 'A', typing: true });
      rt.applyPresence({ userId: 'u1', displayName: 'A', typing: false });
      const snap = rt.listPresence();
      expect(snap).toHaveLength(1);
      expect(snap[0]?.typing).toBe(false);
    } finally {
      await rt.dispose();
    }
  });

  test('markPresenceOffline removes the peer and returns an offline copy', async () => {
    const rt = makeRuntime();
    try {
      rt.applyPresence({ userId: 'u1', displayName: 'A', typing: true });
      const offline = rt.markPresenceOffline('u1');
      expect(offline).not.toBeNull();
      expect(offline?.typing).toBe(false);
      expect(rt.listPresence()).toHaveLength(0);
    } finally {
      await rt.dispose();
    }
  });

  test('markPresenceOffline returns null for unknown userId', async () => {
    const rt = makeRuntime();
    try {
      expect(rt.markPresenceOffline('ghost')).toBeNull();
    } finally {
      await rt.dispose();
    }
  });

  test('reapStalePresence drops peers older than the threshold', async () => {
    const rt = makeRuntime();
    try {
      rt.applyPresence({ userId: 'u1', displayName: 'A', typing: false });
      rt.applyPresence({ userId: 'u2', displayName: 'B', typing: true });
      // Pretend "now" is far in the future so the entries look stale.
      const future = Date.now() + PRESENCE_REAP_AFTER_MS + 1_000;
      const reaped = rt.reapStalePresence(future);
      expect(reaped).toHaveLength(2);
      expect(rt.listPresence()).toHaveLength(0);
      // Every reaped entry is broadcast with typing=false.
      for (const r of reaped) {
        expect(r.typing).toBe(false);
      }
    } finally {
      await rt.dispose();
    }
  });

  test('reapStalePresence is a no-op when peers are fresh', async () => {
    const rt = makeRuntime();
    try {
      rt.applyPresence({ userId: 'u1', displayName: 'A', typing: false });
      const reaped = rt.reapStalePresence();
      expect(reaped).toHaveLength(0);
      expect(rt.listPresence()).toHaveLength(1);
    } finally {
      await rt.dispose();
    }
  });

  test('dispose tears down the peer set', async () => {
    const rt = makeRuntime();
    rt.applyPresence({ userId: 'u1', displayName: 'A', typing: true });
    await rt.dispose();
    expect(rt.listPresence()).toHaveLength(0);
  });
});

describe('presence wire schema', () => {
  test('client → server presence frame validates', () => {
    const frame = {
      type: 'presence' as const,
      sessionId: 'sess-1',
      userId: 'u1',
      displayName: 'Alice',
      typing: true,
      lastSeenMs: Date.now(),
    };
    const parsed = WSClientMessageSchema.safeParse(frame);
    expect(parsed.success).toBe(true);
  });

  test('server → client presence frame validates', () => {
    const frame = {
      type: 'presence' as const,
      sessionId: 'sess-1',
      userId: 'u1',
      displayName: 'Alice',
      typing: false,
      lastSeenMs: Date.now(),
    };
    const parsed = WSServerMessageSchema.safeParse(frame);
    expect(parsed.success).toBe(true);
  });

  test('schema rejects malformed presence (missing fields)', () => {
    const bad = {
      type: 'presence' as const,
      sessionId: 'sess-1',
      userId: 'u1',
      // displayName missing
      typing: true,
      lastSeenMs: 0,
    };
    expect(WSClientMessageSchema.safeParse(bad).success).toBe(false);
    expect(WSServerMessageSchema.safeParse(bad).success).toBe(false);
  });
});
