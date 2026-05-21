/**
 * Persistent cron scheduler.
 *
 * Reads the on-disk cron store, computes the next fire time for every
 * enabled entry, and arms a `setTimeout` for the earliest one. On fire:
 *
 *   1. Run the entry's dispatch callback (the host wires this — the
 *      daemon writes to a queue, the TUI hands off to the active
 *      session).
 *   2. Persist `lastFiredAt` back to the store.
 *   3. Recompute the next fire time and re-arm.
 *
 * Single-shot scheduling per pass (re-armed after each fire) keeps the
 * timer book trivial: the scheduler always holds at most one live
 * timer. This avoids drift accumulation and is friendly to the
 * persistent-store mutex.
 *
 * NOT a long-running daemon by itself — the daemon is a thin wrapper
 * around this class that keeps the process alive. The scheduler is
 * also usable in-session (the TUI may keep one alive while running).
 */

import type { PersistentCronEntry, PersistentCronFile } from './persistent-store';
import {
  defaultCronStorePath,
  loadCronStore,
  updateCronStore,
} from './persistent-store';
import { nextFireTime, parseCronSpec } from './cron-spec-parser';
import type { ParsedCronSpec } from './cron-spec-parser';

export interface PersistentCronDispatchContext {
  readonly entry: PersistentCronEntry;
  readonly firedAt: number;
}

export type PersistentCronDispatch = (
  ctx: PersistentCronDispatchContext,
) => void | Promise<void>;

export interface PersistentSchedulerOptions {
  /** Override the on-disk store path. */
  readonly filePath?: string;
  /** Injected dispatch — required for any non-test instance. */
  readonly dispatch: PersistentCronDispatch;
  /** Override `setTimeout` (tests). */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Override `clearTimeout` (tests). */
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /** Override `Date.now()` (tests). */
  readonly nowFn?: () => number;
  /** Logger sink for warnings (defaults to `console.warn`). */
  readonly logger?: { warn: (msg: string) => void };
}

interface ArmedEntry {
  readonly entry: PersistentCronEntry;
  readonly spec: ParsedCronSpec;
  readonly fireAt: number;
  readonly handle: unknown;
}

const MIN_SCHEDULE_DELAY_MS = 1_000;
const MAX_SCHEDULE_DELAY_MS = 6 * 60 * 60 * 1_000; // 6 h — re-evaluate periodically

export class PersistentScheduler {
  private readonly filePath: string;
  private readonly dispatch: PersistentCronDispatch;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly nowFn: () => number;
  private readonly logger: { warn: (msg: string) => void };
  private armed: ArmedEntry | null = null;
  private started = false;
  private stopped = false;
  /**
   * Tracks the in-flight `fire()` promise so callers (chiefly tests)
   * can await `flush()` and be sure all disk side-effects landed
   * before tearing down. Without this, an `await` chain inside fire
   * could race with the test's `afterEach` cleanup and EINVAL on a
   * tmp write after the parent dir got removed.
   */
  private fireInFlight: Promise<void> = Promise.resolve();

  constructor(opts: PersistentSchedulerOptions) {
    this.filePath = opts.filePath ?? defaultCronStorePath();
    this.dispatch = opts.dispatch;
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((cb, ms): unknown => globalThis.setTimeout(cb, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ??
      ((handle): void =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.nowFn = opts.nowFn ?? ((): number => Date.now());
    this.logger =
      opts.logger ??
      {
        warn: (msg): void => {
          // eslint-disable-next-line no-console
          console.warn(`[PersistentScheduler] ${msg}`);
        },
      };
  }

  /**
   * Load the store and arm the next fire. Idempotent — calling `start`
   * twice rearms (useful after an external edit).
   */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error('PersistentScheduler has been stopped — construct a new one');
    }
    this.started = true;
    await this.rearm();
  }

  /**
   * Re-read the store from disk and rearm. Call after an external
   * mutation (e.g. `/cron add` writing a new entry).
   */
  async refresh(): Promise<void> {
    if (!this.started || this.stopped) return;
    await this.rearm();
  }

  /** Tear down the timer. After stop, the instance is dead. */
  stop(): void {
    if (this.armed !== null) {
      try {
        this.clearTimeoutFn(this.armed.handle);
      } catch {
        // best-effort
      }
      this.armed = null;
    }
    this.stopped = true;
    this.started = false;
  }

  /** Currently-armed entry (diagnostics + tests). */
  getArmed(): { entryId: string; fireAt: number } | null {
    if (this.armed === null) return null;
    return { entryId: this.armed.entry.id, fireAt: this.armed.fireAt };
  }

  /**
   * Wait for any in-flight `fire()` chain (and its persist + rearm) to
   * settle. Tests call this before tearing down a tmp dir so disk
   * writes don't race with cleanup. Production callers typically don't
   * need it — the daemon's shutdown sequence already awaits its own
   * stop signal.
   */
  async flush(): Promise<void> {
    await this.fireInFlight.catch(() => undefined);
  }

  /**
   * Pure function — selects the earliest valid fire for `now`. Exported
   * for tests; reused by `rearm`. Skips disabled entries and entries
   * whose cron spec fails to parse (logged + dropped from the candidate
   * set).
   */
  pickNext(
    file: PersistentCronFile,
    now: number,
  ): { entry: PersistentCronEntry; spec: ParsedCronSpec; fireAt: number } | null {
    let winner:
      | { entry: PersistentCronEntry; spec: ParsedCronSpec; fireAt: number }
      | null = null;
    for (const entry of file.crons) {
      if (!entry.enabled) continue;
      let spec: ParsedCronSpec;
      try {
        spec = parseCronSpec(entry.cronSpec);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        this.logger.warn(
          `Skipping cron ${entry.id} — invalid spec '${entry.cronSpec}': ${msg}`,
        );
        continue;
      }
      let fireAt: number;
      try {
        fireAt = nextFireTime(spec, now);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        this.logger.warn(
          `Skipping cron ${entry.id} — no fire time: ${msg}`,
        );
        continue;
      }
      if (winner === null || fireAt < winner.fireAt) {
        winner = { entry, spec, fireAt };
      }
    }
    return winner;
  }

  private async rearm(): Promise<void> {
    if (this.armed !== null) {
      try {
        this.clearTimeoutFn(this.armed.handle);
      } catch {
        // best-effort
      }
      this.armed = null;
    }
    let file: PersistentCronFile;
    try {
      file = await loadCronStore(this.filePath);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      this.logger.warn(`Failed to load cron store: ${msg}`);
      return;
    }
    const now = this.nowFn();
    const next = this.pickNext(file, now);
    if (next === null) return;
    const rawDelay = next.fireAt - now;
    const delay = clampDelay(rawDelay);
    const handle = this.setTimeoutFn(() => {
      // Track the async fire chain so `flush()` / `stop()` callers can
      // await its completion before tearing down the surrounding state.
      this.fireInFlight = this.fireInFlight
        .catch(() => undefined)
        .then(() => this.fire(next.entry, next.spec, next.fireAt));
      void this.fireInFlight;
    }, delay);
    this.armed = {
      entry: next.entry,
      spec: next.spec,
      fireAt: next.fireAt,
      handle,
    };
  }

  private async fire(
    entry: PersistentCronEntry,
    _spec: ParsedCronSpec,
    fireAt: number,
  ): Promise<void> {
    this.armed = null;
    try {
      await this.dispatch({ entry, firedAt: fireAt });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      this.logger.warn(`Dispatch threw for ${entry.id}: ${msg}`);
    }
    // Persist lastFiredAt. Tolerate write failures — we still rearm.
    try {
      await updateCronStore((current) => {
        const next = current.crons.map((c) =>
          c.id === entry.id ? { ...c, lastFiredAt: fireAt } : c,
        );
        return { version: 1, crons: next };
      }, this.filePath);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      this.logger.warn(
        `Failed to persist lastFiredAt for ${entry.id}: ${msg}`,
      );
    }
    if (!this.stopped) await this.rearm();
  }
}

function clampDelay(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_SCHEDULE_DELAY_MS;
  if (raw < MIN_SCHEDULE_DELAY_MS) return MIN_SCHEDULE_DELAY_MS;
  if (raw > MAX_SCHEDULE_DELAY_MS) return MAX_SCHEDULE_DELAY_MS;
  return Math.floor(raw);
}
