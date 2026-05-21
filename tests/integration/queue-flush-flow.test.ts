/**
 * End-to-end integration coverage for the unified type-ahead queue.
 *
 * Background: ChatScreen used to mirror the reducer's `pendingQueue`
 * in a local `useState` slice; the two queues never shared data and
 * could drift if any other caller dispatched `ENQUEUE_PENDING` while
 * ChatScreen was mounted. The refactor unified them — the reducer is
 * the single source of truth, ChatScreen reads via props, and
 * `onEnqueuePending` / `onClearPending` are the only mutation paths.
 *
 * This file simulates the wire-up exposed by `app.tsx`:
 *   - `onEnqueuePending(text)` dispatches `ENQUEUE_PENDING`.
 *   - `onClearPending()`         dispatches `CLEAR_PENDING`.
 *   - The ChatScreen flush mirrors `chatState.pendingQueue.join('\n\n')`
 *     and dispatches `onClearPending` BEFORE `onSubmit(concatenated)`.
 *
 * The reducer is exercised directly here (no React mount). The
 * reducer + the flush-gate predicate (mirrored from ChatScreen's
 * effect) together capture every transition the user-visible queue
 * walks through.
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
 * Mirror of the ChatScreen flush gate. The screen's effect runs
 * concat+submit when this predicate is true (and the re-entrancy
 * `flushedRef` hasn't already fired for the current gate-open window).
 */
function shouldFlush(state: ChatState): boolean {
  if (state.isStreaming) return false;
  if (state.pendingApproval !== null) return false;
  if (state.pendingQueue.length === 0) return false;
  if (state.lastTurnError !== null) return false;
  return true;
}

/**
 * Simulates what ChatScreen's flush effect does once `shouldFlush`
 * returns true: concatenate, dispatch CLEAR_PENDING (via the
 * `onClearPending` callback in production), return the joined payload
 * for the host's `onSubmit`. The order matters — clear precedes the
 * onSubmit so the next render observes an empty queue.
 */
function flush(state: ChatState): { state: ChatState; payload: string } {
  const payload = state.pendingQueue.join('\n\n');
  const cleared = chatReducer(state, { type: 'CLEAR_PENDING' });
  return { state: cleared, payload };
}

describe('queue-flush-flow — submit during stream → flush on done', () => {
  test('streaming-time submits accumulate, flush on END_STREAM', () => {
    // 1. Start with an active stream.
    let state = chatReducer(initialChatState, { type: 'START_STREAM' });
    expect(state.isStreaming).toBe(true);
    expect(shouldFlush(state)).toBe(false);

    // 2. User submits two type-ahead messages while streaming. These
    //    flow through ChatScreen.submit → props.onEnqueuePending →
    //    chatDispatch({ type: 'ENQUEUE_PENDING', ... }).
    state = reduce(
      state,
      { type: 'ENQUEUE_PENDING', text: 'follow-up one' },
      { type: 'ENQUEUE_PENDING', text: 'follow-up two' },
    );
    expect(state.pendingQueue).toEqual(['follow-up one', 'follow-up two']);
    // Still no flush — stream is in flight.
    expect(shouldFlush(state)).toBe(false);

    // 3. Stream ends cleanly (END_STREAM with no error). The flush
    //    gate opens.
    state = chatReducer(state, { type: 'END_STREAM' });
    expect(state.isStreaming).toBe(false);
    expect(state.lastTurnError).toBeNull();
    expect(shouldFlush(state)).toBe(true);

    // 4. ChatScreen's flush effect concatenates and dispatches
    //    CLEAR_PENDING → onSubmit. Reducer state ends with an empty
    //    queue; the payload reads as two paragraphs.
    const { state: afterFlush, payload } = flush(state);
    expect(payload).toBe('follow-up one\n\nfollow-up two');
    expect(afterFlush.pendingQueue).toEqual([]);
    expect(shouldFlush(afterFlush)).toBe(false);
  });

  test('error gate suppresses flush until the user clears the error', () => {
    // Stream fails with a transient upstream error. The lastTurnError
    // gate stays armed and the queue does NOT auto-drain.
    let state = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'ENQUEUE_PENDING', text: 'will not fire until cleared' },
      { type: 'END_STREAM', error: 'upstream timeout' },
    );
    expect(state.lastTurnError).toBe('upstream timeout');
    expect(state.pendingQueue.length).toBe(1);
    expect(shouldFlush(state)).toBe(false);

    // User hits Ctrl+R (retry) → app dispatches CLEAR_TURN_ERROR.
    state = chatReducer(state, { type: 'CLEAR_TURN_ERROR' });
    expect(shouldFlush(state)).toBe(true);

    // Flush now drains the survivor.
    const { state: afterFlush, payload } = flush(state);
    expect(payload).toBe('will not fire until cleared');
    expect(afterFlush.pendingQueue).toEqual([]);
  });

  test('Ctrl+X discards both queue and error', () => {
    // Same setup as above — failed stream with queued tail.
    let state = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'ENQUEUE_PENDING', text: 'discard me' },
      { type: 'END_STREAM', error: 'boom' },
    );
    expect(state.pendingQueue.length).toBe(1);
    expect(state.lastTurnError).toBe('boom');

    // Ctrl+X path: app dispatches CLEAR_PENDING + CLEAR_TURN_ERROR.
    state = reduce(
      state,
      { type: 'CLEAR_PENDING' },
      { type: 'CLEAR_TURN_ERROR' },
    );
    expect(state.pendingQueue).toEqual([]);
    expect(state.lastTurnError).toBeNull();
    // Gate is open but queue is empty — no flush.
    expect(shouldFlush(state)).toBe(false);
  });

  test('double-Esc clear empties the queue without a flush', () => {
    // User queues a regret-message during streaming, then double-Esc.
    let state = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'ENQUEUE_PENDING', text: 'on second thought, drop this' },
    );
    expect(state.pendingQueue.length).toBe(1);

    // Double-Esc dispatches CLEAR_PENDING (the second Esc also fires
    // onCancel, which the app translates into END_STREAM via the
    // adapter's cancel callback). For this gate-level test we just
    // assert the queue is empty regardless of stream state.
    state = chatReducer(state, { type: 'CLEAR_PENDING' });
    expect(state.pendingQueue).toEqual([]);
  });

  test('pendingApproval blocks the flush even after stream ends', () => {
    // Stream finishes but an approval is pending — the queue waits
    // for the y/n decision.
    let state = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'ENQUEUE_PENDING', text: 'queued during stream' },
      { type: 'END_STREAM' },
      {
        type: 'SET_PENDING_APPROVAL',
        approval: {
          id: 'a1',
          kind: 'generic',
          title: 'allow?',
          description: '',
        },
      },
    );
    expect(state.pendingApproval).not.toBeNull();
    expect(shouldFlush(state)).toBe(false);

    // Approve → app clears the approval. Flush opens.
    state = chatReducer(state, {
      type: 'SET_PENDING_APPROVAL',
      approval: null,
    });
    expect(shouldFlush(state)).toBe(true);

    const { state: afterFlush, payload } = flush(state);
    expect(payload).toBe('queued during stream');
    expect(afterFlush.pendingQueue).toEqual([]);
  });

  test('session resume (REPLACE_MESSAGES) clears the queue side-channel state', () => {
    // While a stream is in flight the user enqueues, then runs
    // /resume → REPLACE_MESSAGES. The reducer wipes streaming +
    // turn-error state but NOT the queue (REPLACE_MESSAGES leaves
    // pendingQueue alone — see chat-state.ts). The host is expected
    // to dispatch CLEAR_PENDING explicitly on session switch; we
    // simulate that here so the test pins the contract.
    let state = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'ENQUEUE_PENDING', text: 'stale from previous session' },
    );
    state = chatReducer(state, { type: 'REPLACE_MESSAGES', messages: [] });
    // REPLACE_MESSAGES does not touch the queue — host must clear.
    expect(state.pendingQueue).toEqual(['stale from previous session']);
    state = chatReducer(state, { type: 'CLEAR_PENDING' });
    expect(state.pendingQueue).toEqual([]);
  });

  test('whitespace-only ENQUEUE_PENDING is rejected — no flush of "\\n\\n" garbage', () => {
    // Two real submissions surrounding a whitespace-only submission.
    // The reducer guard drops the empty entry so the eventual flush
    // payload reads as two paragraphs (not three with an empty
    // middle line). Important because the join is `\n\n` — an empty
    // middle would produce a `\n\n\n\n` quartet the model would read
    // as a paragraph break with an empty paragraph in between.
    const state = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'ENQUEUE_PENDING', text: 'real one' },
      { type: 'ENQUEUE_PENDING', text: '   \t\n  ' },
      { type: 'ENQUEUE_PENDING', text: 'real two' },
      { type: 'END_STREAM' },
    );
    expect(state.pendingQueue).toEqual(['real one', 'real two']);
    const { payload } = flush(state);
    expect(payload).toBe('real one\n\nreal two');
  });
});
