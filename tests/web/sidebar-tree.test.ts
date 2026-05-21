/**
 * Backend tests for the project tree refactor:
 *   - DELETE /api/projects/:id cascades sessions for that project
 *   - The cascade is idempotent (no error when nothing to remove)
 *   - Other projects' sessions are untouched
 *   - DeleteProjectResponse carries `removedSessions`
 *
 * These tests drive `createApiHandler` directly with stub deps so they
 * stay deterministic and don't need a live Bun server.
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
import type { DeleteProjectResponse } from '@/web/protocol/rest-types';
import { WorkspaceRegistry } from '@/web/workspace/workspace-registry';
import type { Backend } from '@/types/global';

let tempDir: string;
let projectA: string;
let projectB: string;
let db: Database | null = null;
let configManager: ConfigManager;
let sessionManager: SessionManager;
let workspaceRegistry: WorkspaceRegistry;

function buildDeps(): ApiDeps {
  return {
    configManager,
    sessionManager,
    workspaceRegistry,
    createAdapterForBackend: (
      _backend: Backend,
      _baseUrl: string,
      _apiKey?: string,
    ): ProviderAdapter => ({ getModels: async () => [] as readonly string[] }),
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
  tempDir = mkdtempSync(join(tmpdir(), 'lc-sidebar-tree-'));
  projectA = join(tempDir, 'proj-a');
  projectB = join(tempDir, 'proj-b');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });

  configManager = new ConfigManager(join(tempDir, 'config.toml'));
  const cfg = getDefaultConfig('ollama');
  cfg.model.current = 'llama3';
  cfg.model.available = ['llama3'];
  cfg.onboarding.completed = true;
  configManager.write(cfg);

  db = openDb(':memory:');
  sessionManager = new SessionManager(db);
  workspaceRegistry = new WorkspaceRegistry({
    filePath: join(tempDir, 'workspaces.json'),
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

test('DELETE /api/projects/:id cascades sessions for that project only', async () => {
  const a = workspaceRegistry.create(projectA);
  const b = workspaceRegistry.create(projectB);
  // 3 sessions under A, 1 under B.
  sessionManager.createSession(a.root, 'm1', 'ollama');
  sessionManager.createSession(a.root, 'm1', 'ollama');
  sessionManager.createSession(a.root, 'm1', 'ollama');
  const keepSession = sessionManager.createSession(b.root, 'm1', 'ollama');

  const h = createApiHandler(buildDeps());
  const res = await call(h, 'DELETE', `/api/projects/${a.id}`);
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  const body = (await res!.json()) as DeleteProjectResponse;
  expect(body.ok).toBe(true);
  expect(body.removedSessions).toBe(3);

  // Workspace gone from registry.
  expect(workspaceRegistry.get(a.id)).toBeNull();
  // B is untouched and its session still readable.
  expect(workspaceRegistry.get(b.id)).not.toBeNull();
  expect(sessionManager.getSession(keepSession.id)).not.toBeNull();
});

test('DELETE /api/projects/:id with no sessions returns removedSessions=0', async () => {
  const a = workspaceRegistry.create(projectA);
  const h = createApiHandler(buildDeps());
  const res = await call(h, 'DELETE', `/api/projects/${a.id}`);
  expect(res!.status).toBe(200);
  const body = (await res!.json()) as DeleteProjectResponse;
  expect(body.removedSessions).toBe(0);
  expect(workspaceRegistry.get(a.id)).toBeNull();
});

test('DELETE /api/projects/:id for unknown id returns 404', async () => {
  const h = createApiHandler(buildDeps());
  const res = await call(h, 'DELETE', '/api/projects/does-not-exist');
  expect(res!.status).toBe(404);
});

test('SessionManager.deleteSessionsForProjectRoot is idempotent', () => {
  const s1 = sessionManager.createSession(projectA, 'm1', 'ollama');
  const removed = sessionManager.deleteSessionsForProjectRoot(projectA);
  expect(removed).toBe(1);
  // Second call with nothing left — no throw, returns 0.
  const removed2 = sessionManager.deleteSessionsForProjectRoot(projectA);
  expect(removed2).toBe(0);
  // Path that never existed.
  const removed3 = sessionManager.deleteSessionsForProjectRoot('/nope/none');
  expect(removed3).toBe(0);
  expect(sessionManager.getSession(s1.id)).toBeNull();
});

test('cascade does not touch sessions in other projects', () => {
  const sA = sessionManager.createSession(projectA, 'm1', 'ollama');
  const sB = sessionManager.createSession(projectB, 'm1', 'ollama');
  const removed = sessionManager.deleteSessionsForProjectRoot(projectA);
  expect(removed).toBe(1);
  expect(sessionManager.getSession(sA.id)).toBeNull();
  expect(sessionManager.getSession(sB.id)).not.toBeNull();
});
