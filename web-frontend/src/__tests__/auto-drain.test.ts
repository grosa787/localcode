/**
 * Auto-drain on `done` — QUEUE-AUTODRAIN-SECTION contract test.
 *
 * Mirrors the logic in components/ChatView.tsx (`case 'done':` branch).
 * That code path is hand-tested in the UI; the unit-level guarantee we
 * lock here is that the drain primitive in the Zustand store:
 *
 *   1. Pops the queue in FIFO order on `done`.
 *   2. Joins the items into a single follow-up message body with `\n\n`.
 *   3. Leaves the queue empty so a second `done` (idempotent) is a no-op.
 *   4. Re-fills correctly if more user input arrives between turns.
 *
 * Note: the bunfig.toml ignores `web-frontend/**` for `bun test`, so this
 * file is only run by vitest (`vitest run` from web-frontend/). That's
 * the intended placement — the test exercises the React store contract,
 * not the Bun-side runtime.
 */

import { beforeEach, describe, expect, test } from 'vitest';

import { useStore } from '../state/store';

/**
 * Mirror of the drain block in ChatView.tsx's `case 'done':`. Keeping a
 * copy here lets us exercise the contract under unit-test timing
 * guarantees (queueMicrotask makes the production code asynchronous; we
 * test the synchronous primitives that block builds on).
 */
function simulateDoneDrain(): string | null {
  const drained = useStore.getState().drainPendingQueue();
  if (drained.length === 0) return null;
  return drained.map((it) => it.content).join('\n\n');
}

beforeEach(() => {
  useStore.getState().clearPendingQueue();
});

describe('QUEUE-AUTODRAIN-SECTION — drain on `done`', () => {
  test('drains FIFO and joins items with double newline', () => {
    useStore.getState().enqueueMessage('hello');
    useStore.getState().enqueueMessage('и пока я помню');
    useStore.getState().enqueueMessage('напомни про X');

    const out = simulateDoneDrain();
    expect(out).toBe('hello\n\nи пока я помню\n\nнапомни про X');
    expect(useStore.getState().pendingQueue).toHaveLength(0);
  });

  test('duplicate `done` is a no-op once the queue is empty', () => {
    useStore.getState().enqueueMessage('only');
    expect(simulateDoneDrain()).toBe('only');
    expect(simulateDoneDrain()).toBeNull();
    expect(useStore.getState().pendingQueue).toHaveLength(0);
  });

  test('queue refills correctly between drains (turn-to-turn lifecycle)', () => {
    useStore.getState().enqueueMessage('turn-1-message');
    expect(simulateDoneDrain()).toBe('turn-1-message');

    useStore.getState().enqueueMessage('turn-2-a');
    useStore.getState().enqueueMessage('turn-2-b');
    expect(simulateDoneDrain()).toBe('turn-2-a\n\nturn-2-b');
    expect(useStore.getState().pendingQueue).toHaveLength(0);
  });

  test('per-item dequeue mid-queue survives the drain and preserves order', () => {
    useStore.getState().enqueueMessage('a');
    const id = useStore.getState().enqueueMessage('b');
    useStore.getState().enqueueMessage('c');
    expect(id).not.toBeNull();
    if (id !== null) useStore.getState().dequeueMessage(id);
    expect(simulateDoneDrain()).toBe('a\n\nc');
  });
});
