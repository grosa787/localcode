/**
 * Circuit-breaker unit tests — pure logic only, no network.
 *
 * Every test injects `now` so transitions are deterministic without
 * fake timers. The breaker is constructed fresh in each test (and the
 * registry is reset in the dedicated registry block) so state never
 * leaks between cases.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  BackendCircuitOpenError,
  globalBreakerRegistry,
  registryKey,
  type BreakerOptions,
} from '@/llm/circuit-breaker';

const KEY = 'openrouter::https://openrouter.ai/api/v1';

function freshBreaker(overrides: BreakerOptions = {}): CircuitBreaker {
  return new CircuitBreaker(KEY, {
    failureThreshold: 3,
    failureWindowMs: 10_000,
    initialCooldownMs: 1_000,
    maxCooldownMs: 8_000,
    cooldownGrowthFactor: 2.0,
    ...overrides,
  });
}

describe('CircuitBreaker — pure state machine', () => {
  test('starts CLOSED with zero failures', () => {
    const b = freshBreaker();
    const snap = b.snapshot();
    expect(snap.state).toBe('closed');
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.lastFailureAt).toBeNull();
    expect(snap.openedAt).toBeNull();
    expect(snap.nextProbeAt).toBeNull();
  });

  test('CLOSED → records below threshold do not trip the breaker', () => {
    const b = freshBreaker();
    b.record('failure', 1000);
    b.record('failure', 1500);
    const snap = b.snapshot();
    expect(snap.state).toBe('closed');
    expect(snap.consecutiveFailures).toBe(2);
  });

  test('CLOSED → OPEN at threshold (3 consecutive failures within window)', () => {
    const b = freshBreaker();
    b.record('failure', 1000);
    b.record('failure', 1500);
    const finalState = b.record('failure', 2000);
    expect(finalState).toBe('open');
    const snap = b.snapshot();
    expect(snap.state).toBe('open');
    expect(snap.openedAt).toBe(2000);
    expect(snap.cooldownMs).toBe(1000);
    expect(snap.nextProbeAt).toBe(3000);
  });

  test('check() while OPEN before nextProbeAt rejects with reason + nextProbeAt', () => {
    const b = freshBreaker();
    for (let i = 0; i < 3; i += 1) b.record('failure', 1000 + i);
    const result = b.check(1500);
    expect(result.allowed).toBe(false);
    expect(result.state).toBe('open');
    expect(result.reason).toMatch(/Backend appears down/);
    expect(result.nextProbeAt).toBe(2002);
  });

  test('OPEN → HALF_OPEN via check() at or after nextProbeAt', () => {
    const b = freshBreaker();
    for (let i = 0; i < 3; i += 1) b.record('failure', 1000 + i);
    // nextProbeAt = 1002 + 1000 = 2002
    const before = b.check(2001);
    expect(before.allowed).toBe(false);
    expect(before.state).toBe('open');

    const probe = b.check(2002);
    expect(probe.allowed).toBe(true);
    expect(probe.state).toBe('half-open');
  });

  test('HALF_OPEN rejects concurrent checks while a probe is in flight (single-probe rule)', () => {
    const b = freshBreaker();
    for (let i = 0; i < 3; i += 1) b.record('failure', 1000 + i);
    const first = b.check(5000);
    expect(first.allowed).toBe(true);
    expect(first.state).toBe('half-open');

    const second = b.check(5000);
    expect(second.allowed).toBe(false);
    expect(second.state).toBe('half-open');
    expect(second.reason).toMatch(/probe in flight/);
  });

  test('HALF_OPEN + success → CLOSED, cooldown resets to initial', () => {
    const b = freshBreaker();
    for (let i = 0; i < 3; i += 1) b.record('failure', 1000 + i);
    b.check(5000); // HALF_OPEN
    const next = b.record('success', 5100);
    expect(next).toBe('closed');
    const snap = b.snapshot();
    expect(snap.state).toBe('closed');
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.cooldownMs).toBe(1000);
    expect(snap.nextProbeAt).toBeNull();
  });

  test('HALF_OPEN + failure → OPEN with cooldown × growthFactor (capped)', () => {
    const b = freshBreaker();
    for (let i = 0; i < 3; i += 1) b.record('failure', 1000 + i);
    b.check(5000); // HALF_OPEN
    const after = b.record('failure', 5100);
    expect(after).toBe('open');
    const snap = b.snapshot();
    // Initial 1000 × 2 = 2000
    expect(snap.cooldownMs).toBe(2000);
    expect(snap.nextProbeAt).toBe(7100);

    // Second probe → fail again → cooldown 4000.
    b.check(7100);
    b.record('failure', 7200);
    expect(b.snapshot().cooldownMs).toBe(4000);

    // Third probe → fail → 8000 (cap).
    b.check(11_200);
    b.record('failure', 11_300);
    expect(b.snapshot().cooldownMs).toBe(8000);

    // Fourth probe → fail → still 8000 (cap respected).
    b.check(19_300);
    b.record('failure', 19_400);
    expect(b.snapshot().cooldownMs).toBe(8000);
  });

  test('Successful request in CLOSED state resets consecutiveFailures', () => {
    const b = freshBreaker();
    b.record('failure', 1000);
    b.record('failure', 1500);
    expect(b.snapshot().consecutiveFailures).toBe(2);
    b.record('success', 1800);
    const snap = b.snapshot();
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.lastFailureAt).toBeNull();
    expect(snap.state).toBe('closed');
  });

  test('Failure outside sliding window resets consecutive count before counting', () => {
    const b = freshBreaker({ failureThreshold: 3, failureWindowMs: 1000 });
    b.record('failure', 1000);
    b.record('failure', 1500);
    // 3rd failure at t=10_000 — outside the 1s window since last failure.
    const state = b.record('failure', 10_000);
    expect(state).toBe('closed');
    expect(b.snapshot().consecutiveFailures).toBe(1);
  });

  test('Two more failures within window AFTER reset trip OPEN', () => {
    const b = freshBreaker({ failureThreshold: 3, failureWindowMs: 1000 });
    b.record('failure', 1000);
    b.record('failure', 1500);
    b.record('failure', 10_000); // resets, counts as 1
    b.record('failure', 10_300);
    const state = b.record('failure', 10_600);
    expect(state).toBe('open');
  });

  test('OPEN + late failure refreshes lastFailureAt without extending cooldown', () => {
    const b = freshBreaker();
    for (let i = 0; i < 3; i += 1) b.record('failure', 1000 + i);
    const originalProbeAt = b.snapshot().nextProbeAt;
    b.record('failure', 1500);
    const snap = b.snapshot();
    expect(snap.state).toBe('open');
    expect(snap.nextProbeAt).toBe(originalProbeAt);
    expect(snap.lastFailureAt).toBe(1500);
  });

  test('OPEN + late success is a defensive no-op (no auto-close)', () => {
    const b = freshBreaker();
    for (let i = 0; i < 3; i += 1) b.record('failure', 1000 + i);
    const state = b.record('success', 1500);
    expect(state).toBe('open');
    expect(b.snapshot().state).toBe('open');
  });

  test('subscribe fires on every state transition; not on closed-state successes', () => {
    const b = freshBreaker();
    const transitions: string[] = [];
    b.subscribe((snap) => transitions.push(snap.state));

    b.record('failure', 1000);
    b.record('failure', 1500);
    b.record('success', 1800); // CLOSED → CLOSED — no notification
    expect(transitions).toEqual([]);

    b.record('failure', 2000);
    b.record('failure', 2100);
    b.record('failure', 2200); // → OPEN
    expect(transitions).toEqual(['open']);

    b.check(3200); // → HALF_OPEN
    expect(transitions).toEqual(['open', 'half-open']);

    b.record('success', 3300); // → CLOSED
    expect(transitions).toEqual(['open', 'half-open', 'closed']);
  });

  test('unsubscribe stops further notifications', () => {
    const b = freshBreaker();
    const transitions: string[] = [];
    const off = b.subscribe((snap) => transitions.push(snap.state));
    off();
    for (let i = 0; i < 3; i += 1) b.record('failure', 1000 + i);
    expect(transitions).toEqual([]);
  });

  test('subscriber that throws is isolated — breaker state still transitions', () => {
    const b = freshBreaker();
    b.subscribe(() => {
      throw new Error('boom');
    });
    for (let i = 0; i < 3; i += 1) b.record('failure', 1000 + i);
    expect(b.snapshot().state).toBe('open');
  });

  test('reset() returns to CLOSED and fires subscribers when state crossed', () => {
    const b = freshBreaker();
    const transitions: string[] = [];
    b.subscribe((snap) => transitions.push(snap.state));
    for (let i = 0; i < 3; i += 1) b.record('failure', 1000 + i);
    b.reset();
    expect(b.snapshot().state).toBe('closed');
    expect(transitions[transitions.length - 1]).toBe('closed');
  });

  test('check() never mutates CLOSED state', () => {
    const b = freshBreaker();
    const before = b.snapshot();
    b.check(1000);
    b.check(2000);
    const after = b.snapshot();
    expect(after).toEqual(before);
  });

  test('cooldown growth uses floor (no fractional ms drift)', () => {
    const b = freshBreaker({
      failureThreshold: 1,
      initialCooldownMs: 333,
      cooldownGrowthFactor: 1.5,
      maxCooldownMs: 10_000,
    });
    b.record('failure', 0);
    b.check(333);
    b.record('failure', 400);
    expect(b.snapshot().cooldownMs).toBe(Math.floor(333 * 1.5)); // 499
  });
});

describe('CircuitBreakerRegistry', () => {
  let registry: CircuitBreakerRegistry;
  beforeEach(() => {
    registry = new CircuitBreakerRegistry({
      failureThreshold: 2,
      initialCooldownMs: 500,
      maxCooldownMs: 2000,
    });
  });

  test('get returns the same instance for the same (backend, baseUrl)', () => {
    const a = registry.get('openrouter', 'https://openrouter.ai/api/v1');
    const b = registry.get('openrouter', 'https://openrouter.ai/api/v1');
    expect(a).toBe(b);
  });

  test('get returns distinct instances for distinct keys', () => {
    const a = registry.get('openrouter', 'https://openrouter.ai/api/v1');
    const b = registry.get('openrouter', 'https://other-proxy.example/api/v1');
    expect(a).not.toBe(b);
  });

  test('trailing-slash normalisation collapses keys', () => {
    const a = registry.get('openrouter', 'https://openrouter.ai/api/v1');
    const b = registry.get('openrouter', 'https://openrouter.ai/api/v1/');
    expect(a).toBe(b);
  });

  test('list() returns sorted snapshots', () => {
    registry.get('openrouter', 'https://openrouter.ai/api/v1');
    registry.get('anthropic', 'https://api.anthropic.com/v1');
    const list = registry.list();
    expect(list.map((e) => e.key)).toEqual([
      'anthropic::https://api.anthropic.com/v1',
      'openrouter::https://openrouter.ai/api/v1',
    ]);
  });

  test('reset(backend, baseUrl) clears just that breaker', () => {
    const target = registry.get('openrouter', 'https://openrouter.ai/api/v1');
    const other = registry.get('anthropic', 'https://api.anthropic.com/v1');
    target.record('failure', 1);
    target.record('failure', 2);
    other.record('failure', 1);
    expect(target.snapshot().state).toBe('open');
    expect(other.snapshot().consecutiveFailures).toBe(1);

    registry.reset('openrouter', 'https://openrouter.ai/api/v1');
    expect(target.snapshot().state).toBe('closed');
    expect(other.snapshot().consecutiveFailures).toBe(1);
  });

  test('reset() with no args clears every breaker', () => {
    const target = registry.get('openrouter', 'https://openrouter.ai/api/v1');
    target.record('failure', 1);
    target.record('failure', 2);
    expect(target.snapshot().state).toBe('open');
    registry.reset();
    expect(registry.list()).toEqual([]);
  });

  test('registry-level subscribe fires on a new breaker AND on transitions', () => {
    let changes = 0;
    registry.subscribe(() => {
      changes += 1;
    });
    const b = registry.get('openrouter', 'https://openrouter.ai/api/v1');
    expect(changes).toBeGreaterThanOrEqual(1);
    const before = changes;
    b.record('failure', 1);
    b.record('failure', 2); // → OPEN — should fire
    expect(changes).toBeGreaterThan(before);
  });

  test('registryKey strips trailing slash', () => {
    expect(registryKey('openai', 'https://api.openai.com/v1/')).toBe(
      'openai::https://api.openai.com/v1',
    );
  });
});

describe('BackendCircuitOpenError', () => {
  test('preserves nextProbeAt and backendKey fields', () => {
    const err = new BackendCircuitOpenError('blocked', 1234, 'openrouter::https://x');
    expect(err.name).toBe('BackendCircuitOpenError');
    expect(err.message).toBe('blocked');
    expect(err.nextProbeAt).toBe(1234);
    expect(err.backendKey).toBe('openrouter::https://x');
  });
});

describe('globalBreakerRegistry', () => {
  beforeEach(() => globalBreakerRegistry.reset());

  test('is shared module-wide', () => {
    const a = globalBreakerRegistry.get('openai', 'https://api.openai.com/v1');
    const b = globalBreakerRegistry.get('openai', 'https://api.openai.com/v1');
    expect(a).toBe(b);
  });
});
