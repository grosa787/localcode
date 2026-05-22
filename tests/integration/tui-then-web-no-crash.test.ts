/**
 * Regression: when the TUI bootstraps the process-wide MCP registry and
 * then the user runs `/web` (embedded web server boots and ALSO calls
 * `getProcessMcpRegistry().start(...)`), the second call must NOT crash
 * the host with `Unhandled rejection: MCPRegistry: already disposed`.
 *
 * We don't boot Bun.serve here — that's covered by `tests/web/*`. We
 * exercise the contract that the embedded launch path relies on:
 *   1. TUI starts the singleton (effect with `[config]`).
 *   2. TUI's effect re-runs (config mutation, e.g. provider switch).
 *      Historical bug: the cleanup disposed the singleton.
 *   3. Embedded web calls `start()` on the singleton.
 *   4. SIGINT → dispose() → process exit.
 * No `unhandledRejection` event should fire at any step.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  MCPRegistry,
  getProcessMcpRegistry,
  setProcessMcpRegistry,
} from '@/mcp/registry';

describe('TUI → /web boot interplay (no MCPRegistry crash)', () => {
  afterEach(() => {
    setProcessMcpRegistry(null);
  });

  test('TUI start → re-start (effect re-run) → web start → no rejection', async () => {
    const rejections: unknown[] = [];
    const onReject = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onReject);
    try {
      // 1. TUI bootstraps the singleton.
      setProcessMcpRegistry(new MCPRegistry());
      const registry = getProcessMcpRegistry();
      await registry.start({});

      // 2. TUI effect re-runs on a config mutation. After the fix the
      //    cleanup no longer disposes the singleton on every render, so
      //    a second start() must still succeed.
      await registry.start({});

      // 3. Embedded /web server calls start() on the SAME singleton. The
      //    historical crash was here: the registry would be in the
      //    `disposed=true` state set by step (2)'s cleanup → throw.
      const sameRegistry = getProcessMcpRegistry();
      expect(sameRegistry).toBe(registry);
      await sameRegistry.start({});

      // 4. Single dispose on shutdown.
      await sameRegistry.dispose();

      // Give the event loop a tick to surface any pending rejections.
      await new Promise<void>((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onReject);
    }
    expect(rejections).toEqual([]);
  });

  test('worst case: dispose between TUI boot and /web boot is non-fatal', async () => {
    // Even if some pathological code path disposed the registry between
    // TUI boot and /web boot, the second start() must still resolve so
    // the embedded server's `void start(...)` doesn't become an
    // unhandled rejection.
    const rejections: unknown[] = [];
    const onReject = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onReject);
    try {
      setProcessMcpRegistry(new MCPRegistry());
      const registry = getProcessMcpRegistry();
      await registry.start({});
      await registry.dispose();

      // /web boot — must not throw / reject even though we're disposed.
      // This is the exact pattern in src/web/index.ts.
      await expect(
        getProcessMcpRegistry().start({}),
      ).resolves.toBeUndefined();
      await new Promise<void>((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onReject);
    }
    expect(rejections).toEqual([]);
  });

  test('double dispose (TUI unmount + signal handler) does not throw', async () => {
    const rejections: unknown[] = [];
    const onReject = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onReject);
    try {
      setProcessMcpRegistry(new MCPRegistry());
      const registry = getProcessMcpRegistry();
      await registry.start({});

      // Simulate: TUI unmount cleanup fires AND /web's SIGINT handler
      // fires — both call dispose() on the same singleton.
      await Promise.all([registry.dispose(), registry.dispose()]);
      await new Promise<void>((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onReject);
    }
    expect(rejections).toEqual([]);
  });
});
