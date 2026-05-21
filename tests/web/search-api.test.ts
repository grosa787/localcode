/**
 * Tests for `GET /api/search`.
 *
 * Covers:
 *  - happy path: hits with snippets, projectId/label resolved
 *  - empty query returns 200 + empty result list
 *  - unknown projectId returns 404
 *  - projectId filter restricts hits
 *  - pagination (limit + offset)
 *  - method gating (POST → 405)
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
import { createApiHandler, type ApiDeps } from '@/web/api';
import { WorkspaceRegistry } from '@/web/workspace/workspace-registry';

let tempDir: string;
let configPath: string;
let workspacesPath: string;
let projectRootA: string;
let projectRootB: string;
let db: Database | null = null;

let configManager: ConfigManager;
let sessionManager: SessionManager;
let workspaceRegistry: WorkspaceRegistry;

function buildDeps(): ApiDeps {
  return {
    configManager,
    sessionManager,
    workspaceRegistry,
    createAdapterForBackend: () => ({
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
  tempDir = mkdtempSync(join(tmpdir(), 'localcode-search-api-'));
  configPath = join(tempDir, 'config.toml');
  workspacesPath = join(tempDir, 'workspaces.json');
  projectRootA = join(tempDir, 'proj-a');
  projectRootB = join(tempDir, 'proj-b');
  mkdirSync(projectRootA, { recursive: true });
  mkdirSync(projectRootB, { recursive: true });

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
    // ignore
  }
  db = null;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('GET /api/search', () => {
  test('returns FTS hits with snippets and resolved project labels', async () => {
    const wA = workspaceRegistry.create(projectRootA, 'Project A');
    const sessA = sessionManager.createSession(projectRootA, 'llama3', 'ollama');
    sessionManager.updateTitle(sessA.id, 'Alpha chat');
    sessionManager.addMessage(sessA.id, {
      id: 'msg-1',
      role: 'user',
      content: 'searching for needle in many haystacks',
      createdAt: 1000,
    });
    sessionManager.addMessage(sessA.id, {
      id: 'msg-2',
      role: 'assistant',
      content: 'the needle is over here',
      createdAt: 1001,
    });

    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', '/api/search?q=needle');
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.results).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.query).toBe('needle');
    for (const r of body.results) {
      expect(r.sessionId).toBe(sessA.id);
      expect(r.sessionTitle).toBe('Alpha chat');
      expect(r.projectId).toBe(wA.id);
      expect(r.projectLabel).toBe('Project A');
      expect(r.snippet).toContain('<mark>needle</mark>');
    }
  });

  test('empty query returns 200 with empty results', async () => {
    workspaceRegistry.create(projectRootA);
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', '/api/search?q=');
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
  });

  test('no-match query returns 200 with empty results', async () => {
    const wA = workspaceRegistry.create(projectRootA);
    const sA = sessionManager.createSession(projectRootA, 'llama3', 'ollama');
    sessionManager.addMessage(sA.id, {
      id: 'msg-1',
      role: 'user',
      content: 'apple banana',
      createdAt: 1000,
    });
    void wA;

    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', '/api/search?q=nonexistent_xyz');
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
  });

  test('unknown projectId returns 404', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(
      handler,
      'GET',
      '/api/search?q=anything&projectId=unknown-project',
    );
    expect(res?.status).toBe(404);
  });

  test('projectId filter restricts results to one workspace', async () => {
    const wA = workspaceRegistry.create(projectRootA, 'Project A');
    const wB = workspaceRegistry.create(projectRootB, 'Project B');
    const sA = sessionManager.createSession(projectRootA, 'llama3', 'ollama');
    const sB = sessionManager.createSession(projectRootB, 'llama3', 'ollama');
    sessionManager.addMessage(sA.id, {
      id: 'msg-a',
      role: 'user',
      content: 'shared_keyword from project A',
      createdAt: 1000,
    });
    sessionManager.addMessage(sB.id, {
      id: 'msg-b',
      role: 'user',
      content: 'shared_keyword from project B',
      createdAt: 1001,
    });

    const handler = createApiHandler(buildDeps());

    // Scoped to A:
    const resA = await call(
      handler,
      'GET',
      `/api/search?q=shared_keyword&projectId=${wA.id}`,
    );
    expect(resA?.status).toBe(200);
    const bodyA = await resA!.json();
    expect(bodyA.results).toHaveLength(1);
    expect(bodyA.results[0].projectId).toBe(wA.id);

    // Scoped to B:
    const resB = await call(
      handler,
      'GET',
      `/api/search?q=shared_keyword&projectId=${wB.id}`,
    );
    expect(resB?.status).toBe(200);
    const bodyB = await resB!.json();
    expect(bodyB.results).toHaveLength(1);
    expect(bodyB.results[0].projectId).toBe(wB.id);

    // Unscoped — both:
    const resBoth = await call(handler, 'GET', '/api/search?q=shared_keyword');
    expect(resBoth?.status).toBe(200);
    const bodyBoth = await resBoth!.json();
    expect(bodyBoth.results).toHaveLength(2);
  });

  test('limit + offset pagination', async () => {
    workspaceRegistry.create(projectRootA);
    const sA = sessionManager.createSession(projectRootA, 'llama3', 'ollama');
    for (let i = 0; i < 5; i += 1) {
      sessionManager.addMessage(sA.id, {
        id: `m-${i}`,
        role: 'user',
        content: `pagination_token entry ${i}`,
        createdAt: 1000 + i,
      });
    }

    const handler = createApiHandler(buildDeps());
    const r1 = await call(
      handler,
      'GET',
      '/api/search?q=pagination_token&limit=2&offset=0',
    );
    const r2 = await call(
      handler,
      'GET',
      '/api/search?q=pagination_token&limit=2&offset=2',
    );
    expect(r1?.status).toBe(200);
    expect(r2?.status).toBe(200);
    const b1 = await r1!.json();
    const b2 = await r2!.json();
    expect(b1.results).toHaveLength(2);
    expect(b2.results).toHaveLength(2);
    expect(b1.total).toBe(5);
    expect(b2.total).toBe(5);

    // Disjoint pages.
    const ids1 = new Set(b1.results.map((r: { messageId: string }) => r.messageId));
    for (const r of b2.results) {
      expect(ids1.has(r.messageId)).toBe(false);
    }
  });

  test('POST /api/search returns 405', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/search?q=anything');
    expect(res?.status).toBe(405);
  });

  test('result projectId is null when workspace removed', async () => {
    // Create the session against a project root that has no workspace
    // record. Simulates the user removing a project from the registry
    // while SQLite history persists.
    const sA = sessionManager.createSession(projectRootA, 'llama3', 'ollama');
    sessionManager.addMessage(sA.id, {
      id: 'msg-orphan',
      role: 'user',
      content: 'orphan_token marker',
      createdAt: 1000,
    });

    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', '/api/search?q=orphan_token');
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].projectId).toBeNull();
    expect(body.results[0].projectLabel).toBeNull();
  });
});
