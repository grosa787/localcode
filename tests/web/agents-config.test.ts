/**
 * Tests for `/api/config/agents` — GET snapshot, POST validation,
 * persistence round-trip.
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
  GetAgentsConfigResponse,
  SetAgentsConfigRequest,
  SetAgentsConfigResponse,
} from '@/web/protocol/rest-types';

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
    createAdapterForBackend: (
      _backend: Backend,
      _baseUrl: string,
      _apiKey: string | undefined,
    ): ProviderAdapter => ({
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
  tempDir = mkdtempSync(join(tmpdir(), 'localcode-agents-config-'));
  configPath = join(tempDir, 'config.toml');
  workspacesPath = join(tempDir, 'workspaces.json');
  mkdirSync(join(tempDir, 'proj'), { recursive: true });

  configManager = new ConfigManager(configPath);
  const cfg = getDefaultConfig('ollama');
  cfg.model.current = 'llama3';
  cfg.model.available = ['llama3', 'deepseek/deepseek-coder', 'gpt-4o'];
  cfg.onboarding.completed = true;
  cfg.backend.baseUrl = 'http://localhost:11434';
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

describe('GET /api/config/agents', () => {
  test('returns defaults when no agents block is persisted', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'GET', '/api/config/agents');
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as GetAgentsConfigResponse;
    expect(body.current.leadModel).toBeNull();
    expect(Array.isArray(body.current.workerSlots)).toBe(true);
    expect(body.current.isolation).toBe('worktree');
    expect(body.current.approval).toBe('auto');
    expect(body.availableModels).toContain('llama3');
    expect(body.availableModels).toContain('gpt-4o');
  });

  test('rejects unsupported methods with 405', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'PUT', '/api/config/agents', {});
    expect(res?.status).toBe(405);
  });
});

describe('POST /api/config/agents', () => {
  test('validates and round-trips a full snapshot', async () => {
    const handler = createApiHandler(buildDeps());
    const payload: SetAgentsConfigRequest = {
      leadModel: 'gpt-4o',
      workerSlots: [
        { model: 'deepseek/deepseek-coder', skills: ['typescript'] },
        { model: 'llama3', isolationOverride: 'shared', timeoutSec: 300 },
      ],
      isolation: 'worktree',
      maxConcurrent: 2,
      approval: 'per-action',
      defaultTimeoutSec: 900,
    };
    const res = await call(handler, 'POST', '/api/config/agents', payload);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as SetAgentsConfigResponse;
    expect(body.ok).toBe(true);
    expect(body.current.leadModel).toBe('gpt-4o');
    expect(body.current.workerSlots).toHaveLength(2);
    expect(body.current.workerSlots[0]?.model).toBe('deepseek/deepseek-coder');
    expect(body.current.workerSlots[0]?.skills).toEqual(['typescript']);
    expect(body.current.workerSlots[1]?.isolationOverride).toBe('shared');
    expect(body.current.workerSlots[1]?.timeoutSec).toBe(300);
    expect(body.current.maxConcurrent).toBe(2);
    expect(body.current.approval).toBe('per-action');

    // GET should now return the just-persisted snapshot.
    const getRes = await call(handler, 'GET', '/api/config/agents');
    const getBody = (await getRes!.json()) as GetAgentsConfigResponse;
    expect(getBody.current.leadModel).toBe('gpt-4o');
    expect(getBody.current.workerSlots).toHaveLength(2);
    expect(getBody.current.maxConcurrent).toBe(2);
  });

  test('clearing leadModel via null persists as "use active"', async () => {
    const handler = createApiHandler(buildDeps());
    // First persist a leadModel.
    await call(handler, 'POST', '/api/config/agents', {
      leadModel: 'gpt-4o',
      workerSlots: [],
      isolation: 'worktree',
      maxConcurrent: 1,
      approval: 'auto',
      defaultTimeoutSec: 600,
    } satisfies SetAgentsConfigRequest);

    // Now clear it.
    const res = await call(handler, 'POST', '/api/config/agents', {
      leadModel: null,
      workerSlots: [],
      isolation: 'worktree',
      maxConcurrent: 1,
      approval: 'auto',
      defaultTimeoutSec: 600,
    } satisfies SetAgentsConfigRequest);
    expect(res?.status).toBe(200);

    const getRes = await call(handler, 'GET', '/api/config/agents');
    const getBody = (await getRes!.json()) as GetAgentsConfigResponse;
    expect(getBody.current.leadModel).toBeNull();
  });

  test('rejects invalid body with 400', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, 'POST', '/api/config/agents', {
      // Missing required fields, plus bad enum value.
      leadModel: null,
      workerSlots: [{ model: '' }], // empty model rejected by schema
      isolation: 'invalid',
      maxConcurrent: 99,
      approval: 'auto',
      defaultTimeoutSec: 600,
    });
    expect(res?.status).toBe(400);
  });

  test('caps slot count at 8', async () => {
    const handler = createApiHandler(buildDeps());
    const slots = Array.from({ length: 9 }, () => ({ model: 'llama3' }));
    const res = await call(handler, 'POST', '/api/config/agents', {
      leadModel: null,
      workerSlots: slots,
      isolation: 'shared',
      maxConcurrent: 4,
      approval: 'auto',
      defaultTimeoutSec: 600,
    });
    expect(res?.status).toBe(400);
  });

  test('persists workerModel default from first slot for back-compat', async () => {
    const handler = createApiHandler(buildDeps());
    await call(handler, 'POST', '/api/config/agents', {
      leadModel: null,
      workerSlots: [{ model: 'deepseek/deepseek-coder' }],
      isolation: 'worktree',
      maxConcurrent: 3,
      approval: 'auto',
      defaultTimeoutSec: 600,
    } satisfies SetAgentsConfigRequest);
    // Read raw config — workerModel should be the first slot model.
    const cfg = configManager.read();
    expect(cfg.agents?.workerModel).toBe('deepseek/deepseek-coder');
  });
});
