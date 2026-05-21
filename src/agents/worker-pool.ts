/**
 * WorkerPool — warm worker reuse for `AgentOrchestrator.spawn`.
 *
 * Motivation: `AgentOrchestrator.spawn(req)` synchronously asks the
 * injected `AgentRunnerFactory` for a fresh runner per spawn. The
 * runner-factory bootstrap (ChatRuntime, adapter, system prompt
 * assembly) is non-trivial — for short tasks the warm-up cost can
 * eclipse the actual model call. This pool keeps a small number of
 * idle workers per template id so subsequent spawns reuse the warm
 * runner instead of paying the bootstrap toll every time.
 *
 * Contract:
 *   - `acquire(templateId)` returns a {@link PooledWorkerHandle} —
 *     either a warm worker pulled from the pool, or `null` so the
 *     caller can fall back to `factory()` (pool miss).
 *   - `release(handle)` returns a finished worker to the pool. The
 *     pool calls `handle.reset()` to scrub conversation state before
 *     making the worker reusable. Reset failures evict the worker.
 *   - `evictStale()` removes workers idle longer than `maxAge` ms.
 *     Called opportunistically on acquire + release; can also be
 *     invoked from a watchdog timer by the caller.
 *
 * Isolation: workers are partitioned by `templateId`. Two different
 * templates never share a pool slot — system prompts and tool
 * allow-lists vary per template.
 *
 * **Important.** This pool only manages handles to long-lived worker
 * "processes" if the injected handle's `reset()` actually clears its
 * prior conversation. The orchestrator's `AgentRunner` interface does
 * NOT expose state-clear semantics today (a runner is start()/cancel()
 * only). The pool is therefore wired conservatively: production
 * `runner-factory.ts` produces one-shot runners, so the pool always
 * misses at `acquire()` and short-circuits to factory spawn. The
 * mechanism is in place so a future stateful-runner adapter can
 * opt-in by surfacing `reset()` + `isAlive()` on its handle.
 */

/**
 * The shape of a pooled worker. The pool is generic over the concrete
 * worker type — `T` represents the warm payload (an `AgentRunner`, a
 * Bun.Subprocess handle, a pre-warmed `ChatRuntime`, etc.).
 */
export interface PooledWorkerHandle<T> {
  /** Template id the worker was warmed for. Used to partition the pool. */
  readonly templateId: string;
  /**
   * The warm payload. Typed by the caller — the pool is agnostic.
   * Consumers pull this out via `handle.worker` and drive it.
   */
  readonly worker: T;
  /**
   * True iff the underlying worker process is still healthy and ready
   * for another task. `false` workers are evicted from the pool on
   * release rather than being recycled.
   */
  isAlive(): boolean;
  /**
   * Clear any conversation / task state so the worker is safe to hand
   * to a new caller. Throwing — or returning a rejected promise —
   * causes the pool to evict instead of recycling. The pool awaits
   * this on `release()` before re-inserting.
   */
  reset(): Promise<void> | void;
  /**
   * Hard dispose. Called by the pool when the worker is evicted (idle
   * timeout, reset failure, or pool full). MUST be idempotent — the
   * pool does not guarantee one-shot dispose.
   */
  dispose(): Promise<void> | void;
}

/**
 * Factory producing a fresh worker for the given templateId. Called
 * on pool miss. The pool wraps the returned worker into a
 * `PooledWorkerHandle` if the caller hands back the raw worker via
 * {@link WorkerPool.adopt} — or callers can construct their own
 * handle and `release()` it directly.
 */
export type WorkerSpawner<T> = (templateId: string) => Promise<T> | T;

/**
 * Tunables. All fields optional — defaults match the brief
 * (maxIdle=3, maxAge=5 min).
 */
export interface WorkerPoolOptions {
  /** Per-template idle cap. Default 3. Clamped to ≥ 0. */
  maxIdle?: number;
  /** Max idle age in ms. Default 5 minutes. Clamped to ≥ 1000. */
  maxAge?: number;
  /**
   * Override for `Date.now()` — test seam so eviction can be exercised
   * without wall-clock waits.
   */
  now?: () => number;
}

interface PoolSlot<T> {
  handle: PooledWorkerHandle<T>;
  /** ms-epoch at which the worker was placed back in the pool. */
  releasedAt: number;
}

const DEFAULT_MAX_IDLE = 3;
const DEFAULT_MAX_AGE = 5 * 60 * 1000;

/**
 * Per-process pool with per-template buckets. Thread-safety is not a
 * concern (single-process Bun runtime); concurrent acquire calls
 * are serialised through JS's event loop turn boundaries.
 */
export class WorkerPool<T> {
  private readonly buckets = new Map<string, PoolSlot<T>[]>();
  private readonly maxIdle: number;
  private readonly maxAge: number;
  private readonly now: () => number;

  constructor(opts: WorkerPoolOptions = {}) {
    this.maxIdle =
      opts.maxIdle !== undefined && Number.isFinite(opts.maxIdle) && opts.maxIdle >= 0
        ? Math.floor(opts.maxIdle)
        : DEFAULT_MAX_IDLE;
    this.maxAge =
      opts.maxAge !== undefined && Number.isFinite(opts.maxAge) && opts.maxAge >= 1000
        ? Math.floor(opts.maxAge)
        : DEFAULT_MAX_AGE;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Diagnostics — total idle workers across all templates. */
  size(): number {
    let n = 0;
    for (const bucket of this.buckets.values()) n += bucket.length;
    return n;
  }

  /** Diagnostics — idle workers for one template id. */
  sizeFor(templateId: string): number {
    return this.buckets.get(templateId)?.length ?? 0;
  }

  /**
   * Return a warm worker for `templateId`, or `null` on miss.
   *
   * Side-effects: evicts stale workers (`maxAge` exceeded) for the
   * requested template before pulling. Stale workers get `dispose()`d.
   */
  async acquire(templateId: string): Promise<PooledWorkerHandle<T> | null> {
    this.evictStaleForTemplate(templateId);
    const bucket = this.buckets.get(templateId);
    if (bucket === undefined || bucket.length === 0) return null;

    // Pop the most-recently-released worker (LIFO) — cache-friendliest.
    const slot = bucket.pop();
    if (slot === undefined) return null;

    // Drop the bucket entry once empty so `size()` is meaningful.
    if (bucket.length === 0) this.buckets.delete(templateId);

    if (!slot.handle.isAlive()) {
      void this.safeDispose(slot.handle);
      // Recurse — there might be another live worker behind it.
      return this.acquire(templateId);
    }
    return slot.handle;
  }

  /**
   * Return a worker to the pool. Eviction conditions:
   *  - bucket at `maxIdle` cap → dispose immediately,
   *  - `handle.isAlive()` returns false → dispose,
   *  - `handle.reset()` throws → dispose.
   *
   * Otherwise the worker is recycled and may be returned by a future
   * `acquire(templateId)`.
   */
  async release(handle: PooledWorkerHandle<T>): Promise<void> {
    if (!handle.isAlive()) {
      await this.safeDispose(handle);
      return;
    }
    try {
      await handle.reset();
    } catch {
      // Reset failed → assume worker state is dirty; evict.
      await this.safeDispose(handle);
      return;
    }
    const bucket = this.buckets.get(handle.templateId) ?? [];
    if (bucket.length >= this.maxIdle) {
      await this.safeDispose(handle);
      return;
    }
    bucket.push({ handle, releasedAt: this.now() });
    this.buckets.set(handle.templateId, bucket);
  }

  /**
   * Sweep every bucket and evict workers idle past `maxAge`. The pool
   * does NOT spawn a timer for this — callers that want continuous
   * eviction should arrange their own watchdog. Acquire/release call
   * this implicitly for the touched template.
   */
  async evictStale(): Promise<void> {
    for (const id of [...this.buckets.keys()]) {
      this.evictStaleForTemplate(id);
    }
  }

  /**
   * Dispose every pooled worker and drop the buckets. Intended for
   * process shutdown / test teardown. Awaits every `dispose()` so
   * callers can `await pool.disposeAll()` cleanly.
   */
  async disposeAll(): Promise<void> {
    const handles: PooledWorkerHandle<T>[] = [];
    for (const bucket of this.buckets.values()) {
      for (const slot of bucket) handles.push(slot.handle);
    }
    this.buckets.clear();
    await Promise.all(handles.map((h) => this.safeDispose(h)));
  }

  // ---------- internals ----------

  /**
   * Synchronous variant of `evictStale` for a single template id.
   * The dispose calls are kicked off async (`void`) — the pool's
   * internal state mutation is already complete by the time we
   * return, so callers can safely call `acquire`/`release` next.
   */
  private evictStaleForTemplate(templateId: string): void {
    const bucket = this.buckets.get(templateId);
    if (bucket === undefined) return;
    const cutoff = this.now() - this.maxAge;
    const survivors: PoolSlot<T>[] = [];
    for (const slot of bucket) {
      if (slot.releasedAt < cutoff) {
        void this.safeDispose(slot.handle);
      } else {
        survivors.push(slot);
      }
    }
    if (survivors.length === 0) {
      this.buckets.delete(templateId);
    } else if (survivors.length !== bucket.length) {
      this.buckets.set(templateId, survivors);
    }
  }

  private async safeDispose(handle: PooledWorkerHandle<T>): Promise<void> {
    try {
      await handle.dispose();
    } catch {
      // best-effort — pool can't propagate this back to the original caller.
    }
  }
}
