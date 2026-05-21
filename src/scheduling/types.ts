/**
 * Types for the in-session deferred-continuation scheduler.
 *
 * `WakeupRegistry` lets the model defer its own next turn by N seconds —
 * useful for waiting on a slow build / poll loop / scheduled retry. The
 * scheduler is purely in-process: timers are held in memory and there is
 * no persistence across sessions.
 *
 * Cross-process / cross-session scheduling is out of scope here; for
 * persistent cron-style work see `src/agents/` / future schedule modules.
 */

/** A wakeup entry currently held by the registry. */
export interface ScheduledWakeup {
  /** Stable identifier for cancel + UI lookups (`wkup-<uuid>`). */
  readonly id: string;
  /** Session that scheduled the wakeup; used to route the synthetic user
   *  message back to the right ChatRuntime / ChatState on fire. */
  readonly sessionId: string;
  /** Self-prompt that becomes the next user turn when the timer fires. */
  readonly prompt: string;
  /** One-sentence rationale shown to the user via the UI badge / slash
   *  command list. Surfaces "why is this scheduled?" without forcing the
   *  user to read the prompt body. */
  readonly reason: string;
  /** Wall-clock time the entry was created (ms since epoch). */
  readonly createdAt: number;
  /** Wall-clock time the entry will fire (ms since epoch). */
  readonly fireAt: number;
}

/**
 * Callback fired when a wakeup timer elapses. The composition root wires
 * this to the right transport — TUI injects via `ENQUEUE_PENDING`, web
 * runtime injects via `ChatRuntime.queueWakeupPrompt`.
 *
 * Errors thrown by the callback are caught by the registry and logged;
 * they never propagate to the timer thread or kill subsequent wakeups.
 */
export type WakeupCallback = (
  sessionId: string,
  prompt: string,
  entry: ScheduledWakeup,
) => void | Promise<void>;

/**
 * Subscription emitted by `WakeupRegistry.subscribe`. Called whenever the
 * pending-wakeups list changes (schedule, cancel, fire, dispose).
 */
export type WakeupListChangeListener = (
  snapshot: readonly ScheduledWakeup[],
) => void;

/**
 * Construction options for `WakeupRegistry`. All fields optional — tests
 * inject a stub `setTimeoutFn`/`clearTimeoutFn` pair so they don't depend
 * on real wall-clock waits.
 */
export interface WakeupRegistryOptions {
  /** Override for `setTimeout` — defaults to `globalThis.setTimeout`. */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Override for `clearTimeout` — defaults to `globalThis.clearTimeout`. */
  readonly clearTimeoutFn?: (handle: unknown) => void;
  /** Override for `Date.now` — defaults to `() => Date.now()`. */
  readonly nowFn?: () => number;
  /** Override for `crypto.randomUUID` — defaults to native + Math.random
   *  fallback so tests stay deterministic if they want to inject ids. */
  readonly randomIdFn?: () => string;
}
