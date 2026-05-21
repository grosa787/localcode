/**
 * Regression tests for the "+ New session" flow.
 *
 * Bug: when the user navigated into a non-default project (e.g. clicked
 * a session under `gemma4`) and pressed "+ New session", the freshly
 * created session was bound to the topmost project in `workspaces.json`
 * (e.g. `Documents`) rather than the project the user was viewing.
 *
 * Root cause was on the frontend — `setActiveSession` did not bump
 * `activeProjectId`, so `handleNewChat` always read the bootstrap
 * default. Backend already honored the `projectId` in the request body
 * but had no explicit test guarding against regressions.
 *
 * These tests cover the backend contract: every POST /api/sessions
 * resolves the workspace by the request `projectId`, never by registry
 * order. Frontend behaviour is exercised at the unit level via the
 * Zustand store's selectSession reducer (covered separately in
 * `web-frontend/src/__tests__/store.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
let configPath: string;
let workspacesPath: string;
let db: Database | null = null;

let configManager: ConfigManager;
let sessionManager: SessionManager;
let workspaceRegistry: WorkspaceRegistry;

function buildDeps(): ApiDeps {
  return {
    configManager,
    sessionManager,
    workspaceRegistry,
    createAdapterForBackend: (): ProviderAdapter => ({
      getModels: async () => ['llama3'],
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
  tempDir = mkdtempSync(join(tmpdir(), 'localcode-newsession-'));
  configPath = join(tempDir, 'config.toml');
  workspacesPath = join(tempDir, 'workspaces.json');

  configManager = new ConfigManager(configPath);
  const cfg = getDefaultConfig('ollama');
  cfg.model.current = 'llama3';
  cfg.model.available = ['llama3'];
  cfg.onboarding.completed = true;
  configManager.write(cfg);

  db = openDb(':memory:');
  sessionManager = new SessionManager(db);
  workspaceRegistry = new WorkspaceRegistry({ filePath: workspacesPath });
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

describe('POST /api/sessions — projectId honored', () => {
  test('creates session under the requested project, not the first in registry', async () => {
    // Seed two workspaces. `documents` is registered first (oldest
    // `lastUsedAt`), simulating the bug scenario where the topmost
    // entry in `workspaces.json` would otherwise win.
    const documentsRoot = join(tempDir, 'documents');
    const gemmaRoot = join(tempDir, 'gemma4');
    mkdirSync(documentsRoot, { recursive: true });
    mkdirSync(gemmaRoot, { recursive: true });
    const documents = workspaceRegistry.create(documentsRoot, 'Documents');
    const gemma = workspaceRegistry.create(gemmaRoot, 'gemma4');

    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/sessions', {
      projectId: gemma.id,
    });
    expect(res?.status).toBe(201);
    const body = await res!.json();
    expect(body.session.projectId).toBe(gemma.id);
    expect(body.session.projectId).not.toBe(documents.id);

    // The underlying SessionManager row must point at the gemma root
    // — the GET-by-projectId filter relies on `projectRoot` matching.
    const stored = sessionManager.getSession(body.session.id);
    expect(stored).not.toBeNull();
    expect(stored?.projectRoot).toBe(gemmaRoot);
  });

  test('lists the created session only under the requested project', async () => {
    const documentsRoot = join(tempDir, 'documents');
    const gemmaRoot = join(tempDir, 'gemma4');
    mkdirSync(documentsRoot, { recursive: true });
    mkdirSync(gemmaRoot, { recursive: true });
    const documents = workspaceRegistry.create(documentsRoot, 'Documents');
    const gemma = workspaceRegistry.create(gemmaRoot, 'gemma4');

    const handler = createApiHandler(buildDeps());
    const created = await call(handler, 'POST', '/api/sessions', {
      projectId: gemma.id,
      title: 'gemma chat',
    });
    expect(created?.status).toBe(201);

    const docsList = await call(
      handler,
      'GET',
      `/api/sessions?projectId=${documents.id}`,
    );
    const docsBody = await docsList!.json();
    expect(docsBody.sessions).toHaveLength(0);

    const gemmaList = await call(
      handler,
      'GET',
      `/api/sessions?projectId=${gemma.id}`,
    );
    const gemmaBody = await gemmaList!.json();
    expect(gemmaBody.sessions).toHaveLength(1);
    expect(gemmaBody.sessions[0].title).toBe('gemma chat');
  });

  test('rejects POST when projectId references unknown workspace', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/sessions', {
      projectId: 'no-such-id',
    });
    expect(res?.status).toBe(404);
  });

  test('honors projectId across three workspaces — middle one selected', async () => {
    // Defends against an off-by-one: pick the middle workspace, which
    // would never be "first" or "last" in any naive sort.
    const aRoot = join(tempDir, 'alpha');
    const bRoot = join(tempDir, 'bravo');
    const cRoot = join(tempDir, 'charlie');
    mkdirSync(aRoot, { recursive: true });
    mkdirSync(bRoot, { recursive: true });
    mkdirSync(cRoot, { recursive: true });
    const a = workspaceRegistry.create(aRoot, 'alpha');
    const b = workspaceRegistry.create(bRoot, 'bravo');
    const c = workspaceRegistry.create(cRoot, 'charlie');

    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/sessions', {
      projectId: b.id,
    });
    expect(res?.status).toBe(201);
    const body = await res!.json();
    expect(body.session.projectId).toBe(b.id);
    expect(body.session.projectId).not.toBe(a.id);
    expect(body.session.projectId).not.toBe(c.id);

    const stored = sessionManager.getSession(body.session.id);
    expect(stored?.projectRoot).toBe(bRoot);
  });
});
