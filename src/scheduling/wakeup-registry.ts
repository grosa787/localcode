/**
 * In-process registry of pending wakeups.
 *
 * Each entry holds a Node `setTimeout` handle + the captured callback. On
 * fire the callback is invoked once, the entry is removed, and subscribers
 * are notified. Cancel + dispose both clear the underlying timer so a
 * disposed registry never re-enters userland code.
 *
 * Process-wide singleton (`getProcessWakeupRegistry`) is the production
 * entry point used by both `src/app.tsx` (TUI) and `src/web/index.ts`
 * (web). Tests construct their own instance with injected timer fns so
 * they don't depend on wall-clock waits.
 */

import type {
  ScheduledWakeup,
  WakeupCallback,
  WakeupListChangeListener,
  WakeupRegistryOptions,
} from './types';

/** Minimum / maximum delays accepted by `schedule` (milliseconds). */
export const WAKEUP_MIN_DELAY_MS = 60_000; // 60 s
export const WAKEUP_MAX_DELAY_MS = 3_600_000; // 1 h

interface ScheduleArgs {
  /** Delay before the wakeup fires (ms). Clamped to [60_000, 3_600_000]. */
  delayMs: number;
  /** Self-prompt that becomes the next user turn on fire. */
  prompt: string;
  /** One-sentence rationale (UI label). */
  reason: string;
}

interface InternalEntry {
  readonly snapshot: ScheduledWakeup;
  readonly handle: unknown;
}

/**
 * Process-local scheduler. NOT persistent across sessions / restarts.
 */
export class WakeupRegistry {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly listeners = new Set<WakeupListChangeListener>();
  private readonly onFire: WakeupCallback;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly nowFn: () => number;
  private readonly randomIdFn: () => string;
  private disposed = false;

  constructor(onFire: WakeupCallback, opts: WakeupRegistryOptions = {}) {
    this.onFire = onFire;
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.nowFn = opts.nowFn ?? ((): number => Date.now());
    this.randomIdFn = opts.randomIdFn ?? defaultRandomId;
  }

  /**
   * Schedule a wakeup for `sessionId`. Returns the new wakeup id.
   *
   * `delayMs` is clamped to `[WAKEUP_MIN_DELAY_MS, WAKEUP_MAX_DELAY_MS]`
   * — clamping rather than throwing because the tool layer already
   * Zod-validates the model's input; the clamp is defense-in-depth
   * against direct registry callers.
   */
  schedule(sessionId: string, args: ScheduleArgs): string {
    if (this.disposed) {
      throw new Error('WakeupRegistry is disposed');
    }
    const id = `wkup-${this.randomIdFn()}`;
    const now = this.nowFn();
    const delayMs = clampDelay(args.delayMs);
    const fireAt = now + delayMs;
    const snapshot: ScheduledWakeup = Object.freeze({
      id,
      sessionId,
      prompt: args.prompt,
      reason: args.reason,
      createdAt: now,
      fireAt,
    });
    const handle = this.setTimeoutFn(() => {
      // Guard: if the entry was cancelled between schedule and fire (and
      // the test runner's fake timer didn't honour the cancel), bail.
      const live = this.entries.get(id);
      if (live === undefined) return;
      this.entries.delete(id);
      this.notify();
      // Fire-and-forget — callback errors are caught so the timer pipe
      // stays clean for subsequent wakeups.
      try {
        const ret = this.onFire(sessionId, args.prompt, snapshot);
        if (ret instanceof Promise) {
          ret.catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.warn(
              `[WakeupRegistry] onFire rejected for ${id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[WakeupRegistry] onFire threw for ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }, delayMs);
    this.entries.set(id, { snapshot, handle });
    this.notify();
    return id;
  }

  /**
   * Cancel a scheduled wakeup. No-op when the id is unknown (the wakeup
   * may have already fired or been cancelled). Returns true when an
   * entry was actually removed — useful for slash-command UX.
   */
  cancel(wakeupId: string): boolean {
    const entry = this.entries.get(wakeupId);
    if (entry === undefined) return false;
    this.clearTimeoutFn(entry.handle);
    this.entries.delete(wakeupId);
    this.notify();
    return true;
  }

  /** Snapshot of pending wakeups in `fireAt` order. Cheap — entries map
   *  is small (single-digit at most in practice). */
  list(): ScheduledWakeup[] {
    return [...this.entries.values()]
      .map((e) => e.snapshot)
      .sort((a, b) => a.fireAt - b.fireAt);
  }

  /** Subscribe to list-changed events. Returns an unsubscribe fn. */
  subscribe(listener: WakeupListChangeListener): () => void {
    this.listeners.add(listener);
    // Fire once eagerly so a newly-subscribed listener sees current state.
    try {
      listener(this.list());
    } catch {
      // swallow — listener errors must not kick the subscriber back out
    }
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Clear every pending timer and mark the registry disposed. After
   * dispose every `schedule` call throws and `cancel` becomes a no-op.
   *
   * Listeners are NOT notified after dispose — the registry going away is
   * structural, not a list change observers should react to. They are
   * cleared so a leaked listener doesn't pin the registry in memory.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      try {
        this.clearTimeoutFn(entry.handle);
      } catch {
        // swallow — best-effort
      }
    }
    this.entries.clear();
    this.listeners.clear();
  }

  /** True when the registry has been disposed. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Pending count — diagnostics + tests. */
  size(): number {
    return this.entries.size;
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // swallow — listener errors must not break the schedule pipe
      }
    }
  }
}

// ---------- Process-wide singleton ----------

let processRegistry: WakeupRegistry | null = null;

/**
 * Return the process-wide singleton registry. Lazily initialised the
 * first time it's needed with a no-op `onFire` — the composition root
 * (`src/app.tsx` or `src/web/index.ts`) overrides this by calling
 * {@link setProcessWakeupRegistry} with the wired version.
 *
 * Returning a no-op default keeps `getProcessWakeupRegistry()` safe to
 * call from tool code in test environments where no composition root has
 * run, without forcing every test to bootstrap the full app.
 */
export function getProcessWakeupRegistry(): WakeupRegistry {
  if (processRegistry === null) {
    processRegistry = new WakeupRegistry(() => undefined);
  }
  return processRegistry;
}

/**
 * Replace the singleton with the supplied registry. The composition
 * roots call this once at startup so all tool calls share the same
 * instance.
 *
 * Disposing the previously-installed registry is the caller's
 * responsibility — passing `null` here both resets the singleton AND
 * disposes the prior one for ergonomic shutdown paths.
 */
export function setProcessWakeupRegistry(next: WakeupRegistry | null): void {
  if (next === null) {
    if (processRegistry !== null) {
      processRegistry.dispose();
      processRegistry = null;
    }
    return;
  }
  if (processRegistry !== null && processRegistry !== next) {
    processRegistry.dispose();
  }
  processRegistry = next;
}

// ---------- Helpers ----------

function clampDelay(raw: number): number {
  if (!Number.isFinite(raw)) return WAKEUP_MIN_DELAY_MS;
  if (raw < WAKEUP_MIN_DELAY_MS) return WAKEUP_MIN_DELAY_MS;
  if (raw > WAKEUP_MAX_DELAY_MS) return WAKEUP_MAX_DELAY_MS;
  return Math.floor(raw);
}

function defaultRandomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
