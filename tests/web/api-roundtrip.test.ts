/**
 * REST round-trip — exercises `createApiHandler` directly with stub
 * deps. Faster + more focused than booting the full server. Complements
 * `tests/web/api.test.ts` (which covers individual handlers) by walking
 * through happy + edge cases end-to-end on the dispatcher itself.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

import {
  filterJunkProjects,
  isJunkProjectPath,
} from '@/web/api/projects';
import type { WorkspaceRecord } from '@/web/protocol/rest-types';

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
let adapterCalls: Array<{ backend: Backend; baseUrl: string; apiKey?: string }> = [];
let stubModels: readonly string[] = ['m1', 'm2'];

function deps(): ApiDeps {
  return {
    configManager,
    sessionManager,
    workspaceRegistry,
    createAdapterForBackend: (backend, baseUrl, apiKey): ProviderAdapter => {
      adapterCalls.push({ backend, baseUrl, apiKey });
      return { getModels: async () => stubModels };
    },
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
  tempDir = mkdtempSync(join(tmpdir(), 'lc-api-rt-'));
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
  workspaceRegistry = new WorkspaceRegistry({
    filePath: join(tempDir, 'ws.json'),
  });
  adapterCalls = [];
  stubModels = ['m1', 'm2'];
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

test('GET /api/projects with empty registry returns []', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/projects');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { projects: unknown[] };
  expect(body.projects).toEqual([]);
});

test('POST then DELETE /api/projects round-trips', async () => {
  const h = createApiHandler(deps());
  const create = await call(h, 'POST', '/api/projects', { root: projectRoot });
  expect(create?.status).toBe(201);
  const created = (await create!.json()) as { project: { id: string } };
  const id = created.project.id;
  expect(workspaceRegistry.list()).toHaveLength(1);

  const del = await call(h, 'DELETE', `/api/projects/${id}`);
  expect(del).not.toBeNull();
  expect([200, 204]).toContain(del!.status);
  expect(workspaceRegistry.list()).toHaveLength(0);
});

test('GET /api/sessions for a project starts empty', async () => {
  const w = workspaceRegistry.create(projectRoot);
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', `/api/sessions?projectId=${w.id}`);
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { sessions: unknown[] };
  expect(body.sessions).toEqual([]);
});

test('POST /api/sessions creates and GET returns it', async () => {
  const w = workspaceRegistry.create(projectRoot);
  const h = createApiHandler(deps());
  const create = await call(h, 'POST', '/api/sessions', {
    projectId: w.id,
    title: 'Round-trip',
  });
  expect(create?.status).toBe(201);

  const list = await call(h, 'GET', `/api/sessions?projectId=${w.id}`);
  const body = (await list!.json()) as { sessions: Array<{ title: string | null }> };
  expect(body.sessions).toHaveLength(1);
  expect(body.sessions[0]?.title).toBe('Round-trip');
});

test('GET /api/files/read returns text content', async () => {
  const w = workspaceRegistry.create(projectRoot);
  writeFileSync(join(projectRoot, 'hello.txt'), 'world');
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', `/api/files/read?projectId=${w.id}&path=hello.txt`);
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { content: string };
  expect(body.content).toBe('world');
});

test('GET /api/files/read on missing file returns 404', async () => {
  const w = workspaceRegistry.create(projectRoot);
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', `/api/files/read?projectId=${w.id}&path=missing.txt`);
  expect(res?.status).toBe(404);
});

test('GET /api/files/tree on empty project returns empty entries', async () => {
  const w = workspaceRegistry.create(projectRoot);
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', `/api/files/tree?projectId=${w.id}`);
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { entries: unknown[] };
  expect(body.entries).toEqual([]);
});

test('POST /api/config/provider invokes adapter factory once', async () => {
  stubModels = ['gpt-4o'];
  const h = createApiHandler(deps());
  const res = await call(h, 'POST', '/api/config/provider', {
    type: 'openai',
    apiKey: 'sk-x',
  });
  expect(res?.status).toBe(200);
  expect(adapterCalls).toHaveLength(1);
  expect(adapterCalls[0]?.backend).toBe('openai');
});

test('GET /api/config returns the persisted config without apiKey', async () => {
  const cur = configManager.read();
  configManager.write({ ...cur, backend: { ...cur.backend, apiKey: 'sk-secret' } });
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/config');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { backend: { apiKey?: string; type: string } };
  expect(body.backend.apiKey).toBeUndefined();
  expect(body.backend.type).toBe('ollama');
});

test('POST /api/config/generation persists generation params', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'POST', '/api/config/generation', {
    temperature: 0.42,
    topP: 0.9,
    repeatPenalty: 1.1,
    maxTokens: 4096,
  });
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as {
    ok: true;
    generation: {
      temperature: number;
      topP: number;
      repeatPenalty: number;
      maxTokens: number;
    };
  };
  expect(body.ok).toBe(true);
  expect(body.generation.temperature).toBeCloseTo(0.42);
  expect(body.generation.topP).toBeCloseTo(0.9);
  expect(body.generation.repeatPenalty).toBeCloseTo(1.1);
  expect(body.generation.maxTokens).toBe(4096);

  const persisted = configManager.read();
  expect(persisted.generation.temperature).toBeCloseTo(0.42);
  expect(persisted.generation.maxTokens).toBe(4096);
});

test('POST /api/config/generation rejects out-of-range values', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'POST', '/api/config/generation', {
    temperature: 5,
    topP: 0.5,
    repeatPenalty: 1,
    maxTokens: 1024,
  });
  expect(res?.status).toBe(400);
});

test('GET /api/commands returns built-in commands sorted by name', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/commands');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as {
    commands: Array<{ name: string; description: string; usage?: string }>;
  };
  expect(Array.isArray(body.commands)).toBe(true);
  const names = body.commands.map((c) => c.name);
  for (const expected of ['clear', 'model', 'permissions', 'provider']) {
    expect(names).toContain(expected);
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(sorted);
});

test('GET /api/skills returns an array (possibly empty)', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/skills');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { skills: unknown[] };
  expect(Array.isArray(body.skills)).toBe(true);
});

test('POST /api/skills/:id/toggle returns 404 for unknown id', async () => {
  const h = createApiHandler(deps());
  const res = await call(
    h,
    'POST',
    '/api/skills/__definitely_not_a_real_skill__/toggle',
    { active: true },
  );
  expect(res?.status).toBe(404);
});

test('GET /api/plugins returns plugins array', async () => {
  const h = createApiHandler(deps());
  const res = await call(h, 'GET', '/api/plugins');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { plugins: unknown[] };
  expect(Array.isArray(body.plugins)).toBe(true);
});

test('isJunkProjectPath flags tmp dirs, lc-web-it, worktrees, and missing paths', () => {
  // Pure predicate test — bypass real fs by injecting fsExists +
  // tmpRoot so we don't depend on the host filesystem layout.
  const tmpRoot = '/var/folders/x/y/T';
  // Pattern-only junk detection (existsSync removed — see projects.ts).
  // Non-existent paths are NO LONGER auto-junk; user triggers cleanup
  // explicitly via the Sidebar filter menu.
  expect(isJunkProjectPath('/var/folders/x/y/T/lc-web-it-foo', tmpRoot)).toBe(true);
  expect(isJunkProjectPath('/private/var/folders/x/y/T/junk', tmpRoot)).toBe(true);
  expect(isJunkProjectPath('/tmp/lc-web-it-uUAe5G', '/tmp')).toBe(true);
  expect(isJunkProjectPath('/Users/me/code/.git/worktrees/abc', tmpRoot)).toBe(true);
  expect(isJunkProjectPath('/Users/me/code/real-project', tmpRoot)).toBe(false);
  expect(isJunkProjectPath('', tmpRoot)).toBe(true);
});

test('filterJunkProjects drops only lc-web-it pattern; missing paths kept', () => {
  // Pattern-only junk detection (existsSync removed). Real-but-missing
  // paths are NOT auto-junk — user triggers explicit cleanup if they
  // want them gone.
  const lcWebIt: WorkspaceRecord = {
    id: 'b',
    root: '/Users/nobody/lc-web-it-extra-DqNOMB',
    label: 'lc-web-it',
    lastUsedAt: 2,
  };
  const missing: WorkspaceRecord = {
    id: 'c',
    root: '/Users/nobody/totally-missing-xyz-' + Math.random().toString(36).slice(2),
    label: 'gone',
    lastUsedAt: 3,
  };
  const out = filterJunkProjects([lcWebIt, missing]);
  // lc-web-it stripped; missing kept.
  expect(out.find((r) => r.id === 'b')).toBeUndefined();
  expect(out.find((r) => r.id === 'c')).toBeDefined();
});

test('POST /api/projects/cleanup removes only pattern-junk; missing paths kept', async () => {
  // Pattern-only cleanup. Real-but-missing paths are user's call to
  // remove via the same endpoint — but the predicate no longer
  // auto-classifies them. Tested here: lc-web-it removed, missing kept.
  const wsPath = join(tempDir, 'ws.json');
  const fs = await import('node:fs');
  const seed = {
    version: 1,
    workspaces: [
      {
        id: 'junk-1',
        root: '/Users/nobody/lc-web-it-aaa',
        label: 'a',
        lastUsedAt: 1,
      },
      {
        id: 'kept-1',
        root: '/Users/ghost/missing-' + Math.random().toString(36).slice(2),
        label: 'b',
        lastUsedAt: 2,
      },
    ],
  };
  fs.writeFileSync(wsPath, JSON.stringify(seed), 'utf-8');
  const { WorkspaceRegistry } = await import('@/web/workspace/workspace-registry');
  workspaceRegistry = new WorkspaceRegistry({ filePath: wsPath });

  const h = createApiHandler(deps());
  const res = await call(h, 'POST', '/api/projects/cleanup');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { removed: number };
  expect(body.removed).toBe(1);                          // only lc-web-it
  expect(workspaceRegistry.list()).toHaveLength(1);
  expect(workspaceRegistry.list()[0]?.id).toBe('kept-1');
});

test('POST /api/projects/cleanup on empty registry returns 0', async () => {
  // Sanity: empty registry → no rows removed, status still ok.
  const h = createApiHandler(deps());
  const res = await call(h, 'POST', '/api/projects/cleanup');
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { removed: number };
  expect(body.removed).toBe(0);
});

test('handler returns null for /not-an-api/foo', async () => {
  const h = createApiHandler(deps());
  const url = new URL('http://localhost/not-an-api/foo');
  const res = await h(new Request(url), url);
  expect(res).toBeNull();
});
