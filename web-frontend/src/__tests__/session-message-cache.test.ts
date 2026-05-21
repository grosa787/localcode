/**
 * Tests for the per-session message cache slice on the Zustand store.
 *
 * The cache backs ChatView's instant session-switch rehydrate — when a
 * user toggles between sessions, ChatView reads from this map first so
 * the chat surface populates synchronously, before the WS `subscribed`
 * frame arrives.
 */

import { beforeEach, describe, expect, test } from 'vitest';

import type { WireChatMessage } from '../../../src/web/protocol/messages.js';
import { SESSION_CACHE_MAX, useStore } from '../state/store';

function userMsg(id: string, content: string, createdAt = 0): WireChatMessage {
  return { id, role: 'user', content, createdAt };
}

beforeEach(() => {
  // Wipe the cache + parallel maps between tests; other slices are not
  // under test here. We must reset all three or the LRU order leaks
  // between tests.
  useStore.setState({
    sessionMessages: {},
    sessionMessageIds: {},
    sessionMessagesOrder: [],
  });
});

describe('sessionMessages cache', () => {
  test('setSessionMessages stores a snapshot under the session id', () => {
    const msgs = [userMsg('m1', 'hi'), userMsg('m2', 'there', 1)];
    useStore.getState().setSessionMessages('s1', msgs);
    const stored = useStore.getState().sessionMessages['s1'];
    expect(stored).toEqual(msgs);
    // Defensive copy — caller can mutate input without poisoning cache.
    expect(stored).not.toBe(msgs);
  });

  test('setSessionMessages overwrites an existing entry (server wins)', () => {
    useStore.getState().setSessionMessages('s1', [userMsg('m1', 'old')]);
    useStore.getState().setSessionMessages('s1', [userMsg('m1', 'new'), userMsg('m2', 'extra')]);
    const stored = useStore.getState().sessionMessages['s1'];
    expect(stored).toHaveLength(2);
    expect(stored?.[0]?.content).toBe('new');
  });

  test('appendSessionMessage extends the cache and is idempotent on id', () => {
    useStore.getState().setSessionMessages('s1', [userMsg('m1', 'a')]);
    useStore.getState().appendSessionMessage('s1', userMsg('m2', 'b'));
    expect(useStore.getState().sessionMessages['s1']).toHaveLength(2);
    // Re-append the same id → no-op (protects against WS replay double-commit).
    useStore.getState().appendSessionMessage('s1', userMsg('m2', 'b'));
    expect(useStore.getState().sessionMessages['s1']).toHaveLength(2);
  });

  test('appendSessionMessage initialises an empty entry on first append', () => {
    useStore.getState().appendSessionMessage('fresh', userMsg('m1', 'first'));
    expect(useStore.getState().sessionMessages['fresh']).toEqual([
      userMsg('m1', 'first'),
    ]);
  });

  test('clearSessionMessages removes a single session without touching others', () => {
    useStore.getState().setSessionMessages('s1', [userMsg('m1', 'x')]);
    useStore.getState().setSessionMessages('s2', [userMsg('n1', 'y')]);
    useStore.getState().clearSessionMessages('s1');
    expect(useStore.getState().sessionMessages['s1']).toBeUndefined();
    expect(useStore.getState().sessionMessages['s2']).toHaveLength(1);
  });

  test('clearSessionMessages on a missing session is a no-op', () => {
    const before = useStore.getState().sessionMessages;
    useStore.getState().clearSessionMessages('never-existed');
    expect(useStore.getState().sessionMessages).toBe(before);
  });
});

describe('sessionMessages LRU eviction', () => {
  test('SESSION_CACHE_MAX is exposed for tests', () => {
    expect(SESSION_CACHE_MAX).toBe(5);
  });

  test('evicts the oldest entry when the cache exceeds SESSION_CACHE_MAX', () => {
    const s = useStore.getState();
    // Fill the cache exactly to the limit.
    for (let i = 0; i < SESSION_CACHE_MAX; i++) {
      s.setSessionMessages(`s${i}`, [userMsg(`m${i}`, `c${i}`)]);
    }
    // All five present.
    const before = useStore.getState().sessionMessages;
    for (let i = 0; i < SESSION_CACHE_MAX; i++) {
      expect(before[`s${i}`]).toBeDefined();
    }
    // One more push → head (s0) is evicted.
    s.setSessionMessages('s5', [userMsg('m5', 'c5')]);
    const after = useStore.getState().sessionMessages;
    expect(after['s0']).toBeUndefined();
    expect(after['s5']).toBeDefined();
    // The order slice tracks MRU at the tail.
    const order = useStore.getState().sessionMessagesOrder;
    expect(order[order.length - 1]).toBe('s5');
    // Parallel id-set is evicted in lockstep.
    expect(useStore.getState().sessionMessageIds['s0']).toBeUndefined();
    expect(useStore.getState().sessionMessageIds['s5']).toBeDefined();
  });

  test('re-accessing a session promotes it to MRU and protects from eviction', () => {
    const s = useStore.getState();
    // Insert s0..s4 (fills cache).
    for (let i = 0; i < SESSION_CACHE_MAX; i++) {
      s.setSessionMessages(`s${i}`, [userMsg(`m${i}`, `c${i}`)]);
    }
    // Touch s0 → promoted to MRU tail; s1 is now the LRU head.
    s.setSessionMessages('s0', [userMsg('m0v2', 'updated')]);
    // Inserting s5 should evict s1 (not s0).
    s.setSessionMessages('s5', [userMsg('m5', 'c5')]);
    const after = useStore.getState().sessionMessages;
    expect(after['s0']).toBeDefined();
    expect(after['s1']).toBeUndefined();
    expect(after['s5']).toBeDefined();
  });

  test('appendSessionMessage also triggers eviction and MRU promotion', () => {
    const s = useStore.getState();
    for (let i = 0; i < SESSION_CACHE_MAX; i++) {
      s.setSessionMessages(`s${i}`, [userMsg(`m${i}`, `c${i}`)]);
    }
    // Append into s2 → promotes it; s0 is still the LRU head.
    s.appendSessionMessage('s2', userMsg('m2-extra', 'extra'));
    expect(useStore.getState().sessionMessages['s2']).toHaveLength(2);
    // Append into a brand-new session → eviction of s0 (oldest).
    s.appendSessionMessage('s5', userMsg('m5', 'c5'));
    const after = useStore.getState().sessionMessages;
    expect(after['s0']).toBeUndefined();
    expect(after['s5']).toHaveLength(1);
    // s2 is still cached (it was promoted ahead of the eviction).
    expect(after['s2']).toHaveLength(2);
  });

  test('clearSessionMessages drops the session from the order slice', () => {
    const s = useStore.getState();
    s.setSessionMessages('s1', [userMsg('m1', 'a')]);
    s.setSessionMessages('s2', [userMsg('m2', 'b')]);
    expect(useStore.getState().sessionMessagesOrder).toEqual(['s1', 's2']);
    s.clearSessionMessages('s1');
    expect(useStore.getState().sessionMessagesOrder).toEqual(['s2']);
    expect(useStore.getState().sessionMessageIds['s1']).toBeUndefined();
  });
});

describe('sessionMessages internal state', () => {
  test('appendSessionMessage maintains the parallel id-set for O(1) dedup', () => {
    const s = useStore.getState();
    s.setSessionMessages('s1', [userMsg('m1', 'a')]);
    expect(useStore.getState().sessionMessageIds['s1']?.has('m1')).toBe(true);
    s.appendSessionMessage('s1', userMsg('m2', 'b'));
    expect(useStore.getState().sessionMessageIds['s1']?.has('m2')).toBe(true);
    // Idempotent — same id is not re-appended.
    s.appendSessionMessage('s1', userMsg('m2', 'duplicate'));
    expect(useStore.getState().sessionMessages['s1']).toHaveLength(2);
  });

  test('setSessionMessagesIfChanged is a no-op when the array reference is unchanged', () => {
    const s = useStore.getState();
    const msgs = [userMsg('m1', 'a'), userMsg('m2', 'b')];
    s.setSessionMessages('s1', msgs);
    const snapshotMessages = useStore.getState().sessionMessages;
    // Pass the exact-same array that's currently stored as the slot — we
    // need the stored array (defensive-copy from setSessionMessages),
    // not the input.
    const stored = snapshotMessages['s1'];
    expect(stored).toBeDefined();
    if (stored === undefined) return;
    s.setSessionMessagesIfChanged('s1', stored);
    // Outer map identity preserved — no subscriber re-render.
    expect(useStore.getState().sessionMessages).toBe(snapshotMessages);
  });

  test('setSessionMessagesIfChanged writes when the array reference differs', () => {
    const s = useStore.getState();
    s.setSessionMessages('s1', [userMsg('m1', 'a')]);
    const before = useStore.getState().sessionMessages;
    s.setSessionMessagesIfChanged('s1', [userMsg('m1', 'a'), userMsg('m2', 'b')]);
    expect(useStore.getState().sessionMessages).not.toBe(before);
    expect(useStore.getState().sessionMessages['s1']).toHaveLength(2);
  });
});
