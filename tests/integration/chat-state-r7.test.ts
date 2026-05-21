/**
 * R7 — chat-state reducer additions for the two-press Ctrl+C exit flow.
 *
 * Agent 8 R7 added two new actions and a paired field:
 *
 *   - `confirmExitAt: number | null` on ChatState (initially null).
 *   - `START_EXIT_CONFIRM { timestamp }` sets the field to the timestamp.
 *   - `CANCEL_EXIT_CONFIRM` resets it to null.
 *
 * Other unrelated actions must preserve `confirmExitAt` so that chat
 * activity (incoming chunks, tool calls, etc.) does not accidentally
 * clear the exit-confirmation window. The window is only managed by
 * its own pair of actions (or a fresh RESET).
 */
import { describe, test, expect } from 'bun:test';
import {
  chatReducer,
  initialChatState,
  type ChatState,
} from '@/integration/chat-state';
import type { Message } from '@/types/global';

function userMessage(content: string, id = 'm-id'): Message {
  return { id, role: 'user', content, createdAt: 0 };
}

describe('chatReducer — confirmExitAt initial state', () => {
  test('initial confirmExitAt is null', () => {
    expect(initialChatState.confirmExitAt).toBeNull();
  });
});

describe('chatReducer — START_EXIT_CONFIRM (R7)', () => {
  test('sets confirmExitAt to the action timestamp', () => {
    const ts = 1_234_567_890;
    const next = chatReducer(initialChatState, {
      type: 'START_EXIT_CONFIRM',
      timestamp: ts,
    });
    expect(next.confirmExitAt).toBe(ts);
  });

  test('overwrites a previous timestamp (most-recent wins)', () => {
    const a = chatReducer(initialChatState, {
      type: 'START_EXIT_CONFIRM',
      timestamp: 1_000,
    });
    const b = chatReducer(a, {
      type: 'START_EXIT_CONFIRM',
      timestamp: 2_500,
    });
    expect(b.confirmExitAt).toBe(2_500);
  });

  test('does not mutate the previous state', () => {
    const before = chatReducer(initialChatState, {
      type: 'START_EXIT_CONFIRM',
      timestamp: 100,
    });
    const after = chatReducer(before, {
      type: 'START_EXIT_CONFIRM',
      timestamp: 200,
    });
    // Frozen-style invariant: 'before' is unchanged after producing 'after'.
    expect(before.confirmExitAt).toBe(100);
    expect(after.confirmExitAt).toBe(200);
    expect(before).not.toBe(after);
  });

  test('accepts a zero timestamp (treated as a real value, not null)', () => {
    const next = chatReducer(initialChatState, {
      type: 'START_EXIT_CONFIRM',
      timestamp: 0,
    });
    expect(next.confirmExitAt).toBe(0);
  });
});

describe('chatReducer — CANCEL_EXIT_CONFIRM (R7)', () => {
  test('clears a non-null confirmExitAt back to null', () => {
    const armed = chatReducer(initialChatState, {
      type: 'START_EXIT_CONFIRM',
      timestamp: Date.now(),
    });
    expect(armed.confirmExitAt).not.toBeNull();

    const cancelled = chatReducer(armed, { type: 'CANCEL_EXIT_CONFIRM' });
    expect(cancelled.confirmExitAt).toBeNull();
  });

  test('is a no-op-style action when confirmExitAt is already null', () => {
    const cancelled = chatReducer(initialChatState, {
      type: 'CANCEL_EXIT_CONFIRM',
    });
    expect(cancelled.confirmExitAt).toBeNull();
  });
});

describe('chatReducer — other actions preserve confirmExitAt (R7)', () => {
  function armed(): ChatState {
    return chatReducer(initialChatState, {
      type: 'START_EXIT_CONFIRM',
      timestamp: 7_777,
    });
  }

  test('ADD_MESSAGE preserves confirmExitAt', () => {
    const next = chatReducer(armed(), {
      type: 'ADD_MESSAGE',
      message: userMessage('hi'),
    });
    expect(next.confirmExitAt).toBe(7_777);
  });

  test('REPLACE_MESSAGES preserves confirmExitAt', () => {
    const next = chatReducer(armed(), {
      type: 'REPLACE_MESSAGES',
      messages: [userMessage('hi', 'a')],
    });
    expect(next.confirmExitAt).toBe(7_777);
  });

  test('START_STREAM preserves confirmExitAt', () => {
    const next = chatReducer(armed(), { type: 'START_STREAM' });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.isStreaming).toBe(true);
  });

  test('APPEND_CHUNK preserves confirmExitAt', () => {
    const streaming = chatReducer(armed(), { type: 'START_STREAM' });
    const next = chatReducer(streaming, { type: 'APPEND_CHUNK', text: 'foo' });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.currentOutput).toBe('foo');
  });

  test('END_STREAM preserves confirmExitAt', () => {
    const streaming = chatReducer(armed(), { type: 'START_STREAM' });
    const next = chatReducer(streaming, { type: 'END_STREAM' });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.isStreaming).toBe(false);
  });

  test('SET_PENDING_APPROVAL preserves confirmExitAt', () => {
    const next = chatReducer(armed(), {
      type: 'SET_PENDING_APPROVAL',
      approval: null,
    });
    expect(next.confirmExitAt).toBe(7_777);
  });

  test('PUSH_HISTORY preserves confirmExitAt', () => {
    const next = chatReducer(armed(), { type: 'PUSH_HISTORY', text: 'hi' });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.inputHistory).toEqual(['hi']);
  });

  test('ENQUEUE_PENDING preserves confirmExitAt', () => {
    const next = chatReducer(armed(), {
      type: 'ENQUEUE_PENDING',
      text: 'queued',
    });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.pendingQueue).toEqual(['queued']);
  });

  test('CLEAR_PENDING preserves confirmExitAt', () => {
    const queued = chatReducer(armed(), {
      type: 'ENQUEUE_PENDING',
      text: 'a',
    });
    const next = chatReducer(queued, { type: 'CLEAR_PENDING' });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.pendingQueue).toEqual([]);
  });

  test('OPEN_SKILL_OVERLAY preserves confirmExitAt', () => {
    const next = chatReducer(armed(), { type: 'OPEN_SKILL_OVERLAY' });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.skillOverlay).toBe(true);
  });

  test('CLOSE_SKILL_OVERLAY preserves confirmExitAt', () => {
    const opened = chatReducer(armed(), { type: 'OPEN_SKILL_OVERLAY' });
    const next = chatReducer(opened, { type: 'CLOSE_SKILL_OVERLAY' });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.skillOverlay).toBe(false);
  });

  test('ADD_OUTPUT_TOKENS preserves confirmExitAt', () => {
    const next = chatReducer(armed(), {
      type: 'ADD_OUTPUT_TOKENS',
      tokens: 42,
    });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.sessionTotalOut).toBe(42);
  });

  test('SET_SESSION_TOTAL_OUT preserves confirmExitAt', () => {
    const next = chatReducer(armed(), {
      type: 'SET_SESSION_TOTAL_OUT',
      tokens: 999,
    });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.sessionTotalOut).toBe(999);
  });

  test('UPSERT_TOOL_CALL_STATE preserves confirmExitAt', () => {
    const next = chatReducer(armed(), {
      type: 'UPSERT_TOOL_CALL_STATE',
      id: 'tc-1',
      state: { toolName: 'read_file', args: {}, status: 'pending' } as never,
    });
    expect(next.confirmExitAt).toBe(7_777);
  });

  test('CLEAR_TOOL_CALL_STATES preserves confirmExitAt', () => {
    const next = chatReducer(armed(), { type: 'CLEAR_TOOL_CALL_STATES' });
    expect(next.confirmExitAt).toBe(7_777);
  });

  test('SHOW_OVERLAY preserves confirmExitAt', () => {
    const next = chatReducer(armed(), {
      type: 'SHOW_OVERLAY',
      kind: 'permissions',
    });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.overlayKind).toBe('permissions');
  });

  test('CLOSE_OVERLAY preserves confirmExitAt', () => {
    const opened = chatReducer(armed(), {
      type: 'SHOW_OVERLAY',
      kind: 'permissions',
    });
    const next = chatReducer(opened, { type: 'CLOSE_OVERLAY' });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.overlayKind).toBeNull();
  });

  test('SET_HISTORY preserves confirmExitAt', () => {
    const next = chatReducer(armed(), {
      type: 'SET_HISTORY',
      history: ['a', 'b'],
    });
    expect(next.confirmExitAt).toBe(7_777);
    expect(next.inputHistory).toEqual(['a', 'b']);
  });
});

describe('chatReducer — RESET resets confirmExitAt (R7)', () => {
  test('RESET clears confirmExitAt back to null (full reset semantics)', () => {
    const armed = chatReducer(initialChatState, {
      type: 'START_EXIT_CONFIRM',
      timestamp: 555,
    });
    const reset = chatReducer(armed, { type: 'RESET' });
    expect(reset.confirmExitAt).toBeNull();
    // Generation counter increments per the existing RESET contract.
    expect(reset.generation).toBe(armed.generation + 1);
  });
});

describe('chatReducer — full two-press window flow (R7)', () => {
  test('arm then cancel cycle', () => {
    let s: ChatState = initialChatState;
    expect(s.confirmExitAt).toBeNull();

    s = chatReducer(s, { type: 'START_EXIT_CONFIRM', timestamp: 100 });
    expect(s.confirmExitAt).toBe(100);

    s = chatReducer(s, { type: 'CANCEL_EXIT_CONFIRM' });
    expect(s.confirmExitAt).toBeNull();
  });

  test('arm → unrelated action → cancel', () => {
    let s: ChatState = initialChatState;

    s = chatReducer(s, { type: 'START_EXIT_CONFIRM', timestamp: 200 });
    s = chatReducer(s, { type: 'APPEND_CHUNK', text: 'hello' });
    expect(s.confirmExitAt).toBe(200);
    expect(s.currentOutput).toBe('hello');

    s = chatReducer(s, { type: 'CANCEL_EXIT_CONFIRM' });
    expect(s.confirmExitAt).toBeNull();
    // The unrelated state survives.
    expect(s.currentOutput).toBe('hello');
  });

  test('arm → re-arm with later timestamp updates the value', () => {
    let s: ChatState = initialChatState;
    s = chatReducer(s, { type: 'START_EXIT_CONFIRM', timestamp: 100 });
    s = chatReducer(s, { type: 'START_EXIT_CONFIRM', timestamp: 250 });
    expect(s.confirmExitAt).toBe(250);
  });
});
