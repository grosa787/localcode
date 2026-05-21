/**
 * CircuitBreaker — process-wide fail-fast guard for LLM backends.
 *
 * Why this exists:
 *   When an upstream provider (e.g. OpenRouter) goes down, every active
 *   `ChatRuntime` independently exhausts its retry budget (~84 s for the
 *   default OpenRouter ladder). Three concurrent sessions = 18 doomed
 *   requests over ~4 minutes before any error surfaces to the user. A
 *   shared breaker collapses that into one "down → reject all → probe →
 *   recover" cycle.
 *
 * States:
 *   - CLOSED      — normal operation; requests pass; failures accumulate
 *                   within a sliding {@link failureWindowMs} window.
 *   - OPEN        — N consecutive transient failures crossed the
 *                   threshold; new requests reject immediately until
 *                   {@link nextProbeAt} elapses.
 *   - HALF_OPEN   — single probe in flight after cooldown; success
 *                   transitions back to CLOSED, failure re-opens with
 *                   the cooldown grown by {@link cooldownGrowthFactor}
 *                   up to {@link maxCooldownMs}.
 *
 * Design notes:
 *   - Pure logic. `check()` and `record()` accept an optional `now`
 *     parameter so unit tests can drive the clock deterministically
 *     without setTimeout/jest.useFakeTimers gymnastics.
 *   - Failure classification is the caller's responsibility — the
 *     breaker only knows 'success' | 'failure'. The adapter layer maps
 *     transient errors (network errors, 5xx, `HttpError.transient`)
 *     onto 'failure'; explicit 4xx (client bug) is NOT counted.
 *   - The registry keys on `${backend}::${baseUrl}` so a custom proxy
 *     pointing at a different host gets its own breaker even when the
 *     backend type is the same.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  openedAt: number | null;
  /** Current cooldown in ms — grows on repeat opens, capped at {@link BreakerOptions.maxCooldownMs}. */
  cooldownMs: number;
  /** Wall-clock ms after which the next probe is allowed (null when CLOSED). */
  nextProbeAt: number | null;
}

export interface BreakerOptions {
  /** Consecutive transient failures within {@link failureWindowMs} that trip the breaker. Default 10. */
  failureThreshold?: number;
  /** Sliding window for the failure count. Failures older than this don't count. Default 60_000 ms. */
  failureWindowMs?: number;
  /** Initial cooldown after the first open. Default 30_000 ms. */
  initialCooldownMs?: number;
  /** Hard cap on cooldown growth. Default 300_000 ms (5 min). */
  maxCooldownMs?: number;
  /** Cooldown growth factor applied on each consecutive HALF_OPEN→OPEN transition. Default 2.0. */
  cooldownGrowthFactor?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 10;
const DEFAULT_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_INITIAL_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_GROWTH_FACTOR = 2.0;

export type BreakerSubscriber = (snapshot: BreakerSnapshot) => void;

/** Result of {@link CircuitBreaker.check}. */
export interface BreakerCheckResult {
  /** True if a request may proceed (state is CLOSED or HALF_OPEN). */
  allowed: boolean;
  /** State that the check resolved to. May be 'half-open' on the first call after cooldown elapsed. */
  state: BreakerState;
  /** Human-readable rejection reason when `allowed === false`. */
  reason?: string;
  /** Wall-clock ms at which the next probe is allowed (set when rejecting). */
  nextProbeAt?: number;
}

export class CircuitBreaker {
  private readonly key: string;
  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly initialCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly cooldownGrowthFactor: number;

  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureAt: number | null = null;
  /** Wall-clock ms at which the breaker was opened (null when CLOSED). */
  private openedAt: number | null = null;
  /** Current cooldown ms — set on OPEN entry, grows on HALF_OPEN→OPEN. */
  private currentCooldownMs: number;
  /** Wall-clock ms after which a probe is allowed (null when CLOSED). */
  private nextProbeAt: number | null = null;
  /**
   * Set to true once a HALF_OPEN probe has been handed out via
   * {@link check}. Subsequent `check()` calls while HALF_OPEN reject
   * (only ONE probe in flight at a time). Cleared when the probe's
   * outcome is recorded.
   */
  private probeInFlight = false;

  private readonly subscribers = new Set<BreakerSubscriber>();

  constructor(key: string, options?: BreakerOptions) {
    this.key = key;
    this.failureThreshold = clampPositive(
      options?.failureThreshold,
      DEFAULT_FAILURE_THRESHOLD,
    );
    this.failureWindowMs = clampPositive(
      options?.failureWindowMs,
      DEFAULT_FAILURE_WINDOW_MS,
    );
    this.initialCooldownMs = clampPositive(
      options?.initialCooldownMs,
      DEFAULT_INITIAL_COOLDOWN_MS,
    );
    this.maxCooldownMs = Math.max(
      this.initialCooldownMs,
      clampPositive(options?.maxCooldownMs, DEFAULT_MAX_COOLDOWN_MS),
    );
    const rawGrowth = options?.cooldownGrowthFactor;
    this.cooldownGrowthFactor =
      typeof rawGrowth === 'number' && Number.isFinite(rawGrowth) && rawGrowth >= 1
        ? rawGrowth
        : DEFAULT_COOLDOWN_GROWTH_FACTOR;
    this.currentCooldownMs = this.initialCooldownMs;
  }

  /** Unique key for this breaker (typically `${backend}::${baseUrl}`). */
  getKey(): string {
    return this.key;
  }

  /**
   * Check whether a request may proceed.
   *
   * State transitions performed inside check (auto):
   *   - OPEN with `now >= nextProbeAt` and no probe in flight → HALF_OPEN.
   *     The returned `state` will be `'half-open'` and `allowed === true`,
   *     and `probeInFlight` is set so the next concurrent check rejects.
   *   - OPEN with `now < nextProbeAt` → reject with the current cooldown.
   *   - HALF_OPEN with a probe already in flight → reject (single-probe rule).
   *   - CLOSED → always allow.
   */
  check(now: number = Date.now()): BreakerCheckResult {
    if (this.state === 'closed') {
      return { allowed: true, state: 'closed' };
    }

    if (this.state === 'open') {
      const probeAt = this.nextProbeAt ?? now + this.currentCooldownMs;
      if (now >= probeAt && !this.probeInFlight) {
        // Transition OPEN → HALF_OPEN and hand out the probe.
        this.state = 'half-open';
        this.probeInFlight = true;
        const snap = this.snapshot();
        this.notify(snap);
        return { allowed: true, state: 'half-open' };
      }
      const remainingMs = Math.max(0, probeAt - now);
      return {
        allowed: false,
        state: 'open',
        reason: this.buildOpenReason(remainingMs),
        nextProbeAt: probeAt,
      };
    }

    // HALF_OPEN: only ONE probe at a time. Subsequent callers see OPEN-style rejection.
    if (this.probeInFlight) {
      const probeAt = this.nextProbeAt ?? now;
      return {
        allowed: false,
        state: 'half-open',
        reason: 'Backend probe in flight — waiting for result',
        nextProbeAt: probeAt,
      };
    }

    // HALF_OPEN with no probe in flight is an unusual state — normally
    // the previous probe resolves and we exit HALF_OPEN. Treat as if the
    // cooldown just elapsed and hand out a fresh probe.
    this.probeInFlight = true;
    return { allowed: true, state: 'half-open' };
  }

  /**
   * Record the outcome of a request. Drives state transitions:
   *
   *   CLOSED + failure  → consecutiveFailures++. If failure count crosses
   *                       threshold within the window → OPEN.
   *   CLOSED + success  → reset consecutiveFailures.
   *   HALF_OPEN + success → CLOSED, reset cooldown to initial.
   *   HALF_OPEN + failure → OPEN with cooldown × growthFactor (capped).
   *   OPEN + anything   → no-op (callers shouldn't be recording while OPEN
   *                       — they got an immediate reject — but we defend
   *                       against late-arriving outcomes from in-flight
   *                       requests that started before the trip).
   */
  record(outcome: 'success' | 'failure', now: number = Date.now()): BreakerState {
    const prevState = this.state;

    if (outcome === 'success') {
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.consecutiveFailures = 0;
        this.lastFailureAt = null;
        this.openedAt = null;
        this.nextProbeAt = null;
        this.probeInFlight = false;
        this.currentCooldownMs = this.initialCooldownMs;
        if (prevState !== this.state) this.notify(this.snapshot());
        return this.state;
      }
      if (this.state === 'closed') {
        if (this.consecutiveFailures !== 0) {
          this.consecutiveFailures = 0;
          this.lastFailureAt = null;
          // No state transition — don't notify subscribers on every success.
        }
        return this.state;
      }
      // OPEN + success is a defensive no-op: a late success from a request
      // that started before the trip shouldn't auto-close the breaker.
      return this.state;
    }

    // outcome === 'failure'
    if (this.state === 'half-open') {
      // Probe failed → re-open with grown cooldown (capped).
      this.currentCooldownMs = Math.min(
        Math.floor(this.currentCooldownMs * this.cooldownGrowthFactor),
        this.maxCooldownMs,
      );
      this.state = 'open';
      this.openedAt = now;
      this.nextProbeAt = now + this.currentCooldownMs;
      this.lastFailureAt = now;
      this.probeInFlight = false;
      // consecutiveFailures already represents the streak that opened
      // the breaker; bump for telemetry.
      this.consecutiveFailures += 1;
      this.notify(this.snapshot());
      return this.state;
    }

    if (this.state === 'open') {
      // Late failure from an in-flight request — refresh lastFailureAt
      // for telemetry but do not extend cooldown (the original OPEN
      // schedule still applies).
      this.lastFailureAt = now;
      return this.state;
    }

    // CLOSED + failure
    if (
      this.lastFailureAt !== null &&
      now - this.lastFailureAt > this.failureWindowMs
    ) {
      // Sliding window expired — reset the counter before counting this failure.
      this.consecutiveFailures = 0;
    }
    this.consecutiveFailures += 1;
    this.lastFailureAt = now;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
      this.currentCooldownMs = this.initialCooldownMs;
      this.nextProbeAt = now + this.currentCooldownMs;
      this.probeInFlight = false;
      this.notify(this.snapshot());
    }
    return this.state;
  }

  /** Immutable view of the current state. */
  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
      openedAt: this.openedAt,
      cooldownMs: this.currentCooldownMs,
      nextProbeAt: this.nextProbeAt,
    };
  }

  /**
   * Force the breaker back to CLOSED. Intended for tests and the
   * `/provider` overlay (when a user manually switches backends we
   * should drop any open state on the old key).
   */
  reset(): void {
    const prev = this.state;
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.lastFailureAt = null;
    this.openedAt = null;
    this.nextProbeAt = null;
    this.probeInFlight = false;
    this.currentCooldownMs = this.initialCooldownMs;
    if (prev !== 'closed') this.notify(this.snapshot());
  }

  /**
   * Subscribe to state-change notifications. Fired on every transition
   * (CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→CLOSED, HALF_OPEN→OPEN, and
   * any reset that crosses out of CLOSED).
   *
   * Returns an `unsubscribe` function. Throwing handlers are isolated —
   * a buggy listener never tanks the breaker.
   */
  subscribe(handler: BreakerSubscriber): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  private notify(snapshot: BreakerSnapshot): void {
    for (const fn of this.subscribers) {
      try {
        fn(snapshot);
      } catch {
        // Subscriber bug must never break the breaker.
      }
    }
  }

  private buildOpenReason(remainingMs: number): string {
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return `Backend appears down — auto-resume in ${seconds}s, or /provider to switch`;
  }
}

/**
 * Process-wide registry of `CircuitBreaker` instances keyed by
 * `${backend}::${baseUrl}`. The same `(backend, baseUrl)` tuple always
 * yields the same breaker, so concurrent `ChatRuntime` instances share
 * fail-fast state.
 */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly options: BreakerOptions;
  private readonly listSubscribers = new Set<() => void>();

  constructor(options?: BreakerOptions) {
    this.options = options ? { ...options } : {};
  }

  /** Get-or-create the breaker for `(backend, baseUrl)`. */
  get(backend: string, baseUrl: string): CircuitBreaker {
    const key = registryKey(backend, baseUrl);
    let breaker = this.breakers.get(key);
    if (breaker === undefined) {
      breaker = new CircuitBreaker(key, this.options);
      this.breakers.set(key, breaker);
      // Wire change notifications so registry-level subscribers fire when
      // ANY breaker transitions.
      breaker.subscribe(() => this.notifyList());
      // Tell list subscribers a new breaker was registered (its CLOSED
      // snapshot becomes observable).
      this.notifyList();
    }
    return breaker;
  }

  /**
   * Update the options used for newly-created breakers AND apply a
   * targeted refresh by recreating any existing breakers that are still
   * in CLOSED state. Open/half-open breakers are left intact to avoid
   * dropping live recovery state on a config hot-reload.
   *
   * Returns the keys that were re-created so callers can re-subscribe
   * if they were holding references.
   */
  setOptions(options: BreakerOptions): readonly string[] {
    Object.assign(this.options, options);
    const recreated: string[] = [];
    for (const [key, b] of [...this.breakers]) {
      if (b.snapshot().state !== 'closed') continue;
      const next = new CircuitBreaker(key, this.options);
      next.subscribe(() => this.notifyList());
      this.breakers.set(key, next);
      recreated.push(key);
    }
    if (recreated.length > 0) this.notifyList();
    return recreated;
  }

  /**
   * Reset breakers.
   *   - `reset()`                 — clears every breaker AND drops them
   *                                 from the registry.
   *   - `reset(backend, baseUrl)` — resets a specific breaker (kept in
   *                                 the registry so listeners stay wired).
   *   - `reset(backend)`          — resets every breaker for `backend`
   *                                 regardless of baseUrl.
   */
  reset(backend?: string, baseUrl?: string): void {
    if (backend === undefined && baseUrl === undefined) {
      const wasNonEmpty = this.breakers.size > 0;
      this.breakers.clear();
      if (wasNonEmpty) this.notifyList();
      return;
    }
    if (backend !== undefined && baseUrl !== undefined) {
      const key = registryKey(backend, baseUrl);
      const breaker = this.breakers.get(key);
      if (breaker !== undefined) breaker.reset();
      return;
    }
    if (backend !== undefined) {
      const prefix = `${backend}::`;
      for (const [key, breaker] of this.breakers) {
        if (key.startsWith(prefix)) breaker.reset();
      }
    }
  }

  /** Snapshot every breaker in the registry. Ordered by key for stable output. */
  list(): Array<{ key: string; snapshot: BreakerSnapshot }> {
    const out: Array<{ key: string; snapshot: BreakerSnapshot }> = [];
    const keys = [...this.breakers.keys()].sort();
    for (const key of keys) {
      const b = this.breakers.get(key);
      if (b !== undefined) out.push({ key, snapshot: b.snapshot() });
    }
    return out;
  }

  /**
   * Subscribe to ANY registry-wide change (a breaker transitioned, or a
   * new breaker was registered). Used by `ChatRuntime` to emit
   * `backend_circuit_state` WS frames.
   */
  subscribe(handler: () => void): () => void {
    this.listSubscribers.add(handler);
    return () => {
      this.listSubscribers.delete(handler);
    };
  }

  private notifyList(): void {
    for (const fn of this.listSubscribers) {
      try {
        fn();
      } catch {
        // Defensive — handler bug must not break breaker state updates.
      }
    }
  }
}

/**
 * Process-wide breaker registry. Adapters reach this directly via
 * import; tests reset it between cases via {@link globalBreakerRegistry}
 * `.reset()`.
 */
export const globalBreakerRegistry = new CircuitBreakerRegistry();

/**
 * Error thrown by `streamChat` when the breaker is OPEN. Caught by the
 * adapter's outer catch and surfaced through `onDone({ error })` — so
 * existing callers (including tests) see a clear, actionable message
 * without any retry overhead or network round-trip.
 */
export class BackendCircuitOpenError extends Error {
  public readonly nextProbeAt: number | undefined;
  public readonly backendKey: string | undefined;

  constructor(message: string, nextProbeAt?: number, backendKey?: string) {
    super(message);
    this.name = 'BackendCircuitOpenError';
    this.nextProbeAt = nextProbeAt;
    this.backendKey = backendKey;
  }
}

/**
 * Build the canonical registry key for a `(backend, baseUrl)` tuple.
 * Strips trailing slashes from `baseUrl` so `https://x.y/` and
 * `https://x.y` collapse onto the same breaker.
 */
export function registryKey(backend: string, baseUrl: string): string {
  const normalised = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${backend}::${normalised}`;
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}
