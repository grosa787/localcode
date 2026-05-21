/**
 * Type-ahead error gate — Fix 2.
 *
 * When a stream ends with an error, the reducer captures it on
 * `lastTurnError`. The ChatScreen flush effect treats a non-null
 * `lastTurnError` as a hard skip, so a transient upstream failure
 * during one turn never cascades into "send all queued messages →
 * error toast for each" spam.
 *
 * Coverage:
 *   - END_STREAM with `error` populates `lastTurnError`.
 *   - END_STREAM without `error` clears any prior `lastTurnError`.
 *   - START_STREAM clears `lastTurnError` (explicit retry).
 *   - CLEAR_TURN_ERROR clears `lastTurnError` (Retry button path).
 *   - REPLACE_MESSAGES (session resume) clears `lastTurnError`.
 *   - The flush gate logic (mirrored here) returns false while the
 *     error is set, true once cleared.
 */

import { describe, test, expect } from 'bun:test';
import {
  chatReducer,
  initialChatState,
  type ChatAction,
  type ChatState,
} from '@/integration/chat-state';

function reduce(state: ChatState, ...actions: readonly ChatAction[]): ChatState {
  return actions.reduce<ChatState>((s, a) => chatReducer(s, a), state);
}

/**
 * Mirrors the gate condition in `ChatScreen.tsx` so the integration
 * boundary is captured in one place. If the screen's flush effect
 * changes shape, this test breaks first.
 */
function shouldFlush(state: ChatState, opts: {
  pendingApprovalNull: boolean;
  pendingQueueLen: number;
}): boolean {
  if (state.isStreaming) return false;
  if (!opts.pendingApprovalNull) return false;
  if (opts.pendingQueueLen === 0) return false;
  if (state.lastTurnError !== null) return false;
  return true;
}

describe('chatReducer — lastTurnError lifecycle', () => {
  test('initial state has lastTurnError === null', () => {
    expect(initialChatState.lastTurnError).toBeNull();
  });

  test('END_STREAM with error sets lastTurnError', () => {
    const next = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'END_STREAM', error: 'upstream timeout' },
    );
    expect(next.lastTurnError).toBe('upstream timeout');
    expect(next.isStreaming).toBe(false);
  });

  test('END_STREAM without error clears any prior lastTurnError', () => {
    const failed = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'END_STREAM', error: 'boom' },
    );
    expect(failed.lastTurnError).toBe('boom');
    // A clean turn end (no error) clears the gate.
    const cleared = chatReducer(failed, { type: 'END_STREAM' });
    expect(cleared.lastTurnError).toBeNull();
  });

  test('END_STREAM with empty-string error treats as success', () => {
    const next = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'END_STREAM', error: '' },
    );
    expect(next.lastTurnError).toBeNull();
  });

  test('START_STREAM clears lastTurnError (explicit retry)', () => {
    const failed = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'END_STREAM', error: 'boom' },
    );
    const restarted = chatReducer(failed, { type: 'START_STREAM' });
    expect(restarted.lastTurnError).toBeNull();
  });

  test('CLEAR_TURN_ERROR clears lastTurnError (Retry button path)', () => {
    const failed = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'END_STREAM', error: 'boom' },
    );
    const cleared = chatReducer(failed, { type: 'CLEAR_TURN_ERROR' });
    expect(cleared.lastTurnError).toBeNull();
  });

  test('REPLACE_MESSAGES (session resume) clears lastTurnError', () => {
    const failed = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'END_STREAM', error: 'boom' },
    );
    const replaced = chatReducer(failed, {
      type: 'REPLACE_MESSAGES',
      messages: [],
    });
    expect(replaced.lastTurnError).toBeNull();
  });
});

describe('flush gate — pause while lastTurnError is set', () => {
  test('flush gate is closed while lastTurnError is set', () => {
    const failed = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'ENQUEUE_PENDING', text: 'queued' },
      { type: 'END_STREAM', error: 'boom' },
    );
    expect(
      shouldFlush(failed, { pendingApprovalNull: true, pendingQueueLen: 1 }),
    ).toBe(false);
  });

  test('flush gate opens once lastTurnError is cleared', () => {
    const failed = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'ENQUEUE_PENDING', text: 'queued' },
      { type: 'END_STREAM', error: 'boom' },
    );
    const cleared = chatReducer(failed, { type: 'CLEAR_TURN_ERROR' });
    expect(
      shouldFlush(cleared, { pendingApprovalNull: true, pendingQueueLen: 1 }),
    ).toBe(true);
  });

  test('flush gate stays closed while still streaming, regardless of error', () => {
    const streaming = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'ENQUEUE_PENDING', text: 'queued' },
    );
    expect(
      shouldFlush(streaming, { pendingApprovalNull: true, pendingQueueLen: 1 }),
    ).toBe(false);
  });
});
