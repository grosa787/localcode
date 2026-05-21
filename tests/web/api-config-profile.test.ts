/**
 * REST round-trip for `POST /api/config/profile`.
 *
 * Boots `createApiHandler` with stub deps (same pattern as
 * `api-roundtrip.test.ts`) and verifies that:
 *   - 200 + the new profile is returned on success,
 *   - the persisted config reflects the change,
 *   - 405 on non-POST,
 *   - 400 on an invalid profile name.
 *
 * CSRF is applied by the outer middleware in real deployments; the
 * handler itself doesn't gate on the header (mirrors every other
 * handler in `src/web/api/*.ts`).
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
  tempDir = mkdtempSync(join(tmpdir(), 'lc-profile-'));
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

test('POST /api/config/profile switches profile and persists', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'POST', '/api/config/profile', {
    profile: 'plan',
  });
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { ok: true; profile: string };
  expect(body.ok).toBe(true);
  expect(body.profile).toBe('plan');

  // Persisted on disk.
  const persisted = configManager.read();
  expect(persisted.permissions.profile).toBe('plan');
});

test('POST /api/config/profile preserves autoApprove list', async () => {
  // Seed autoApprove with `write_file`.
  configManager.update({
    permissions: { autoApprove: ['write_file'], profile: 'default' },
  });
  const h = createApiHandler(deps());
  const res = await call(h, 'POST', '/api/config/profile', {
    profile: 'acceptEdits',
  });
  expect(res?.status).toBe(200);
  const persisted = configManager.read();
  expect(persisted.permissions.profile).toBe('acceptEdits');
  expect(persisted.permissions.autoApprove).toEqual(['write_file']);
});

test('POST /api/config/profile round-trips every documented profile', async () => {
  const h = createApiHandler(deps());
  const profiles = [
    'default',
    'acceptEdits',
    'plan',
    'dontAsk',
    'bypassPermissions',
  ] as const;
  for (const profile of profiles) {
    const res = await call(h, 'POST', '/api/config/profile', { profile });
    expect(res?.status).toBe(200);
    const persisted = configManager.read();
    expect(persisted.permissions.profile).toBe(profile);
  }
});

test('POST /api/config/profile rejects unknown profile (400)', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'POST', '/api/config/profile', {
    profile: 'allowAll',
  });
  expect(res?.status).toBe(400);
});

test('GET /api/config/profile not allowed (405)', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/config/profile');
  expect(res?.status).toBe(405);
});

test('GET /api/config exposes the persisted profile', async () => {
  configManager.update({
    permissions: { autoApprove: [], profile: 'dontAsk' },
  });
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/config');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as {
    permissions: { profile?: string };
  };
  expect(body.permissions.profile).toBe('dontAsk');
});
