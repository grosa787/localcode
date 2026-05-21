/**
 * Background scheduler for the auto-updater singleton.
 *
 * Wraps the GitHub release check + tarball download in a long-lived
 * timer chain. The contract:
 *
 *   1. `start()` arms an initial check ~5s after construction (gives
 *      the rest of the boot a chance to settle).
 *   2. After every check we arm the next one `intervalMs` later. The
 *      timer is `unref`'d so it never holds the process open by
 *      itself.
 *   3. Every call is fire-and-forget — a network failure, a parse
 *      error, or a disk-write failure logs to the event listener and
 *      schedules the next check normally.
 *
 * Tests inject `setTimeoutFn` / `clearTimeoutFn` / `nowFn` so the
 * scheduler can be driven deterministically without wall-clock waits.
 */

export interface SchedulerHandle {
  /** Cancel any pending check timer. Idempotent. */
  stop: () => void;
  /**
   * Trigger an immediate, out-of-band check. Returns the same Promise
   * chained by the scheduler so callers can await it (used by the CLI
   * `update check` subcommand).
   */
  checkNow: () => Promise<void>;
  /** True when the scheduler is running. */
  readonly running: boolean;
}

export interface SchedulerOptions {
  /** First-check delay after `start()`. Default 5_000 ms. */
  readonly initialDelayMs?: number;
  /** Repeating interval. Default 6h. */
  readonly intervalMs?: number;
  /** Inject a clock; tests use this to assert timestamps deterministically. */
  readonly nowFn?: () => number;
  /** Injection point for tests (defaults to global setTimeout). */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Injection point for tests (defaults to global clearTimeout). */
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /**
   * Listener invoked for every check completion. The host (singleton)
   * uses this to dispatch update-available / update-downloaded events.
   * Errors thrown by the listener are caught so the timer chain keeps
   * advancing.
   */
  readonly onTick: () => Promise<void>;
}

/**
 * Build a scheduler. The returned handle does NOT auto-start; call
 * `.start()` first. This split lets `app.tsx` construct the handle
 * during the React effect cleanup pattern without firing a fetch on
 * every render.
 */
export function scheduleBackgroundCheck(opts: SchedulerOptions): SchedulerHandle & {
  start: () => void;
} {
  const initialDelay = opts.initialDelayMs ?? 5_000;
  const interval = opts.intervalMs ?? 6 * 60 * 60 * 1_000;
  const setTimeoutFn =
    opts.setTimeoutFn ??
    ((cb, ms): unknown => {
      const h = globalThis.setTimeout(cb, ms);
      if (typeof (h as { unref?: () => unknown }).unref === 'function') {
        try {
          (h as { unref: () => unknown }).unref();
        } catch {
          /* swallow */
        }
      }
      return h;
    });
  const clearTimeoutFn =
    opts.clearTimeoutFn ??
    ((handle: unknown): void => {
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  let handle: unknown = null;
  let running = false;
  let stopped = false;
  let inflight: Promise<void> | null = null;

  const armNext = (delayMs: number): void => {
    if (stopped) return;
    handle = setTimeoutFn(() => {
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inflight !== null) {
      // A manual `checkNow` is racing the timer; let it finish first.
      try {
        await inflight;
      } catch {
        /* swallow */
      }
      armNext(interval);
      return;
    }
    inflight = (async (): Promise<void> => {
      try {
        await opts.onTick();
      } catch {
        /* swallow — listener errors must not stop the chain */
      }
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
      armNext(interval);
    }
  };

  return {
    get running(): boolean {
      return running && !stopped;
    },
    start: (): void => {
      if (running) return;
      if (stopped) return;
      running = true;
      armNext(initialDelay);
    },
    stop: (): void => {
      stopped = true;
      running = false;
      if (handle !== null) {
        try {
          clearTimeoutFn(handle);
        } catch {
          /* swallow */
        }
        handle = null;
      }
    },
    checkNow: async (): Promise<void> => {
      if (stopped) return;
      if (inflight !== null) {
        try {
          await inflight;
        } catch {
          /* swallow */
        }
        return;
      }
      inflight = (async (): Promise<void> => {
        try {
          await opts.onTick();
        } catch {
          /* swallow */
        }
      })();
      try {
        await inflight;
      } finally {
        inflight = null;
      }
    },
  };
}
