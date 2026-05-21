/**
 * Reducer-level coverage for the type-ahead-while-busy queue actions
 * (`ENQUEUE_PENDING` / `CLEAR_PENDING`).
 *
 * The ChatScreen owns the flush effect (concatenate + onSubmit), but
 * the underlying queue slice in `ChatState.pendingQueue` is mirrored
 * in the reducer so any caller — including tests, future overlays,
 * and replay harnesses — can drive it without rendering React.
 *
 * Coverage:
 *   - enqueue appends to the tail
 *   - enqueue twice preserves order (oldest-first)
 *   - empty / whitespace-only is rejected (idempotent state)
 *   - clear empties the queue
 *   - START_STREAM / END_STREAM do NOT touch the queue
 *   - concatenation policy demo: the array can be `\n\n`-joined to
 *     produce the flush payload (single source of truth for the
 *     ChatScreen flush effect).
 *
 * Note: the legacy `ENQUEUE_INPUT` / `DEQUEUE_INPUT` / `CLEAR_QUEUE`
 * triplet was removed when the dual-queue split was unified — the
 * reducer now owns the single source of truth and ChatScreen reads it
 * via props. Any test that previously asserted back-compat for those
 * action names has been migrated to `ENQUEUE_PENDING` / `CLEAR_PENDING`.
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

describe('chatReducer — ENQUEUE_PENDING / CLEAR_PENDING', () => {
  test('enqueue appends to pendingQueue', () => {
    const next = chatReducer(initialChatState, {
      type: 'ENQUEUE_PENDING',
      text: 'hello',
    });
    expect(next.pendingQueue).toEqual(['hello']);
  });

  test('enqueue twice preserves oldest-first order', () => {
    const next = reduce(
      initialChatState,
      { type: 'ENQUEUE_PENDING', text: 'first' },
      { type: 'ENQUEUE_PENDING', text: 'second' },
    );
    expect(next.pendingQueue).toEqual(['first', 'second']);
  });

  test('enqueue accepts duplicate strings (no dedupe)', () => {
    const next = reduce(
      initialChatState,
      { type: 'ENQUEUE_PENDING', text: 'same' },
      { type: 'ENQUEUE_PENDING', text: 'same' },
    );
    expect(next.pendingQueue).toEqual(['same', 'same']);
  });

  test('enqueue rejects empty string (idempotent)', () => {
    const next = chatReducer(initialChatState, {
      type: 'ENQUEUE_PENDING',
      text: '',
    });
    expect(next).toBe(initialChatState);
    expect(next.pendingQueue).toEqual([]);
  });

  test('enqueue rejects whitespace-only string (idempotent)', () => {
    const next = chatReducer(initialChatState, {
      type: 'ENQUEUE_PENDING',
      text: '   \n\t  ',
    });
    expect(next).toBe(initialChatState);
    expect(next.pendingQueue).toEqual([]);
  });

  test('CLEAR_PENDING empties a non-empty queue', () => {
    const queued = reduce(
      initialChatState,
      { type: 'ENQUEUE_PENDING', text: 'a' },
      { type: 'ENQUEUE_PENDING', text: 'b' },
    );
    expect(queued.pendingQueue.length).toBe(2);
    const cleared = chatReducer(queued, { type: 'CLEAR_PENDING' });
    expect(cleared.pendingQueue).toEqual([]);
  });

  test('CLEAR_PENDING is a no-op shape on an empty queue', () => {
    const next = chatReducer(initialChatState, { type: 'CLEAR_PENDING' });
    expect(next.pendingQueue).toEqual([]);
  });
});

describe('chatReducer — stream lifecycle does not touch pendingQueue', () => {
  test('START_STREAM preserves pendingQueue', () => {
    const queued = chatReducer(initialChatState, {
      type: 'ENQUEUE_PENDING',
      text: 'queued',
    });
    const started = chatReducer(queued, { type: 'START_STREAM' });
    expect(started.isStreaming).toBe(true);
    expect(started.pendingQueue).toEqual(['queued']);
  });

  test('END_STREAM preserves pendingQueue (flush is explicit)', () => {
    const queued = reduce(
      initialChatState,
      { type: 'START_STREAM' },
      { type: 'ENQUEUE_PENDING', text: 'one' },
      { type: 'ENQUEUE_PENDING', text: 'two' },
    );
    const ended = chatReducer(queued, { type: 'END_STREAM' });
    expect(ended.isStreaming).toBe(false);
    // The flush is the ChatScreen's job; the reducer must NOT eagerly
    // wipe the queue on END_STREAM, otherwise the ChatScreen effect
    // would never see the items.
    expect(ended.pendingQueue).toEqual(['one', 'two']);
  });
});

describe('chatReducer — flush concatenation policy demo', () => {
  test('joining the queue with \\n\\n yields the flush payload', () => {
    const queued = reduce(
      initialChatState,
      { type: 'ENQUEUE_PENDING', text: 'first thought' },
      { type: 'ENQUEUE_PENDING', text: 'second thought' },
      { type: 'ENQUEUE_PENDING', text: 'third thought' },
    );
    const payload = queued.pendingQueue.join('\n\n');
    expect(payload).toBe('first thought\n\nsecond thought\n\nthird thought');
  });
});

describe('chatReducer — legacy queue actions have been removed', () => {
  // The dual-queue split (ChatScreen useState + reducer pendingQueue) was
  // unified into a single reducer-owned slice. The legacy
  // `ENQUEUE_INPUT` / `DEQUEUE_INPUT` / `CLEAR_QUEUE` actions are gone;
  // any caller that needs to mutate the queue now uses
  // `ENQUEUE_PENDING` / `CLEAR_PENDING`. The action-type guard below
  // ensures the union never re-grows the legacy variants without a
  // matching back-compat plan.
  test('ChatAction union does not re-introduce ENQUEUE_INPUT', () => {
    type LegacyEnqueue = Extract<ChatAction, { type: 'ENQUEUE_INPUT' }>;
    const _legacyEnqueueIsNever: LegacyEnqueue extends never ? true : false = true;
    void _legacyEnqueueIsNever;
    type LegacyDequeue = Extract<ChatAction, { type: 'DEQUEUE_INPUT' }>;
    const _legacyDequeueIsNever: LegacyDequeue extends never ? true : false = true;
    void _legacyDequeueIsNever;
    type LegacyClear = Extract<ChatAction, { type: 'CLEAR_QUEUE' }>;
    const _legacyClearIsNever: LegacyClear extends never ? true : false = true;
    void _legacyClearIsNever;
    expect(true).toBe(true);
  });
});
