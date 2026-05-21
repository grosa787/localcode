/**
 * REST round-trip for `POST /api/config/output-style`.
 *
 * Mirrors `tests/web/api-config-profile.test.ts`. Verifies:
 *   - 200 + the new style is returned on success,
 *   - the persisted config reflects the change,
 *   - 405 on non-POST,
 *   - 400 on an invalid style name,
 *   - GET /api/config surfaces the persisted outputStyle.
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
    createAdapterForBackend: (): ProviderAdapter => ({
      getModels: async () => ['m1'],
    }),
  };
}

function call(
  handler: ReturnType<typeof createApiHandler>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | null> {
  const url = new URL(`http://localhost${path}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return handler(new Request(url, init), url);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lc-style-'));
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
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('POST /api/config/output-style switches style and persists', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'POST', '/api/config/output-style', {
    outputStyle: 'verbose',
  });
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { ok: true; outputStyle: string };
  expect(body.ok).toBe(true);
  expect(body.outputStyle).toBe('verbose');

  const persisted = configManager.read();
  expect(persisted.outputStyle).toBe('verbose');
});

test('POST /api/config/output-style round-trips every documented style', async () => {
  const h = createApiHandler(deps());
  for (const style of ['concise', 'explanatory', 'verbose'] as const) {
    const res = await call(h, 'POST', '/api/config/output-style', {
      outputStyle: style,
    });
    expect(res?.status).toBe(200);
    const persisted = configManager.read();
    expect(persisted.outputStyle).toBe(style);
  }
});

test('POST /api/config/output-style rejects unknown style (400)', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'POST', '/api/config/output-style', {
    outputStyle: 'chatty',
  });
  expect(res?.status).toBe(400);
});

test('GET /api/config/output-style not allowed (405)', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/config/output-style');
  expect(res?.status).toBe(405);
});

test('GET /api/config exposes the persisted outputStyle', async () => {
  configManager.update({ outputStyle: 'explanatory' });
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/config');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { outputStyle?: string };
  expect(body.outputStyle).toBe('explanatory');
});
