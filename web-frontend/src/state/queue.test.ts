/**
 * Pending-queue slice — pure store actions.
 *
 * Covers the QUEUE-NEXT-STORE-SECTION contract:
 *   - enqueueMessage: trims whitespace-only, returns the assigned id,
 *     appends to the tail (FIFO).
 *   - dequeueMessage: removes by id, no-op on unknown id.
 *   - drainPendingQueue: returns prior items in FIFO order and empties.
 *   - clearPendingQueue: empties without returning.
 */

import { beforeEach, describe, expect, test } from 'vitest';

import { useStore } from './store';

beforeEach(() => {
  useStore.getState().clearPendingQueue();
});

describe('pendingQueue store slice', () => {
  test('enqueueMessage appends items in FIFO order with stable ids', () => {
    const id1 = useStore.getState().enqueueMessage('first');
    const id2 = useStore.getState().enqueueMessage('second');
    const id3 = useStore.getState().enqueueMessage('third');

    const queue = useStore.getState().pendingQueue;
    expect(queue).toHaveLength(3);
    expect(queue.map((it) => it.content)).toEqual(['first', 'second', 'third']);
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id3).toBeTruthy();
    expect(new Set([id1, id2, id3]).size).toBe(3);
  });

  test('enqueueMessage trims and rejects whitespace-only input', () => {
    expect(useStore.getState().enqueueMessage('   ')).toBeNull();
    expect(useStore.getState().enqueueMessage('\n\t\n')).toBeNull();
    expect(useStore.getState().enqueueMessage('')).toBeNull();
    expect(useStore.getState().pendingQueue).toHaveLength(0);
  });

  test('enqueueMessage assigns createdAt timestamps', () => {
    const before = Date.now();
    useStore.getState().enqueueMessage('hello');
    const after = Date.now();
    const item = useStore.getState().pendingQueue[0];
    expect(item).toBeDefined();
    if (item !== undefined) {
      expect(item.createdAt).toBeGreaterThanOrEqual(before);
      expect(item.createdAt).toBeLessThanOrEqual(after);
    }
  });

  test('dequeueMessage removes the matching id and preserves order', () => {
    const id1 = useStore.getState().enqueueMessage('a');
    const id2 = useStore.getState().enqueueMessage('b');
    useStore.getState().enqueueMessage('c');
    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    if (id2 === null) return;

    useStore.getState().dequeueMessage(id2);
    const remaining = useStore.getState().pendingQueue.map((it) => it.content);
    expect(remaining).toEqual(['a', 'c']);
  });

  test('dequeueMessage on unknown id is a no-op (identity-stable)', () => {
    useStore.getState().enqueueMessage('only');
    const prior = useStore.getState().pendingQueue;
    useStore.getState().dequeueMessage('pending-does-not-exist');
    const after = useStore.getState().pendingQueue;
    expect(after).toBe(prior);
  });

  test('drainPendingQueue returns FIFO snapshot and empties the queue', () => {
    useStore.getState().enqueueMessage('one');
    useStore.getState().enqueueMessage('two');
    useStore.getState().enqueueMessage('three');
    const drained = useStore.getState().drainPendingQueue();
    expect(drained.map((it) => it.content)).toEqual(['one', 'two', 'three']);
    expect(useStore.getState().pendingQueue).toHaveLength(0);
  });

  test('drainPendingQueue on empty queue returns an empty list (no throw)', () => {
    expect(useStore.getState().drainPendingQueue()).toHaveLength(0);
  });

  test('clearPendingQueue empties without returning', () => {
    useStore.getState().enqueueMessage('x');
    useStore.getState().enqueueMessage('y');
    useStore.getState().clearPendingQueue();
    expect(useStore.getState().pendingQueue).toHaveLength(0);
  });
});
