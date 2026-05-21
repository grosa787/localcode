/**
 * REST roundtrips for /api/memory.
 *
 * Tests: GET, POST, DELETE — happy paths and error cases.
 * CSRF note: the API handler layer does NOT enforce CSRF tokens (that is
 * done by the server's HTTP middleware layer which we bypass here).
 * These tests exercise the handler logic directly via createApiHandler.
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
import type { Backend } from '@/types/global';

let tempDir: string;
let projectRoot: string;
let db: Database | null = null;
let configManager: ConfigManager;
let sessionManager: SessionManager;
let workspaceRegistry: WorkspaceRegistry;
let projectId: string;

function makeDeps(): ApiDeps {
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

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'lc-api-mem-'));
  projectRoot = join(tempDir, 'proj');
  mkdirSync(projectRoot, { recursive: true });

  configManager = new ConfigManager(join(tempDir, 'config.toml'));
  const cfg = getDefaultConfig('ollama');
  cfg.model.current = 'llama3';
  cfg.model.available = ['llama3'];
  cfg.onboarding.completed = true;
  configManager.write(cfg);

  db = openDb(':memory:');
  sessionManager = new SessionManager(db);
  workspaceRegistry = new WorkspaceRegistry({ filePath: join(tempDir, 'workspaces.json') });

  // Register a project so we have a valid projectId
  const project = workspaceRegistry.create(projectRoot);
  projectId = project.id;
});

afterEach(() => {
  db?.close();
  db = null;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('GET /api/memory', () => {
  test('returns empty entries when no memory exists', async () => {
    const handler = createApiHandler(makeDeps());
    const res = await call(handler, 'GET', `/api/memory?projectId=${projectId}`);
    expect(res?.status).toBe(200);
    const body = await res?.json() as { entries: unknown[]; index: string };
    expect(body.entries).toEqual([]);
    expect(body.index).toContain('no entries');
  });

  test('returns 400 when projectId is missing', async () => {
    const handler = createApiHandler(makeDeps());
    const res = await call(handler, 'GET', '/api/memory');
    expect(res?.status).toBe(400);
  });

  test('returns 400 when projectId is unknown', async () => {
    const handler = createApiHandler(makeDeps());
    const res = await call(handler, 'GET', '/api/memory?projectId=nonexistent-id');
    expect(res?.status).toBe(400);
  });
});

describe('POST /api/memory', () => {
  test('creates a new memory entry', async () => {
    const handler = createApiHandler(makeDeps());
    const res = await call(handler, 'POST', `/api/memory?projectId=${projectId}`, {
      name: 'test-entry',
      description: 'A test entry',
      type: 'project',
      body: 'This project uses bun.',
    });
    expect(res?.status).toBe(201);
    const body = await res?.json() as { entry: { name: string; type: string } };
    expect(body.entry.name).toBe('test-entry');
    expect(body.entry.type).toBe('project');
  });

  test('created entry appears in subsequent GET', async () => {
    const handler = createApiHandler(makeDeps());
    await call(handler, 'POST', `/api/memory?projectId=${projectId}`, {
      name: 'retrieve-test',
      description: 'Should appear in list',
      type: 'user',
      body: 'user prefers dark theme',
    });
    const res = await call(handler, 'GET', `/api/memory?projectId=${projectId}`);
    const body = await res?.json() as { entries: Array<{ name: string }> };
    expect(body.entries.some((e) => e.name === 'retrieve-test')).toBe(true);
  });

  test('returns 400 for invalid type', async () => {
    const handler = createApiHandler(makeDeps());
    const res = await call(handler, 'POST', `/api/memory?projectId=${projectId}`, {
      name: 'bad-type',
      description: 'desc',
      type: 'invalid-type',
      body: 'body',
    });
    expect(res?.status).toBe(400);
  });

  test('returns 400 for invalid name slug', async () => {
    const handler = createApiHandler(makeDeps());
    const res = await call(handler, 'POST', `/api/memory?projectId=${projectId}`, {
      name: 'UPPERCASE',
      description: 'desc',
      type: 'project',
      body: 'body',
    });
    expect(res?.status).toBe(400);
  });

  test('returns 400 when projectId is missing', async () => {
    const handler = createApiHandler(makeDeps());
    const res = await call(handler, 'POST', '/api/memory', {
      name: 'no-project',
      description: 'desc',
      type: 'project',
      body: 'body',
    });
    expect(res?.status).toBe(400);
  });
});

describe('DELETE /api/memory/:name', () => {
  test('deletes an existing entry', async () => {
    const handler = createApiHandler(makeDeps());
    // Create first
    await call(handler, 'POST', `/api/memory?projectId=${projectId}`, {
      name: 'to-delete',
      description: 'Will be deleted',
      type: 'feedback',
      body: 'delete me',
    });
    // Delete
    const delRes = await call(handler, 'DELETE', `/api/memory/to-delete?projectId=${projectId}`);
    expect(delRes?.status).toBe(200);
    const body = await delRes?.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    // Verify gone
    const listRes = await call(handler, 'GET', `/api/memory?projectId=${projectId}`);
    const listBody = await listRes?.json() as { entries: Array<{ name: string }> };
    expect(listBody.entries.some((e) => e.name === 'to-delete')).toBe(false);
  });

  test('succeeds silently when entry does not exist', async () => {
    const handler = createApiHandler(makeDeps());
    const res = await call(handler, 'DELETE', `/api/memory/nonexistent?projectId=${projectId}`);
    expect(res?.status).toBe(200);
  });

  test('returns 400 when projectId is missing', async () => {
    const handler = createApiHandler(makeDeps());
    const res = await call(handler, 'DELETE', '/api/memory/something');
    expect(res?.status).toBe(400);
  });

  test('returns 405 for non-DELETE method on named route', async () => {
    const handler = createApiHandler(makeDeps());
    const res = await call(handler, 'PUT', `/api/memory/some-name?projectId=${projectId}`);
    expect(res?.status).toBe(405);
  });
});
