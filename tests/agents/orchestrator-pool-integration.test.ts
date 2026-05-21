/**
 * AgentOrchestrator + WorkerPool — integration tests.
 *
 * Verifies that when the orchestrator is wired with a `workerPool` and
 * a `pooledRunnerFactory`:
 *   - sequential spawns for the SAME templateId reuse one worker,
 *   - concurrent spawns for the same templateId each get their own
 *     worker (pool has nothing to give the second one),
 *   - the worker's `reset()` is called on terminal so the next
 *     acquire returns a clean worker,
 *   - different templateIds NEVER share workers,
 *   - when no pool is configured, behaviour is unchanged (one factory
 *     call per spawn) — backward compat.
 */
import { describe, expect, test } from 'bun:test';
import {
  AgentOrchestrator,
  type AgentRunner,
  type AgentRunnerCallbacks,
  type AgentRunnerSpec,
} from '@/agents/orchestrator';
import {
  WorkerPool,
  type PooledWorkerHandle,
} from '@/agents/worker-pool';
import type { AgentsConfig, SpawnAgentRequest } from '@/agents/types';

const baseConfig: AgentsConfig = {
  workerModel: 'fake-worker',
  maxConcurrent: 8,
  isolation: 'shared',
  approval: 'auto',
  defaultTimeoutSec: 5,
};

interface FakeRunner extends AgentRunner {
  id: string;
  spec: AgentRunnerSpec;
  startedCount: number;
  resetCount: number;
  disposed: boolean;
  callbacks: AgentRunnerCallbacks | null;
}

function makeFakeRunner(spec: AgentRunnerSpec, id: string): FakeRunner {
  return {
    id,
    spec,
    startedCount: 0,
    resetCount: 0,
    disposed: false,
    callbacks: null,
    async start(cbs: AgentRunnerCallbacks): Promise<void> {
      this.startedCount += 1;
      this.callbacks = cbs;
    },
    async cancel(): Promise<void> {
      // no-op
    },
  };
}

interface RunnerWithHandle {
  runner: FakeRunner;
  handle: PooledWorkerHandle<AgentRunner>;
}

function makePooledHandle(runner: FakeRunner): PooledWorkerHandle<AgentRunner> {
  return {
    templateId: runner.spec.templateId ?? 'default',
    worker: runner,
    isAlive() {
      return !runner.disposed;
    },
    async reset() {
      runner.resetCount += 1;
      // Scrub conversation: fake — just clears callbacks.
      runner.callbacks = null;
    },
    async dispose() {
      runner.disposed = true;
    },
  };
}

function setup(opts: { withPool: boolean; maxIdle?: number }): {
  orch: AgentOrchestrator;
  produced: RunnerWithHandle[];
  pool: WorkerPool<AgentRunner> | null;
} {
  const produced: RunnerWithHandle[] = [];
  let counter = 0;
  const factory = (spec: AgentRunnerSpec): AgentRunner => {
    const r = makeFakeRunner(spec, `r${++counter}`);
    produced.push({ runner: r, handle: makePooledHandle(r) });
    return r;
  };
  const pooledFactory = (spec: AgentRunnerSpec): PooledWorkerHandle<AgentRunner> => {
    const r = makeFakeRunner(spec, `r${++counter}`);
    const handle = makePooledHandle(r);
    produced.push({ runner: r, handle });
    return handle;
  };
  const pool: WorkerPool<AgentRunner> | null = opts.withPool
    ? new WorkerPool<AgentRunner>(opts.maxIdle !== undefined ? { maxIdle: opts.maxIdle } : {})
    : null;
  const orch = new AgentOrchestrator({
    projectRoot: '/tmp/fake',
    config: baseConfig,
    runnerFactory: factory,
    ...(pool !== null
      ? {
          workerPool: pool,
          pooledRunnerFactory: pooledFactory,
        }
      : {}),
    idGenerator: (() => {
      let n = 0;
      return () => `a${++n}`;
    })(),
  });
  return { orch, produced, pool };
}

const baseReq: SpawnAgentRequest = {
  task: 'do the thing',
  files: ['src/foo.ts'],
};

/** Drive a handle to terminal so the pool's release callback fires. */
async function completeHandle(orch: AgentOrchestrator, parent: string, agentId: string): Promise<void> {
  // Wait until runner.start() has been invoked (the orchestrator calls
  // start async after returning the handle).
  await new Promise((r) => setTimeout(r, 5));
  const handle = orch.get(parent, agentId);
  expect(handle).toBeDefined();
  // Find the runner by spec.agentId via global lookup is awkward — but
  // we know orchestrator binds the runner before runStart, so we can
  // signal completion through the handle's lifecycle: cancel works too,
  // but for "done" we need the callbacks. Use cancel — that's a terminal.
  await handle!.cancel('test-finished');
  await handle!.done();
  // Give the pool's onTerminal microtask a chance to run.
  await new Promise((r) => setTimeout(r, 5));
}

describe('AgentOrchestrator — pool reuse (sequential)', () => {
  test('sequential spawns for same templateId share one worker', async () => {
    const { orch, produced, pool } = setup({ withPool: true });
    expect(pool).not.toBeNull();

    // First spawn — pool miss, factory invoked once.
    const h1 = await orch.spawn('parent', { ...baseReq, templateId: 'A' });
    expect(produced.length).toBe(1);
    expect(pool!.sizeFor('A')).toBe(0); // worker is in-flight, not in pool

    await completeHandle(orch, 'parent', h1.agentId);
    // After terminal, pool released the worker.
    expect(pool!.sizeFor('A')).toBe(1);
    expect(produced[0]?.runner.resetCount).toBe(1);

    // Second spawn — pool hit, factory NOT called again.
    const h2 = await orch.spawn('parent', { ...baseReq, templateId: 'A' });
    expect(produced.length).toBe(1); // unchanged — reuse!
    expect(h2.agentId).not.toBe(h1.agentId);
    // The pooled worker is in-flight again.
    expect(pool!.sizeFor('A')).toBe(0);

    await completeHandle(orch, 'parent', h2.agentId);
    expect(pool!.sizeFor('A')).toBe(1);
    expect(produced[0]?.runner.resetCount).toBe(2);
  });
});

describe('AgentOrchestrator — pool reuse (concurrent)', () => {
  test('concurrent spawns get distinct workers (pool empty mid-flight)', async () => {
    const { orch, produced, pool } = setup({ withPool: true });
    // Two concurrent spawns — neither can satisfy the other from the pool.
    const [h1, h2] = await Promise.all([
      orch.spawn('parent', { ...baseReq, templateId: 'A' }),
      orch.spawn('parent', { ...baseReq, templateId: 'A' }),
    ]);
    expect(produced.length).toBe(2);
    expect(h1.agentId).not.toBe(h2.agentId);
    expect(pool!.sizeFor('A')).toBe(0); // both in-flight

    await Promise.all([
      completeHandle(orch, 'parent', h1.agentId),
      completeHandle(orch, 'parent', h2.agentId),
    ]);
    // Both released back into the pool (maxIdle defaults to 3).
    expect(pool!.sizeFor('A')).toBe(2);
  });
});

describe('AgentOrchestrator — template isolation in pool', () => {
  test('templateA workers never satisfy templateB spawns', async () => {
    const { orch, produced, pool } = setup({ withPool: true });

    const hA = await orch.spawn('parent', { ...baseReq, templateId: 'A' });
    await completeHandle(orch, 'parent', hA.agentId);
    expect(pool!.sizeFor('A')).toBe(1);
    expect(pool!.sizeFor('B')).toBe(0);
    expect(produced.length).toBe(1);

    // templateB spawn — pool has no B worker, factory called fresh.
    const hB = await orch.spawn('parent', { ...baseReq, templateId: 'B' });
    expect(produced.length).toBe(2);
    expect(hB.agentId).not.toBe(hA.agentId);
    expect(pool!.sizeFor('A')).toBe(1);
  });
});

describe('AgentOrchestrator — pool overflow disposes', () => {
  test('maxIdle=1 disposes the second released worker', async () => {
    const { orch, produced, pool } = setup({ withPool: true, maxIdle: 1 });
    const [h1, h2] = await Promise.all([
      orch.spawn('parent', { ...baseReq, templateId: 'A' }),
      orch.spawn('parent', { ...baseReq, templateId: 'A' }),
    ]);
    await Promise.all([
      completeHandle(orch, 'parent', h1.agentId),
      completeHandle(orch, 'parent', h2.agentId),
    ]);
    expect(pool!.sizeFor('A')).toBe(1);
    // One worker disposed, one recycled.
    const disposedCount = produced.filter((p) => p.runner.disposed).length;
    expect(disposedCount).toBe(1);
  });
});

describe('AgentOrchestrator — no pool (backward compat)', () => {
  test('without workerPool, every spawn invokes the legacy runnerFactory', async () => {
    const { orch, produced } = setup({ withPool: false });
    const h1 = await orch.spawn('parent', { ...baseReq, templateId: 'A' });
    await completeHandle(orch, 'parent', h1.agentId);
    const h2 = await orch.spawn('parent', { ...baseReq, templateId: 'A' });
    await completeHandle(orch, 'parent', h2.agentId);
    expect(produced.length).toBe(2);
    expect(produced[0]?.runner.resetCount).toBe(0);
    expect(produced[1]?.runner.resetCount).toBe(0);
  });
});

describe('AgentOrchestrator — default templateId fallback', () => {
  test('template-less spawns share the "default" bucket', async () => {
    const { orch, produced, pool } = setup({ withPool: true });
    const h1 = await orch.spawn('parent', baseReq);
    await completeHandle(orch, 'parent', h1.agentId);
    expect(pool!.sizeFor('default')).toBe(1);
    const h2 = await orch.spawn('parent', baseReq);
    // Should have reused the default-bucket worker.
    expect(produced.length).toBe(1);
    expect(h2.agentId).not.toBe(h1.agentId);
  });
});
