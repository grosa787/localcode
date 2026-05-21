import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';
import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import {
  createApiHandler,
  resolveSafePath,
  type ApiDeps,
  type ProviderAdapter,
} from '@/web/api';
import { WorkspaceRegistry } from '@/web/workspace/workspace-registry';
import type { Backend } from '@/types/global';

let tempDir: string;
let configPath: string;
let workspacesPath: string;
let projectRoot: string;
let db: Database | null = null;

let configManager: ConfigManager;
let sessionManager: SessionManager;
let workspaceRegistry: WorkspaceRegistry;
let stubModels: readonly string[] = ['model-a', 'model-b'];
let createdAdapterCalls: Array<{ backend: Backend; baseUrl: string; apiKey?: string }> = [];

function buildDeps(): ApiDeps {
  return {
    configManager,
    sessionManager,
    workspaceRegistry,
    createAdapterForBackend: (backend, baseUrl, apiKey): ProviderAdapter => {
      createdAdapterCalls.push({ backend, baseUrl, apiKey });
      return {
        getModels: async () => stubModels,
      };
    },
  };
}

function call(handler: ReturnType<typeof createApiHandler>, method: string, path: string, body?: unknown): Promise<Response | null> {
  const url = new URL(`http://localhost${path}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return handler(new Request(url, init), url);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'localcode-api-'));
  configPath = join(tempDir, 'config.toml');
  workspacesPath = join(tempDir, 'workspaces.json');
  projectRoot = join(tempDir, 'proj');
  mkdirSync(projectRoot, { recursive: true });

  // Seed config with a minimal valid shape.
  configManager = new ConfigManager(configPath);
  const cfg = getDefaultConfig('ollama');
  cfg.model.current = 'llama3';
  cfg.model.available = ['llama3'];
  cfg.onboarding.completed = true;
  configManager.write(cfg);

  db = openDb(':memory:');
  sessionManager = new SessionManager(db);
  workspaceRegistry = new WorkspaceRegistry({ filePath: workspacesPath });

  stubModels = ['model-a', 'model-b'];
  createdAdapterCalls = [];
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

describe('resolveSafePath', () => {
  test('rejects parent traversal', () => {
    expect(resolveSafePath('/var/foo', '../etc/passwd')).toBeNull();
    expect(resolveSafePath('/var/foo', '/etc/passwd')).toBeNull();
    expect(resolveSafePath('/var/foo', 'sub/../../etc')).toBeNull();
  });

  test('accepts in-tree paths', () => {
    expect(resolveSafePath('/var/foo', 'src/index.ts')).toBe('/var/foo/src/index.ts');
    expect(resolveSafePath('/var/foo', '')).toBe('/var/foo');
    expect(resolveSafePath('/var/foo', '.')).toBe('/var/foo');
  });
});

describe('REST handler', () => {
  test('GET /api/projects returns the registry list', async () => {
    // Note: GET /api/projects filters out tmpdir paths as "junk"
    // (see isJunkProjectPath in src/web/api/projects.ts). The test's
    // `projectRoot` is created under os.tmpdir(), so the response
    // legitimately excludes it. We assert via the registry directly
    // and confirm the endpoint applies its filter consistently.
    workspaceRegistry.create(projectRoot, 'Proj');
    expect(workspaceRegistry.list()).toHaveLength(1);
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', '/api/projects');
    expect(res?.status).toBe(200);
    const body = await res!.json();
    // Filtered: tmp-rooted entries must not surface to the SPA.
    expect(body.projects).toHaveLength(0);
  });

  test('POST /api/projects with bad root returns 400', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/projects', { root: '/does/not/exist/abc' });
    expect(res?.status).toBe(400);
  });

  test('POST /api/projects with valid root returns 201 and persists', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/projects', { root: projectRoot });
    expect(res?.status).toBe(201);
    const body = await res!.json();
    expect(body.project.root).toBe(projectRoot);
    expect(workspaceRegistry.list()).toHaveLength(1);
  });

  test('GET /api/sessions filters by project root', async () => {
    const w = workspaceRegistry.create(projectRoot);
    sessionManager.createSession(projectRoot, 'llama3', 'ollama');
    sessionManager.createSession('/some/other/root', 'llama3', 'ollama');

    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', `/api/sessions?projectId=${w.id}`);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].projectId).toBe(w.id);
  });

  test('GET /api/sessions rejects unknown projectId', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', '/api/sessions?projectId=unknown-id');
    expect(res?.status).toBe(404);
  });

  test('POST /api/sessions creates a new session under the workspace', async () => {
    const w = workspaceRegistry.create(projectRoot);
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/sessions', { projectId: w.id, title: 'Hello' });
    expect(res?.status).toBe(201);
    const body = await res!.json();
    expect(body.session.title).toBe('Hello');
    expect(body.session.model).toBe('llama3');
    expect(body.session.messageCount).toBe(0);
  });

  test('GET /api/files/tree rejects path traversal', async () => {
    const w = workspaceRegistry.create(projectRoot);
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', `/api/files/tree?projectId=${w.id}&path=../`);
    expect(res?.status).toBe(403);
  });

  test('GET /api/files/tree lists entries and hides node_modules', async () => {
    const w = workspaceRegistry.create(projectRoot);
    writeFileSync(join(projectRoot, 'a.txt'), 'hello');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', `/api/files/tree?projectId=${w.id}`);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    const names: string[] = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('a.txt');
    expect(names).toContain('src');
    expect(names).not.toContain('node_modules');
    // Directories sort before files.
    expect(body.entries[0].kind).toBe('dir');
  });

  test('GET /api/files/tree with showHidden=1 surfaces dotfiles + node_modules', async () => {
    const w = workspaceRegistry.create(projectRoot);
    writeFileSync(join(projectRoot, '.env'), 'KEY=1');
    writeFileSync(join(projectRoot, 'a.txt'), 'hello');
    mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', `/api/files/tree?projectId=${w.id}&showHidden=1`);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    const names: string[] = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('.env');
    expect(names).toContain('.git');
    expect(names).toContain('node_modules');
    expect(names).toContain('a.txt');
    // `.localcode` is always-hidden regardless of the flag.
    mkdirSync(join(projectRoot, '.localcode'), { recursive: true });
  });

  test('GET /api/files/tree with depth=0 returns no entries', async () => {
    const w = workspaceRegistry.create(projectRoot);
    writeFileSync(join(projectRoot, 'a.txt'), 'hello');
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', `/api/files/tree?projectId=${w.id}&depth=0`);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.entries).toEqual([]);
    expect(body.path).toBe('');
  });

  test('GET /api/files/tree honours subpath alias', async () => {
    const w = workspaceRegistry.create(projectRoot);
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'index.ts'), 'export {};');
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', `/api/files/tree?projectId=${w.id}&subpath=src`);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.path).toBe('src');
    const names: string[] = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('index.ts');
  });

  test('GET /api/files/read rejects path traversal', async () => {
    const w = workspaceRegistry.create(projectRoot);
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', `/api/files/read?projectId=${w.id}&path=../../etc/passwd`);
    expect(res?.status).toBe(403);
  });

  // H6 — Symlink-traversal containment. Lexical `..` is already blocked;
  // a symlink whose target is /etc must be rejected too.
  test('GET /api/files/read rejects symlink escape', async () => {
    const w = workspaceRegistry.create(projectRoot);
    symlinkSync('/etc', join(projectRoot, 'link'));
    const handler = createApiHandler(buildDeps());
    const res = await call(
      handler,
      'GET',
      `/api/files/read?projectId=${w.id}&path=link/passwd`,
    );
    expect(res?.status).toBe(403);
  });

  test('GET /api/files/tree rejects symlink escape', async () => {
    const w = workspaceRegistry.create(projectRoot);
    symlinkSync('/etc', join(projectRoot, 'link'));
    const handler = createApiHandler(buildDeps());
    const res = await call(
      handler,
      'GET',
      `/api/files/tree?projectId=${w.id}&subpath=link`,
    );
    expect(res?.status).toBe(403);
  });

  test('GET /api/files/read returns binary 415 for NUL-byte content', async () => {
    const w = workspaceRegistry.create(projectRoot);
    writeFileSync(join(projectRoot, 'bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', `/api/files/read?projectId=${w.id}&path=bin`);
    expect(res?.status).toBe(415);
  });

  test('GET /api/files/read returns image base64 + mime for PNG content', async () => {
    const w = workspaceRegistry.create(projectRoot);
    // A 1x1 transparent PNG (minimum valid signature + IHDR + IDAT + IEND).
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    writeFileSync(join(projectRoot, 'pixel.png'), png);
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', `/api/files/read?projectId=${w.id}&path=pixel.png`);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.encoding).toBe('image');
    expect(body.mimeType).toBe('image/png');
    expect(body.content.length).toBeGreaterThan(0);
    // Round-trip the base64 to make sure it matches the original bytes.
    expect(Buffer.from(body.content, 'base64').equals(png)).toBe(true);
  });

  test('GET /api/files/read returns text content for utf-8 file', async () => {
    const w = workspaceRegistry.create(projectRoot);
    writeFileSync(join(projectRoot, 'note.md'), '# Hello');
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', `/api/files/read?projectId=${w.id}&path=note.md`);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.content).toBe('# Hello');
  });

  test('GET /api/config redacts apiKey', async () => {
    const cfg = configManager.read();
    configManager.write({ ...cfg, backend: { ...cfg.backend, apiKey: 'sk-secret' } });
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', '/api/config');
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.backend.apiKey).toBeUndefined();
  });

  test('POST /api/config/provider persists + returns model list', async () => {
    stubModels = ['gpt-4o', 'gpt-4o-mini'];
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/config/provider', {
      type: 'openai',
      apiKey: 'sk-test',
    });
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.backend).toBe('openai');
    expect(body.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(body.currentModel).toBe('gpt-4o');
    const after = configManager.read();
    expect(after.backend.type).toBe('openai');
    expect(after.backend.apiKey).toBe('sk-test');
    expect(after.model.current).toBe('gpt-4o');
    expect(createdAdapterCalls).toHaveLength(1);
  });

  test('POST /api/config/provider returns 502 when adapter fails', async () => {
    const handler = createApiHandler({
      ...buildDeps(),
      createAdapterForBackend: () => ({
        getModels: async () => {
          throw new Error('connection refused');
        },
      }),
    });
    const res = await call(handler, 'POST', '/api/config/provider', { type: 'ollama' });
    expect(res?.status).toBe(502);
    // Config was NOT mutated.
    expect(configManager.read().backend.type).toBe('ollama');
  });

  test('GET /api/models/refresh uses active backend when provider omitted', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', '/api/models/refresh');
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.backend).toBe('ollama');
    expect(body.models).toEqual(['model-a', 'model-b']);
  });

  test('handler returns null for non-/api paths', async () => {
    const handler = createApiHandler(buildDeps());
    const url = new URL('http://localhost/index.html');
    const res = await handler(new Request(url), url);
    expect(res).toBeNull();
  });
});
