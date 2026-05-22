/**
 * Regression: MCPRegistry.dispose() must tolerate being called twice.
 *
 * The original bug: the TUI's React `useEffect([config])` would fire its
 * cleanup on every config mutation, calling `dispose()` → setting
 * `disposed = true`. The embedded `/web` server then called `dispose()`
 * again on SIGINT, which (combined with the now-disposed `start()`) bled
 * into an "Unhandled rejection: MCPRegistry: already disposed" crash.
 *
 * Pure idempotency check — no transports, no network.
 */

import { describe, expect, test } from 'bun:test';
import { MCPRegistry } from '@/mcp/registry';

describe('MCPRegistry.dispose() idempotency', () => {
  test('calling dispose twice does not throw', async () => {
    const reg = new MCPRegistry();
    await reg.dispose();
    // Second call must be a no-op, never throw.
    await expect(reg.dispose()).resolves.toBeUndefined();
  });

  test('calling dispose three+ times stays a no-op', async () => {
    const reg = new MCPRegistry();
    await reg.dispose();
    await reg.dispose();
    await reg.dispose();
    expect(reg.isDisposed()).toBe(true);
  });

  test('dispose with no servers ever started is safe', async () => {
    const reg = new MCPRegistry();
    expect(reg.isDisposed()).toBe(false);
    await reg.dispose();
    expect(reg.isDisposed()).toBe(true);
    expect(reg.getServers()).toEqual([]);
    expect(reg.getAllTools()).toEqual([]);
  });
});
