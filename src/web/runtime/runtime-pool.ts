/**
 * RuntimePool — bounded LRU cache of `ChatRuntime` instances keyed by
 * session id.
 *
 * Each `ChatRuntime` holds an in-memory `ContextManager` (the system
 * prompt, message window, summarisation state) plus a wired-up
 * `ToolExecutor` and `ApprovalBridge` callback. Building one is
 * relatively cheap but the in-memory state is *not* free — twelve
 * sessions sitting on the warm-up heap is fine; a thousand idle
 * sessions would be wasteful.
 *
 * Eviction policy:
 *   - Hard cap: `maxSize` (default 12). When `getOrCreate` would push
 *     us past the cap, the least-recently-touched entry is dropped.
 *   - Soft cap: idle entries past `idleTimeoutMs` are reaped on access.
 *
 * SQLite is the source of truth — a dropped runtime simply means the
 * next `send_message` for that session will rebuild the runtime from
 * persisted state. This is the same shape `app.tsx` uses on `/resume`.
 */

import type { ChatRuntime } from './chat-runtime';

/**
 * Cause string passed to `onSessionEnd` so callers can distinguish
 * user-initiated tear-downs from LRU eviction.
 *   - `user_quit`      — caller invoked `release(sessionId)` (e.g. the
 *                        WS layer on a `cancel_session` frame, or the
 *                        REST DELETE handler).
 *   - `session_switch` — reserved for a future "switch active session"
 *                        flow; the pool itself does not produce this
 *                        cause today but the callback signature exposes
 *                        it so wire-up sites match the upstream
 *                        `HookSessionEndReason` enum without coercion.
 *   - `shutdown`       — `dispose()` was invoked (top-level server
 *                        teardown). Every still-resident runtime fires
 *                        with this cause exactly once.
 *   - `evicted`        — LRU pressure pushed the entry out. NOT a
 *                        user-initiated end; the session row stays in
 *                        SQLite and reopens transparently on the next
 *                        `subscribe_session` frame.
 */
export type RuntimePoolEndReason =
  | 'user_quit'
  | 'session_switch'
  | 'shutdown'
  | 'evicted';

export interface RuntimePoolOptions {
  /** Hard cap on resident runtimes. Default 12. */
  maxSize?: number;
  /** Idle reap threshold in ms. Default 30 minutes. */
  idleTimeoutMs?: number;
  /** Optional dispose hook called when an entry is evicted. */
  onEvict?: (sessionId: string, runtime: ChatRuntime) => void;
  /**
   * Fire-and-forget hook invoked whenever an entry leaves the pool.
   * Distinguishes the cause via `RuntimePoolEndReason`. Callers wire
   * this to the hook engine's `SessionEnd` trigger so user-authored
   * shell hooks can run on every session tear-down (user quit, LRU
   * eviction, or top-level shutdown). The pool never awaits the
   * callback — exceptions are logged and swallowed.
   */
  onSessionEnd?: (
    sessionId: string,
    reason: RuntimePoolEndReason,
  ) => void;
}

const DEFAULT_MAX_SIZE = 12;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export class RuntimePool {
  private readonly runtimes = new Map<string, ChatRuntime>();
  private readonly lastTouched = new Map<string, number>();
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;
  private readonly onEvict: ((sessionId: string, runtime: ChatRuntime) => void) | undefined;
  private readonly onSessionEnd:
    | ((sessionId: string, reason: RuntimePoolEndReason) => void)
    | undefined;

  constructor(opts?: RuntimePoolOptions) {
    const rawMax = opts?.maxSize;
    this.maxSize =
      typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
        ? Math.floor(rawMax)
        : DEFAULT_MAX_SIZE;
    const rawIdle = opts?.idleTimeoutMs;
    this.idleTimeoutMs =
      typeof rawIdle === 'number' && Number.isFinite(rawIdle) && rawIdle > 0
        ? Math.floor(rawIdle)
        : DEFAULT_IDLE_TIMEOUT_MS;
    this.onEvict = opts?.onEvict;
    this.onSessionEnd = opts?.onSessionEnd;
  }

  /**
   * Look up a runtime for `sessionId`. If absent (or reaped), invokes
   * `factory()` to construct a fresh one. Always touches the LRU
   * timestamp, so the returned runtime is now the most-recently-used.
   */
  getOrCreate(sessionId: string, factory: () => ChatRuntime): ChatRuntime {
    this.reapIdle();
    let runtime = this.runtimes.get(sessionId);
    if (runtime === undefined) {
      this.evictIfNeeded();
      runtime = factory();
      this.runtimes.set(sessionId, runtime);
    }
    this.lastTouched.set(sessionId, Date.now());
    return runtime;
  }

  /** Look up an existing runtime without creating one. */
  get(sessionId: string): ChatRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  /**
   * Iterate (sessionId, runtime) over every resident entry. Used by
   * `HealthWatchdog` to find stuck runtimes. Iteration order matches
   * Map's insertion order; do NOT rely on it elsewhere.
   */
  *entries(): IterableIterator<{ sessionId: string; runtime: ChatRuntime }> {
    for (const [sessionId, runtime] of this.runtimes.entries()) {
      yield { sessionId, runtime };
    }
  }

  /**
   * Force-release a runtime (e.g. on session delete). Fires the
   * `onSessionEnd` callback with `'user_quit'` so wired hooks see the
   * cause of the tear-down.
   */
  release(sessionId: string): void {
    this.removeEntry(sessionId, 'user_quit');
  }

  /** Current number of resident runtimes — diagnostics + tests. */
  size(): number {
    return this.runtimes.size;
  }

  /**
   * Drop every entry. Sync best-effort tear-down — fires `onSessionEnd`
   * for each remaining runtime with cause `'shutdown'`. Prefer
   * {@link dispose} when the caller needs to await the per-runtime
   * `dispose()` chain before continuing shutdown.
   */
  clear(): void {
    const ids = [...this.runtimes.keys()];
    for (const id of ids) this.removeEntry(id, 'shutdown');
  }

  /**
   * Asynchronous teardown for top-level shutdown. Fires `onSessionEnd`
   * with cause `'shutdown'` for every resident runtime and awaits each
   * runtime's `dispose()` so the caller can sequence
   * `pool.dispose() → server.stop()` without losing the chance to fire
   * exit hooks. Best-effort — every individual `dispose()` failure is
   * logged and swallowed so a misbehaving runtime can't block the
   * server from shutting down.
   */
  async dispose(): Promise<void> {
    const ids = [...this.runtimes.keys()];
    const pending: Promise<void>[] = [];
    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      this.runtimes.delete(id);
      this.lastTouched.delete(id);
      // Fire SessionEnd FIRST so user hooks observe the shutdown cause
      // even if `dispose()` below throws or hangs.
      if (this.onSessionEnd !== undefined) {
        try {
          this.onSessionEnd(id, 'shutdown');
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[RuntimePool] onSessionEnd for "${id}" threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (this.onEvict !== undefined && runtime !== undefined) {
        try {
          this.onEvict(id, runtime);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[RuntimePool] onEvict for "${id}" threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (runtime !== undefined) {
        pending.push(
          Promise.resolve(runtime.dispose()).catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.warn(
              `[RuntimePool] runtime.dispose for "${id}" failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }),
        );
      }
    }
    await Promise.all(pending);
  }

  /**
   * If we are at or above the hard cap, evict the single
   * least-recently-touched entry that is NOT currently streaming
   * (audit H3 — killing a streaming runtime silently aborts the user's
   * active turn). Called BEFORE inserting a new entry so the post-insert
   * size is exactly `maxSize`.
   *
   * Throws when every resident runtime is mid-stream — the caller must
   * surface this to the user so they can cancel an active session.
   */
  private evictIfNeeded(): void {
    if (this.runtimes.size < this.maxSize) return;
    let oldestId: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, t] of this.lastTouched) {
      const rt = this.runtimes.get(id);
      // Skip streaming runtimes — never silently kill a live turn.
      if (rt !== undefined && rt.streaming === true) continue;
      if (t < oldestAt) {
        oldestAt = t;
        oldestId = id;
      }
    }
    if (oldestId === null) {
      throw new Error(
        `Concurrent session limit reached (${this.maxSize}) — cancel an active session first`,
      );
    }
    this.removeEntry(oldestId, 'evicted');
  }

  /**
   * Drop any entry whose lastTouched is older than `idleTimeoutMs`.
   * Cheap enough to call on every `getOrCreate` — twelve entries max,
   * single Date.now() per entry. Reaped entries are reported as
   * `'evicted'` (idle timeout is an LRU-style decision, not a user-
   * initiated tear-down).
   */
  private reapIdle(): void {
    if (this.runtimes.size === 0) return;
    const now = Date.now();
    const cutoff = now - this.idleTimeoutMs;
    const stale: string[] = [];
    for (const [id, t] of this.lastTouched) {
      if (t < cutoff) stale.push(id);
    }
    for (const id of stale) this.removeEntry(id, 'evicted');
  }

  /**
   * Drop a single entry and fire both the legacy `onEvict` hook (kept
   * for back-compat) and the new `onSessionEnd` callback. Both run
   * synchronously inside a try/catch so a misbehaving handler can't
   * leak through the pool.
   */
  private removeEntry(sessionId: string, reason: RuntimePoolEndReason): void {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined) return;
    this.runtimes.delete(sessionId);
    this.lastTouched.delete(sessionId);
    if (this.onSessionEnd !== undefined) {
      try {
        this.onSessionEnd(sessionId, reason);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[RuntimePool] onSessionEnd for "${sessionId}" threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (this.onEvict !== undefined) {
      try {
        this.onEvict(sessionId, runtime);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[RuntimePool] onEvict for "${sessionId}" threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
