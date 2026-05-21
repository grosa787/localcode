/**
 * Tests for the BackendServer editor wire surface:
 *   - GET  /api/config/providers — returns active backend + per-type
 *     entries (active row reflects persisted, others fall back to
 *     defaults).
 *   - POST /api/config/provider  — accepts baseUrl + apiKey +
 *     customHeaders, validates URL shape, trims keys, persists.
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
import type {
  ListProvidersConfigResponse,
  SetProviderResponse,
} from '@/web/protocol/rest-types';

let tempDir: string;
let configPath: string;
let workspacesPath: string;
let db: Database | null = null;

let configManager: ConfigManager;
let sessionManager: SessionManager;
let workspaceRegistry: WorkspaceRegistry;
let stubModels: readonly string[] = ['m1', 'm2', 'm3'];
let createdAdapterCalls: Array<{ backend: Backend; baseUrl: string; apiKey?: string }> = [];

function buildDeps(): ApiDeps {
  return {
    configManager,
    sessionManager,
    workspaceRegistry,
    createAdapterForBackend: (backend, baseUrl, apiKey): ProviderAdapter => {
      createdAdapterCalls.push({ backend, baseUrl, apiKey });
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
  tempDir = mkdtempSync(join(tmpdir(), 'localcode-backend-server-'));
  configPath = join(tempDir, 'config.toml');
  workspacesPath = join(tempDir, 'workspaces.json');
  mkdirSync(join(tempDir, 'proj'), { recursive: true });

  configManager = new ConfigManager(configPath);
  const cfg = getDefaultConfig('ollama');
  cfg.model.current = 'llama3';
  cfg.model.available = ['llama3'];
  cfg.onboarding.completed = true;
  cfg.backend.baseUrl = 'http://localhost:11434';
  configManager.write(cfg);

  db = openDb(':memory:');
  sessionManager = new SessionManager(db);
  workspaceRegistry = new WorkspaceRegistry({ filePath: workspacesPath });

  stubModels = ['m1', 'm2', 'm3'];
  createdAdapterCalls = [];
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

describe('GET /api/config/providers', () => {
  test('returns current + per-type defaults', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', '/api/config/providers');
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as ListProvidersConfigResponse;
    expect(body.current).toBe('ollama');
    expect(body.byType.ollama.baseUrl).toBe('http://localhost:11434');
    // Audit M4 — server returns presence flag, never the literal key.
    expect(body.byType.ollama.hasApiKey).toBe(false);
    // Non-active providers fall back to default base URL with no key.
    expect(body.byType.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(body.byType.openai.hasApiKey).toBe(false);
    expect(body.byType.lmstudio.baseUrl).toBe('http://localhost:1234/v1');
    // All seven types present.
    const keys: Backend[] = [
      'ollama',
      'lmstudio',
      'openai',
      'anthropic',
      'openrouter',
      'google',
      'custom',
    ];
    for (const k of keys) {
      expect(body.byType[k]).toBeDefined();
    }
  });

  test('reflects persisted apiKey presence for active provider after setProvider', async () => {
    const handler = createApiHandler(buildDeps());
    const setRes = await call(handler, 'POST', '/api/config/provider', {
      type: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test-key-1234',
    });
    expect(setRes?.status).toBe(200);
    const setBody = (await setRes!.json()) as SetProviderResponse;
    expect(setBody.backend).toBe('openrouter');

    const getRes = await call(handler, 'GET', '/api/config/providers');
    const body = (await getRes!.json()) as ListProvidersConfigResponse;
    expect(body.current).toBe('openrouter');
    // Audit M4 — only `hasApiKey: true` is returned, never the literal.
    expect(body.byType.openrouter.hasApiKey).toBe(true);
    // The literal key MUST NOT appear anywhere in the JSON response.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('sk-or-test-key-1234');
    // Inactive ollama row reports no key.
    expect(body.byType.ollama.hasApiKey).toBe(false);
  });

  test('rejects non-GET', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/config/providers');
    expect(res?.status).toBe(405);
  });
});

describe('POST /api/config/provider validation', () => {
  test('rejects invalid baseUrl', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/config/provider', {
      type: 'openai',
      baseUrl: 'not a url at all',
      apiKey: 'sk-xxx',
    });
    expect(res?.status).toBe(400);
  });

  test('trims surrounding whitespace from apiKey', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/config/provider', {
      type: 'openai',
      apiKey: '   sk-trimmed-123   ',
    });
    expect(res?.status).toBe(200);
    expect(createdAdapterCalls.length).toBe(1);
    expect(createdAdapterCalls[0]?.apiKey).toBe('sk-trimmed-123');

    const getRes = await call(handler, 'GET', '/api/config/providers');
    const body = (await getRes!.json()) as ListProvidersConfigResponse;
    // Audit M4 — server only confirms presence; the trimmed key was
    // already verified to round-trip into the adapter call above.
    expect(body.byType.openai.hasApiKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-trimmed-123');
  });

  test('persists customHeaders', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/config/provider', {
      type: 'openrouter',
      apiKey: 'sk-or-x',
      customHeaders: {
        'HTTP-Referer': 'https://localcode.dev',
        'X-Title': 'LocalCode',
      },
    });
    expect(res?.status).toBe(200);
    const getRes = await call(handler, 'GET', '/api/config/providers');
    const body = (await getRes!.json()) as ListProvidersConfigResponse;
    expect(body.byType.openrouter.customHeaders).toEqual({
      'HTTP-Referer': 'https://localcode.dev',
      'X-Title': 'LocalCode',
    });
  });
});
