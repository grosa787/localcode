/**
 * Regression: MCPRegistry.start() called AFTER dispose() must NOT throw.
 *
 * Root cause of the original `/web` crash: `start()` had
 *   if (this.disposed) throw new Error('MCPRegistry: already disposed');
 * — turned into an unhandled promise rejection because the embedded web
 * server's `void registry.start(...)` did not attach `.catch`.
 *
 * Contract going forward: `start()` is a no-op on a disposed registry
 * and resolves with an empty tools list.
 */

import { describe, expect, test } from 'bun:test';
import { MCPRegistry } from '@/mcp/registry';
import type { McpServerConfig } from '@/types/global';

describe('MCPRegistry.start() after dispose()', () => {
  test('start() resolves without throwing when registry is disposed', async () => {
    const reg = new MCPRegistry();
    await reg.dispose();

    const servers: Record<string, McpServerConfig> = {
      'fake-server': {
        type: 'stdio',
        command: '/bin/false',
        args: [],
      },
    };
    // Must NOT reject — historical behaviour was to throw
    // "MCPRegistry: already disposed".
    await expect(reg.start(servers)).resolves.toBeUndefined();
    expect(reg.getServers()).toEqual([]);
    expect(reg.getAllTools()).toEqual([]);
  });

  test('start() with empty server map after dispose is safe', async () => {
    const reg = new MCPRegistry();
    await reg.dispose();
    await expect(reg.start({})).resolves.toBeUndefined();
  });

  test('isDisposed() reflects the post-dispose state', async () => {
    const reg = new MCPRegistry();
    expect(reg.isDisposed()).toBe(false);
    await reg.dispose();
    expect(reg.isDisposed()).toBe(true);
    // start() does not flip the flag back.
    await reg.start({});
    expect(reg.isDisposed()).toBe(true);
  });
});
