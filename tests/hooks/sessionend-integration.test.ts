/**
 * RuntimePool ↔ SessionEnd hook wiring.
 *
 * Verifies the pool fires `onSessionEnd` with the correct cause at
 * every tear-down site:
 *   - `pool.release(id)` → `'user_quit'`.
 *   - LRU eviction triggered by `getOrCreate` at the hard cap →
 *     `'evicted'`.
 *   - `pool.dispose()` → `'shutdown'` (once per resident runtime, AND
 *     awaits each `runtime.dispose()` so the caller can sequence
 *     teardown before stopping the server).
 *
 * Uses a lightweight fake `ChatRuntime` shaped to satisfy the pool's
 * structural use of `runtime.streaming` + `runtime.dispose()`. The
 * pool only reads these two members, so we don't need the full
 * runtime surface here.
 */

import { describe, expect, test } from 'bun:test';

import {
  RuntimePool,
  type RuntimePoolEndReason,
} from '@/web/runtime/runtime-pool';
import type { ChatRuntime } from '@/web/runtime/chat-runtime';

interface FakeRuntime {
  streaming: boolean;
  disposed: boolean;
  dispose: () => Promise<void>;
}

function makeFake(streaming = false): FakeRuntime {
  const f: FakeRuntime = {
    streaming,
    disposed: false,
    dispose: async () => {
      f.disposed = true;
    },
  };
  return f;
}

function asChatRuntime(f: FakeRuntime): ChatRuntime {
  return f as unknown as ChatRuntime;
}

describe('RuntimePool.release fires SessionEnd with user_quit', () => {
  test('release(id) reports user_quit exactly once', () => {
    const events: Array<{ id: string; reason: RuntimePoolEndReason }> = [];
    const pool = new RuntimePool({
      onSessionEnd: (id, reason) => events.push({ id, reason }),
    });
    pool.getOrCreate('s1', () => asChatRuntime(makeFake()));
    pool.release('s1');
    expect(events).toEqual([{ id: 's1', reason: 'user_quit' }]);
    // Releasing a missing id is a no-op.
    pool.release('s1');
    expect(events.length).toBe(1);
  });
});

describe('RuntimePool eviction fires SessionEnd with evicted', () => {
  test('LRU eviction reports evicted for the dropped entry', () => {
    const events: Array<{ id: string; reason: RuntimePoolEndReason }> = [];
    const pool = new RuntimePool({
      maxSize: 2,
      onSessionEnd: (id, reason) => events.push({ id, reason }),
    });
    pool.getOrCreate('a', () => asChatRuntime(makeFake()));
    pool.getOrCreate('b', () => asChatRuntime(makeFake()));
    // 'a' was touched first → it's the oldest, should be evicted.
    pool.getOrCreate('c', () => asChatRuntime(makeFake()));
    expect(events).toEqual([{ id: 'a', reason: 'evicted' }]);
    expect(pool.get('a')).toBeUndefined();
    expect(pool.get('b')).toBeDefined();
    expect(pool.get('c')).toBeDefined();
  });

  test('idle reap also reports evicted', async () => {
    const events: Array<{ id: string; reason: RuntimePoolEndReason }> = [];
    // 1 ms idle window so the next getOrCreate triggers the reap.
    const pool = new RuntimePool({
      idleTimeoutMs: 1,
      onSessionEnd: (id, reason) => events.push({ id, reason }),
    });
    pool.getOrCreate('s1', () => asChatRuntime(makeFake()));
    await new Promise((r) => setTimeout(r, 20));
    // Force a reap-triggering getOrCreate on a different id.
    pool.getOrCreate('s2', () => asChatRuntime(makeFake()));
    expect(events.some((e) => e.id === 's1' && e.reason === 'evicted')).toBe(true);
  });
});

describe('RuntimePool.dispose fires shutdown and awaits runtime.dispose', () => {
  test('dispose() fires shutdown for every resident entry', async () => {
    const events: Array<{ id: string; reason: RuntimePoolEndReason }> = [];
    const pool = new RuntimePool({
      onSessionEnd: (id, reason) => events.push({ id, reason }),
    });
    const a = makeFake();
    const b = makeFake();
    pool.getOrCreate('a', () => asChatRuntime(a));
    pool.getOrCreate('b', () => asChatRuntime(b));
    await pool.dispose();
    expect(events.length).toBe(2);
    const reasons = new Set(events.map((e) => e.reason));
    expect(reasons.has('shutdown')).toBe(true);
    expect(reasons.size).toBe(1);
    expect(pool.size()).toBe(0);
    // dispose() awaited each runtime.dispose().
    expect(a.disposed).toBe(true);
    expect(b.disposed).toBe(true);
  });

  test('dispose() swallows a failing runtime.dispose so other entries finish', async () => {
    const events: Array<{ id: string; reason: RuntimePoolEndReason }> = [];
    const pool = new RuntimePool({
      onSessionEnd: (id, reason) => events.push({ id, reason }),
    });
    const ok = makeFake();
    const bad: FakeRuntime = {
      streaming: false,
      disposed: false,
      dispose: async () => {
        throw new Error('boom');
      },
    };
    pool.getOrCreate('ok', () => asChatRuntime(ok));
    pool.getOrCreate('bad', () => asChatRuntime(bad));
    // Should NOT throw.
    await pool.dispose();
    expect(events.length).toBe(2);
    expect(ok.disposed).toBe(true);
  });

  test('dispose() swallows a failing onSessionEnd callback', async () => {
    const events: Array<{ id: string; reason: RuntimePoolEndReason }> = [];
    const pool = new RuntimePool({
      onSessionEnd: (id, reason): void => {
        if (id === 'bad') {
          throw new Error('hook crashed');
        }
        events.push({ id, reason });
      },
    });
    pool.getOrCreate('ok', () => asChatRuntime(makeFake()));
    pool.getOrCreate('bad', () => asChatRuntime(makeFake()));
    await pool.dispose();
    // 'ok' still surfaced; 'bad' did not, but dispose() didn't throw.
    expect(events).toEqual([{ id: 'ok', reason: 'shutdown' }]);
    expect(pool.size()).toBe(0);
  });
});

describe('RuntimePool.clear preserves SessionEnd notifications', () => {
  test('clear() fires shutdown for each entry (sync best-effort)', () => {
    const events: Array<{ id: string; reason: RuntimePoolEndReason }> = [];
    const pool = new RuntimePool({
      onSessionEnd: (id, reason) => events.push({ id, reason }),
    });
    pool.getOrCreate('a', () => asChatRuntime(makeFake()));
    pool.getOrCreate('b', () => asChatRuntime(makeFake()));
    pool.clear();
    expect(events.length).toBe(2);
    expect(events.every((e) => e.reason === 'shutdown')).toBe(true);
    expect(pool.size()).toBe(0);
  });
});
