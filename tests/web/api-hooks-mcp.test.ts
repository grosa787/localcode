/**
 * Tests for GET /api/hooks and GET /api/mcp.
 *
 * Exercises createApiHandler dispatch to the new endpoints using the
 * same stub-deps pattern as api-roundtrip.test.ts. The MCP registry
 * is isolated via setProcessMcpRegistry so tests never touch the
 * process-wide singleton.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';
import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import {
  createApiHandler,
  type ApiDeps,
  type ProviderAdapter,
} from '@/web/api';
import { WorkspaceRegistry } from '@/web/workspace/workspace-registry';
import type { Backend } from '@/types/global';
import {
  MCPRegistry,
  setProcessMcpRegistry,
  type McpRegistryServerView,
} from '@/mcp';
import type { HookConfigEntry } from '@/types/global';

// ── Test infrastructure ──────────────────────────────────────────────

let tempDir: string;
let db: Database | null = null;
let configManager: ConfigManager;
let sessionManager: SessionManager;
let workspaceRegistry: WorkspaceRegistry;

function deps(): ApiDeps {
  return {
    configManager,
    sessionManager,
    workspaceRegistry,
    createAdapterForBackend: (_backend: Backend, _baseUrl: string, _apiKey?: string): ProviderAdapter => ({
      getModels: async () => [],
    }),
  };
}

function call(
  handler: ReturnType<typeof createApiHandler>,
  method: string,
  path: string,
): Promise<Response | null> {
  const url = new URL(`http://localhost${path}`);
  return handler(new Request(url, { method }), url);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lc-hooks-mcp-'));
  mkdirSync(join(tempDir, 'proj'), { recursive: true });

  configManager = new ConfigManager(join(tempDir, 'config.toml'));
  const cfg = getDefaultConfig('ollama');
  cfg.model.current = 'llama3';
  cfg.model.available = ['llama3'];
  cfg.onboarding.completed = true;
  configManager.write(cfg);

  db = openDb(':memory:');
  sessionManager = new SessionManager(db);
  workspaceRegistry = new WorkspaceRegistry({
    filePath: join(tempDir, 'ws.json'),
  });

  // Isolate: each test gets a fresh registry. Reset singleton after test.
  setProcessMcpRegistry(new MCPRegistry());
});

afterEach(() => {
  // Reset process-wide singleton to avoid cross-test contamination.
  setProcessMcpRegistry(null);

  try { db?.close(); } catch { /* ignore */ }
  db = null;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── /api/hooks ───────────────────────────────────────────────────────

test('GET /api/hooks returns hooks array from config', async () => {
  const hooks: HookConfigEntry[] = [
    { trigger: 'PreToolUse', command: 'echo pre', blocking: false },
    { trigger: 'SessionStart', command: 'echo start' },
  ];
  const cur = configManager.read();
  configManager.write({ ...cur, hooks });

  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/hooks');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { hooks: HookConfigEntry[] };
  expect(Array.isArray(body.hooks)).toBe(true);
  expect(body.hooks).toHaveLength(2);
  expect(body.hooks[0]?.trigger).toBe('PreToolUse');
  expect(body.hooks[1]?.trigger).toBe('SessionStart');
});

test('GET /api/hooks returns { hooks: [] } when config has none', async () => {
  // Default config has no hooks section — should return empty array.
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/hooks');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { hooks: HookConfigEntry[] };
  expect(body.hooks).toEqual([]);
});

test('GET /api/hooks with explicit empty hooks returns { hooks: [] }', async () => {
  const cur = configManager.read();
  configManager.write({ ...cur, hooks: [] });

  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/hooks');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { hooks: HookConfigEntry[] };
  expect(body.hooks).toEqual([]);
});

test('POST /api/hooks returns 405', async () => {
  const url = new URL('http://localhost/api/hooks');
  const h = createApiHandler(deps());
  const res = await h(new Request(url, { method: 'POST' }), url);
  expect(res?.status).toBe(405);
});

test('DELETE /api/hooks returns 405', async () => {
  const url = new URL('http://localhost/api/hooks');
  const h = createApiHandler(deps());
  const res = await h(new Request(url, { method: 'DELETE' }), url);
  expect(res?.status).toBe(405);
});

// ── /api/mcp ─────────────────────────────────────────────────────────

test('GET /api/mcp returns { servers: [] } before start() is called', async () => {
  // Fresh registry, start() never called — snapshot is empty.
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/mcp');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { servers: McpRegistryServerView[] };
  expect(Array.isArray(body.servers)).toBe(true);
  expect(body.servers).toEqual([]);
});

test('GET /api/mcp returns registry server list after start()', async () => {
  // Set up a registry with a pre-populated fake by using a stub registry.
  // We use setProcessMcpRegistry to inject a registry whose getServers()
  // returns a known snapshot without actually spawning subprocesses.
  const fakeView: McpRegistryServerView = {
    name: 'test-server',
    type: 'stdio',
    state: 'ready',
    toolCount: 2,
    tools: ['tool_a', 'tool_b'],
    serverInfo: null,
    error: null,
  };

  // Subclass MCPRegistry to override getServers without spawning anything.
  class StubRegistry extends MCPRegistry {
    override getServers(): McpRegistryServerView[] {
      return [fakeView];
    }
  }
  setProcessMcpRegistry(new StubRegistry());

  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/mcp');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { servers: McpRegistryServerView[] };
  expect(body.servers).toHaveLength(1);
  const srv = body.servers[0];
  expect(srv?.name).toBe('test-server');
  expect(srv?.state).toBe('ready');
  expect(srv?.toolCount).toBe(2);
  expect(srv?.tools).toEqual(['tool_a', 'tool_b']);
});

test('POST /api/mcp returns 405', async () => {
  const url = new URL('http://localhost/api/mcp');
  const h = createApiHandler(deps());
  const res = await h(new Request(url, { method: 'POST' }), url);
  expect(res?.status).toBe(405);
});

test('DELETE /api/mcp returns 405', async () => {
  const url = new URL('http://localhost/api/mcp');
  const h = createApiHandler(deps());
  const res = await h(new Request(url, { method: 'DELETE' }), url);
  expect(res?.status).toBe(405);
});
