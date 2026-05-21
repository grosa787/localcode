/**
 * WorkerPool — unit tests.
 *
 * Covers:
 *   - acquire/release round-trip (same handle returned on second acquire),
 *   - acquire miss → null on cold start,
 *   - per-template isolation (one template's pool never serves another's
 *     acquire),
 *   - reset() is called on release before recycling,
 *   - reset() throw causes eviction (worker disposed, not recycled),
 *   - !isAlive() workers are not recycled,
 *   - maxIdle cap evicts the overflow worker on release,
 *   - maxAge eviction disposes stale workers when sweeped,
 *   - disposeAll clears every bucket.
 */
import { describe, expect, test } from 'bun:test';
import { WorkerPool, type PooledWorkerHandle } from '@/agents/worker-pool';

interface FakeWorker {
  id: string;
  reset: boolean;
  disposed: boolean;
  resetCount: number;
}

interface FakeHandleControls {
  alive: boolean;
  failReset: boolean;
}

function makeHandle(
  templateId: string,
  worker: FakeWorker,
  controls: FakeHandleControls = { alive: true, failReset: false },
): PooledWorkerHandle<FakeWorker> {
  return {
    templateId,
    worker,
    isAlive() {
      return controls.alive;
    },
    async reset() {
      worker.resetCount += 1;
      if (controls.failReset) throw new Error('reset blew up');
      worker.reset = true;
    },
    async dispose() {
      worker.disposed = true;
    },
  };
}

describe('WorkerPool.acquire', () => {
  test('returns null on cold start (no warm workers)', async () => {
    const pool = new WorkerPool<FakeWorker>();
    expect(await pool.acquire('templateA')).toBeNull();
    expect(pool.size()).toBe(0);
  });

  test('acquire after release returns the same handle (round-trip)', async () => {
    const pool = new WorkerPool<FakeWorker>();
    const worker: FakeWorker = { id: 'w1', reset: false, disposed: false, resetCount: 0 };
    const handle = makeHandle('templateA', worker);
    await pool.release(handle);
    expect(pool.sizeFor('templateA')).toBe(1);
    const acquired = await pool.acquire('templateA');
    expect(acquired).not.toBeNull();
    expect(acquired!.worker).toBe(worker);
    // Pool drained — second acquire returns null again.
    expect(await pool.acquire('templateA')).toBeNull();
  });

  test('worker.reset() is invoked before recycling', async () => {
    const pool = new WorkerPool<FakeWorker>();
    const worker: FakeWorker = { id: 'w1', reset: false, disposed: false, resetCount: 0 };
    await pool.release(makeHandle('t', worker));
    expect(worker.reset).toBe(true);
    expect(worker.resetCount).toBe(1);
    expect(worker.disposed).toBe(false);
  });
});

describe('WorkerPool — per-template isolation', () => {
  test('a release into one bucket does not satisfy another template', async () => {
    const pool = new WorkerPool<FakeWorker>();
    const wA: FakeWorker = { id: 'a', reset: false, disposed: false, resetCount: 0 };
    await pool.release(makeHandle('templateA', wA));
    expect(await pool.acquire('templateB')).toBeNull();
    expect(pool.sizeFor('templateA')).toBe(1);
    expect(pool.sizeFor('templateB')).toBe(0);
  });

  test('size() reflects the sum across templates', async () => {
    const pool = new WorkerPool<FakeWorker>();
    await pool.release(
      makeHandle('a', { id: '1', reset: false, disposed: false, resetCount: 0 }),
    );
    await pool.release(
      makeHandle('a', { id: '2', reset: false, disposed: false, resetCount: 0 }),
    );
    await pool.release(
      makeHandle('b', { id: '3', reset: false, disposed: false, resetCount: 0 }),
    );
    expect(pool.size()).toBe(3);
    expect(pool.sizeFor('a')).toBe(2);
    expect(pool.sizeFor('b')).toBe(1);
  });
});

describe('WorkerPool — reset / alive failure paths', () => {
  test('failed reset() disposes the worker instead of recycling', async () => {
    const pool = new WorkerPool<FakeWorker>();
    const worker: FakeWorker = { id: 'w', reset: false, disposed: false, resetCount: 0 };
    await pool.release(makeHandle('t', worker, { alive: true, failReset: true }));
    expect(worker.disposed).toBe(true);
    expect(pool.sizeFor('t')).toBe(0);
    expect(await pool.acquire('t')).toBeNull();
  });

  test('!isAlive() worker on release is disposed', async () => {
    const pool = new WorkerPool<FakeWorker>();
    const worker: FakeWorker = { id: 'w', reset: false, disposed: false, resetCount: 0 };
    await pool.release(makeHandle('t', worker, { alive: false, failReset: false }));
    expect(worker.disposed).toBe(true);
    expect(pool.sizeFor('t')).toBe(0);
  });

  test('acquire skips !isAlive() workers and returns null when bucket has only dead ones', async () => {
    const pool = new WorkerPool<FakeWorker>();
    const worker: FakeWorker = { id: 'w', reset: false, disposed: false, resetCount: 0 };
    // Simulate a release while alive, then mark dead before next acquire.
    const controls: FakeHandleControls = { alive: true, failReset: false };
    const handle = makeHandle('t', worker, controls);
    await pool.release(handle);
    controls.alive = false;
    expect(await pool.acquire('t')).toBeNull();
    // Worker was disposed during the skip.
    expect(worker.disposed).toBe(true);
  });
});

describe('WorkerPool — maxIdle cap', () => {
  test('release past maxIdle evicts the overflow worker', async () => {
    const pool = new WorkerPool<FakeWorker>({ maxIdle: 2 });
    const workers: FakeWorker[] = [];
    for (let i = 0; i < 3; i += 1) {
      const w: FakeWorker = { id: `w${i}`, reset: false, disposed: false, resetCount: 0 };
      workers.push(w);
      await pool.release(makeHandle('t', w));
    }
    expect(pool.sizeFor('t')).toBe(2);
    // The third release should be the one that was disposed.
    expect(workers[0]?.disposed).toBe(false);
    expect(workers[1]?.disposed).toBe(false);
    expect(workers[2]?.disposed).toBe(true);
  });

  test('maxIdle=0 disposes everything immediately', async () => {
    const pool = new WorkerPool<FakeWorker>({ maxIdle: 0 });
    const w: FakeWorker = { id: 'w', reset: false, disposed: false, resetCount: 0 };
    await pool.release(makeHandle('t', w));
    expect(w.disposed).toBe(true);
    expect(pool.sizeFor('t')).toBe(0);
  });
});

describe('WorkerPool — maxAge eviction', () => {
  test('stale workers are evicted on acquire', async () => {
    let clock = 1_000_000;
    const pool = new WorkerPool<FakeWorker>({
      maxAge: 5000,
      now: () => clock,
    });
    const worker: FakeWorker = { id: 'w', reset: false, disposed: false, resetCount: 0 };
    await pool.release(makeHandle('t', worker));
    expect(pool.sizeFor('t')).toBe(1);

    // Advance past maxAge — acquire should see no warm worker.
    clock += 6000;
    expect(await pool.acquire('t')).toBeNull();
    // Stale worker disposed.
    expect(worker.disposed).toBe(true);
    expect(pool.sizeFor('t')).toBe(0);
  });

  test('evictStale sweeps every bucket', async () => {
    let clock = 1_000_000;
    const pool = new WorkerPool<FakeWorker>({
      maxAge: 1000,
      now: () => clock,
    });
    const wA: FakeWorker = { id: 'a', reset: false, disposed: false, resetCount: 0 };
    const wB: FakeWorker = { id: 'b', reset: false, disposed: false, resetCount: 0 };
    await pool.release(makeHandle('templateA', wA));
    await pool.release(makeHandle('templateB', wB));
    clock += 2000;
    await pool.evictStale();
    expect(wA.disposed).toBe(true);
    expect(wB.disposed).toBe(true);
    expect(pool.size()).toBe(0);
  });

  test('non-stale workers survive an evictStale sweep', async () => {
    let clock = 1_000_000;
    const pool = new WorkerPool<FakeWorker>({
      maxAge: 10_000,
      now: () => clock,
    });
    const w: FakeWorker = { id: 'w', reset: false, disposed: false, resetCount: 0 };
    await pool.release(makeHandle('t', w));
    clock += 5000;
    await pool.evictStale();
    expect(w.disposed).toBe(false);
    expect(pool.sizeFor('t')).toBe(1);
  });
});

describe('WorkerPool.disposeAll', () => {
  test('drops every bucket and disposes every worker', async () => {
    const pool = new WorkerPool<FakeWorker>();
    const workers: FakeWorker[] = [];
    for (let i = 0; i < 5; i += 1) {
      const w: FakeWorker = { id: `w${i}`, reset: false, disposed: false, resetCount: 0 };
      workers.push(w);
      await pool.release(makeHandle(i < 3 ? 'a' : 'b', w));
    }
    expect(pool.size()).toBe(5);
    await pool.disposeAll();
    expect(pool.size()).toBe(0);
    for (const w of workers) expect(w.disposed).toBe(true);
  });
});

describe('WorkerPool — option clamping', () => {
  test('negative / non-finite maxIdle falls back to default 3', async () => {
    const pool = new WorkerPool<FakeWorker>({ maxIdle: -5 });
    for (let i = 0; i < 5; i += 1) {
      await pool.release(
        makeHandle('t', { id: `w${i}`, reset: false, disposed: false, resetCount: 0 }),
      );
    }
    expect(pool.sizeFor('t')).toBe(3);
  });

  test('maxAge below 1000 falls back to default 5min', async () => {
    let clock = 1_000_000;
    const pool = new WorkerPool<FakeWorker>({
      maxAge: 100, // clamped → default 5 minutes
      now: () => clock,
    });
    const w: FakeWorker = { id: 'w', reset: false, disposed: false, resetCount: 0 };
    await pool.release(makeHandle('t', w));
    clock += 30_000; // 30s — well inside default 5min
    expect(await pool.acquire('t')).not.toBeNull();
  });
});
