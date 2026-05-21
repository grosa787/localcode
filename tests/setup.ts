/**
 * Test environment setup — preloaded via `bunfig.toml` for every `bun test`
 * run. Keep this deliberately small: any per-file state belongs in that
 * test's own beforeEach / afterEach hooks.
 *
 * We:
 *   - force process.env.NODE_ENV to "test" so any code path that cares
 *     can behave deterministically,
 *   - register a single safety-net for unhandled rejections (printed, never
 *     thrown — bun:test already fails the suite on an unhandled rejection).
 */

if (process.env['NODE_ENV'] === undefined) {
  process.env['NODE_ENV'] = 'test';
}

// Leave existing listeners in place — bun:test installs its own.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[tests/setup] unhandled rejection:', reason);
});

// Circuit breaker — reset the process-wide registry between every test
// so accumulated failures from one adapter test don't trip the breaker
// for a later test that uses the same `(backend, baseUrl)`. Without
// this, e.g. the openrouter-retry-budget suite leaves the breaker in
// OPEN state and the next suite's first call short-circuits.
//
// Tests that want to assert breaker behaviour explicitly should still
// call `globalBreakerRegistry.reset()` themselves at the top of the
// case — this hook is a safety net, not a replacement.
import { afterEach } from 'bun:test';
import { globalBreakerRegistry } from '@/llm/circuit-breaker';
afterEach(() => {
  globalBreakerRegistry.reset();
});
