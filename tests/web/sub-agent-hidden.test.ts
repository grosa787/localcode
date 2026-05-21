/**
 * Sub-agent session rows must be invisible to the user-facing sidebar.
 *
 * The orchestrator persists worker rows under a synthetic
 * `<parent>.agent.<agentId>` id (see `runner-factory.ts`) so post-mortem
 * inspection of worker history remains possible. AgentTeamPanel surfaces
 * those workers via `agent_*` WS frames, so they must never leak into:
 *
 *   GET /api/sessions?projectId=…
 *
 * Direct lookups (`getSession(id)`) MUST keep working — the deep-dive
 * UI relies on it. The `isSubAgentSessionId` helper is also covered for
 * various id shapes (including nested `.agent.` segments).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';
import { openDb } from '@/sessions/db';
import {
  isSubAgentSessionId,
  SessionManager,
} from '@/sessions/session-manager';
import {
  createApiHandler,
  type ApiDeps,
  type ProviderAdapter,
} from '@/web/api';
import type { ListSessionsResponse } from '@/web/protocol/rest-types';
import { WorkspaceRegistry } from '@/web/workspace/workspace-registry';
import type { Backend } from '@/types/global';

let tempDir: string;
let projectA: string;
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

function callJson<T>(
  handler: ReturnType<typeof createApiHandler>,
  method: string,
  path: string,
): Promise<T> {
  const url = new URL(`http://localhost${path}`);
  return handler(new Request(url, { method }), url).then(async (res) => {
    if (res === null) throw new Error('handler returned null');
    return (await res.json()) as T;
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lc-sub-agent-hidden-'));
  projectA = join(tempDir, 'proj-a');
  mkdirSync(projectA, { recursive: true });

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

test('GET /api/sessions hides sub-agent rows under the same project', async () => {
  const a = workspaceRegistry.create(projectA);

  // One real parent session + a sub-agent row persisted by the runner
  // under the synthetic `<parent>.agent.<short>` id.
  const parent = sessionManager.createSession(a.root, 'llama3', 'ollama');
  const childId = `${parent.id}.agent.AB123`;
  sessionManager.createSession(a.root, 'llama3', 'agent', { id: childId });

  const handler = createApiHandler(buildDeps());
  const body = await callJson<ListSessionsResponse>(
    handler,
    'GET',
    `/api/sessions?projectId=${a.id}`,
  );

  expect(body.sessions).toHaveLength(1);
  expect(body.sessions[0]?.id).toBe(parent.id);
  // And the sub-agent row is definitely absent.
  expect(body.sessions.some((s) => s.id === childId)).toBe(false);
});

test('GET /api/sessions hides nested sub-agent rows (multiple .agent. segments)', async () => {
  const a = workspaceRegistry.create(projectA);
  const parent = sessionManager.createSession(a.root, 'llama3', 'ollama');
  const child = `${parent.id}.agent.AB123`;
  const grandchild = `${child}.agent.CD456`;
  sessionManager.createSession(a.root, 'llama3', 'agent', { id: child });
  sessionManager.createSession(a.root, 'llama3', 'agent', { id: grandchild });

  const handler = createApiHandler(buildDeps());
  const body = await callJson<ListSessionsResponse>(
    handler,
    'GET',
    `/api/sessions?projectId=${a.id}`,
  );

  expect(body.sessions.map((s) => s.id)).toEqual([parent.id]);
});

test('SessionManager.getSession still resolves a sub-agent row by exact id', () => {
  const parent = sessionManager.createSession(projectA, 'llama3', 'ollama');
  const childId = `${parent.id}.agent.XYZ`;
  sessionManager.createSession(projectA, 'llama3', 'agent', { id: childId });

  // Direct lookup must keep working — AgentTeamPanel deep-dives rely on it.
  const direct = sessionManager.getSession(childId);
  expect(direct).not.toBeNull();
  expect(direct?.id).toBe(childId);
  expect(direct?.backend).toBe('agent');
});

test('isSubAgentSessionId classifies ids correctly', () => {
  // Real sub-agent ids — minted by orchestrator.
  expect(isSubAgentSessionId('uuid-here.agent.AB123')).toBe(true);
  expect(isSubAgentSessionId('parent.agent.X.agent.Y')).toBe(true); // nested
  expect(isSubAgentSessionId('.agent.X')).toBe(true);

  // Plain UUIDs and human session ids — never sub-agent.
  expect(isSubAgentSessionId('e8a1c2d4-7f93-4c1b-9a25-1234567890ab')).toBe(false);
  expect(isSubAgentSessionId('regular-session')).toBe(false);
  expect(isSubAgentSessionId('')).toBe(false);
  // Defensive: substring match must require the full `.agent.` token,
  // not just `agent` or `.agent`.
  expect(isSubAgentSessionId('my-agent-session')).toBe(false);
  expect(isSubAgentSessionId('foo.agent')).toBe(false);
});

test('createSession with explicit id round-trips, default mints a UUID', () => {
  const fixed = sessionManager.createSession(projectA, 'llama3', 'agent', {
    id: 'parent.agent.FIXED',
  });
  expect(fixed.id).toBe('parent.agent.FIXED');
  expect(sessionManager.getSession('parent.agent.FIXED')?.id).toBe(
    'parent.agent.FIXED',
  );

  const auto = sessionManager.createSession(projectA, 'llama3', 'ollama');
  // Default path mints a UUID — neither matches the sub-agent shape nor
  // collides with the explicit id we just inserted.
  expect(isSubAgentSessionId(auto.id)).toBe(false);
  expect(auto.id).not.toBe('parent.agent.FIXED');
});
