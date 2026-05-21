/**
 * HealthWatchdog — periodic sweep that detects stuck `ChatRuntime`
 * instances and force-releases their stream lock.
 *
 * Why this exists:
 *   The streaming lock (`isStreaming = true` + the active
 *   `AbortController`) is released in `sendUserMessage`'s `finally` block
 *   after `runStreamLoop` returns. That handles the happy path AND any
 *   exception that bubbles up through the loop. BUT a runtime can still
 *   wedge:
 *     - the adapter's `streamChat` never resolves AND never throws (rare
 *       upstream timeout misconfig where the SSE socket is half-open),
 *     - a tool handler awaits a Promise that never settles (third-party
 *       MCP server hangs without sending an RPC error),
 *     - an approval-bridge timeout fires but the executor's catch path
 *       on a custom approval callback masks the timeout into a `success:
 *       true` result that immediately stalls on the next adapter call.
 *
 *   In all of those cases, `isStreaming` stays `true`, the client's
 *   spinner spins forever, and the next user `send_message` lands in
 *   ChatRuntime's "Stream already in progress; cancel first" branch.
 *   The watchdog backstops these by force-releasing the lock after
 *   `staleAfterMs` of no chunk/tool_call activity.
 *
 * Best-effort, single responsibility — never deletes the runtime, never
 * touches sessions. The user sees a "Stream watchdog" error frame and
 * can immediately retry.
 */

import type { RuntimePool } from './runtime-pool';

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

export interface HealthWatchdogOptions {
  /**
   * How long an `isStreaming === true` runtime can go without chunk /
   * tool_call activity before we judge it stuck. Default 5 minutes.
   */
  staleAfterMs?: number;
  /** How often the watchdog sweeps the pool. Default 60 seconds. */
  sweepIntervalMs?: number;
  /**
   * Injection point for tests. Defaults to `Date.now`. Runtimes report
   * their last activity via `getLastActivityAt()`; the watchdog reads
   * `now() - lastActivityAt`.
   */
  now?: () => number;
}

/**
 * Minimal `RuntimePool` surface the watchdog actually needs. Lets tests
 * pass a fake without depending on the full pool internals.
 */
export interface RuntimePoolLike {
  /** Enumerate (sessionId, runtime) for every resident runtime. */
  entries(): Iterable<{ sessionId: string; runtime: WatchableRuntime }>;
}

/**
 * Minimal `ChatRuntime` surface — runtime emits its own error/done
 * frames inside `forceResetFromWatchdog`, so the watchdog never speaks
 * the WS protocol directly.
 */
export interface WatchableRuntime {
  readonly streaming: boolean;
  getLastActivityAt(): number;
  forceResetFromWatchdog(reason: string): boolean;
}

/**
 * Adapt the real `RuntimePool` (which exposes an `entries()` iterator
 * over its resident runtimes) into the watchdog's narrow surface. Kept
 * as a free function so the watchdog stays framework-agnostic and
 * tests can pass a hand-rolled `RuntimePoolLike` without dragging the
 * full pool internals.
 */
export function poolToWatchable(pool: RuntimePool): RuntimePoolLike {
  return {
    *entries() {
      for (const { sessionId, runtime } of pool.entries()) {
        const watchable = runtime as unknown as Partial<WatchableRuntime>;
        if (
          watchable !== null &&
          typeof watchable === 'object' &&
          'streaming' in watchable &&
          typeof watchable.getLastActivityAt === 'function' &&
          typeof watchable.forceResetFromWatchdog === 'function'
        ) {
          yield {
            sessionId,
            runtime: watchable as WatchableRuntime,
          };
        }
      }
    },
  };
}

export class HealthWatchdog {
  private readonly pool: RuntimePoolLike;
  private readonly staleAfterMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(pool: RuntimePoolLike, opts?: HealthWatchdogOptions) {
    this.pool = pool;
    const stale = opts?.staleAfterMs;
    this.staleAfterMs =
      typeof stale === 'number' && Number.isFinite(stale) && stale > 0
        ? Math.floor(stale)
        : DEFAULT_STALE_AFTER_MS;
    const sweep = opts?.sweepIntervalMs;
    this.sweepIntervalMs =
      typeof sweep === 'number' && Number.isFinite(sweep) && sweep > 0
        ? Math.floor(sweep)
        : DEFAULT_SWEEP_INTERVAL_MS;
    this.now = opts?.now ?? Date.now;
  }

  /**
   * Begin periodic sweeps. Idempotent — calling `start()` twice is a
   * no-op. The sweep itself is synchronous and very cheap (one map
   * walk + a Date.now subtraction per resident runtime).
   */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        // Watchdog must never crash the process — log and move on.
        // eslint-disable-next-line no-console
        console.warn(
          `[health-watchdog] sweep failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }, this.sweepIntervalMs);
    // Don't keep the event loop alive just for the watchdog.
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  /** Stop sweeping. Safe to call multiple times. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run a single sweep. Returns the list of sessionIds that were
   * force-reset (so tests and observability hooks can assert behaviour
   * deterministically). Public so production wiring can call it once
   * at shutdown for clean log lines.
   */
  sweep(): string[] {
    const now = this.now();
    const reset: string[] = [];
    for (const { sessionId, runtime } of this.pool.entries()) {
      if (!runtime.streaming) continue;
      const last = runtime.getLastActivityAt();
      if (last <= 0) continue;
      const idleMs = now - last;
      if (idleMs < this.staleAfterMs) continue;
      const reason = `no activity for ${Math.round(idleMs / 1000)}s (limit ${Math.round(
        this.staleAfterMs / 1000,
      )}s)`;
      const did = runtime.forceResetFromWatchdog(reason);
      if (did) reset.push(sessionId);
    }
    return reset;
  }
}
