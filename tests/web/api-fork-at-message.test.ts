/**
 * Tests for the fork-at-message REST endpoint.
 *
 * The endpoint forks a session at a specific assistant message,
 * replacing its content with `editedContent`. Pre-target messages are
 * copied into the new branch; the target row + every subsequent row
 * are dropped. The new branch lives under the same project and shares
 * the parent's model + backend.
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
import type { Message } from '@/types/global';

let tempDir: string;
let projectRoot: string;
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

function seedConversation(sessionId: string): {
  user1Id: string;
  asst1Id: string;
  user2Id: string;
  asst2Id: string;
} {
  // Use a synthetic clock so the messages get strictly increasing
  // created_at — required for the SQL prefix-copy ordering in
  // forkAtMessage. Bun's high-res clock can collide on tight inserts.
  const t = Date.now();
  const user1: Message = {
    id: 'u1',
    role: 'user',
    content: 'Hello',
    createdAt: t,
  };
  const asst1: Message = {
    id: 'a1',
    role: 'assistant',
    content: 'First reply',
    createdAt: t + 1,
  };
  const user2: Message = {
    id: 'u2',
    role: 'user',
    content: 'Tell me more',
    createdAt: t + 2,
  };
  const asst2: Message = {
    id: 'a2',
    role: 'assistant',
    content: 'Second reply with details',
    createdAt: t + 3,
  };
  sessionManager.addMessage(sessionId, user1);
  sessionManager.addMessage(sessionId, asst1);
  sessionManager.addMessage(sessionId, user2);
  sessionManager.addMessage(sessionId, asst2);
  return { user1Id: 'u1', asst1Id: 'a1', user2Id: 'u2', asst2Id: 'a2' };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'localcode-fork-'));
  projectRoot = join(tempDir, 'proj');
  mkdirSync(projectRoot, { recursive: true });

  configManager = new ConfigManager(join(tempDir, 'config.toml'));
  const cfg = getDefaultConfig('ollama');
  cfg.model.current = 'llama3';
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
    // ignore
  }
  db = null;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('POST /api/sessions/:id/fork-at-message', () => {
  test('forks at the last assistant message replacing content', async () => {
    const w = workspaceRegistry.create(projectRoot);
    const parent = sessionManager.createSession(projectRoot, 'llama3', 'ollama');
    const { asst2Id } = seedConversation(parent.id);

    const handler = createApiHandler(buildDeps());
    const res = await call(
      handler,
      'POST',
      `/api/sessions/${parent.id}/fork-at-message`,
      { messageId: asst2Id, editedContent: 'EDITED reply text' },
    );
    expect(res?.status).toBe(201);
    const body = await res!.json();
    expect(body.session.id).not.toBe(parent.id);
    expect(body.session.projectId).toBe(w.id);
    expect(body.session.model).toBe('llama3');
    expect(typeof body.editedMessageId).toBe('string');

    // Branch has the three earlier messages + the edited replacement.
    const branchMessages = sessionManager.getAllMessages(body.session.id);
    expect(branchMessages).toHaveLength(4);
    expect(branchMessages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(branchMessages[branchMessages.length - 1]?.content).toBe(
      'EDITED reply text',
    );
    // Parent untouched.
    const parentMessages = sessionManager.getAllMessages(parent.id);
    expect(parentMessages).toHaveLength(4);
    expect(parentMessages[3]?.content).toBe('Second reply with details');
  });

  test('forks at an earlier assistant message and drops later messages', async () => {
    workspaceRegistry.create(projectRoot);
    const parent = sessionManager.createSession(projectRoot, 'llama3', 'ollama');
    const { asst1Id } = seedConversation(parent.id);

    const handler = createApiHandler(buildDeps());
    const res = await call(
      handler,
      'POST',
      `/api/sessions/${parent.id}/fork-at-message`,
      { messageId: asst1Id, editedContent: 'rewritten first answer' },
    );
    expect(res?.status).toBe(201);
    const body = await res!.json();

    const branchMessages = sessionManager.getAllMessages(body.session.id);
    // Only [user1, edited-assistant1]. The user2 + assistant2 from the
    // parent are intentionally NOT copied.
    expect(branchMessages).toHaveLength(2);
    expect(branchMessages[0]?.content).toBe('Hello');
    expect(branchMessages[1]?.content).toBe('rewritten first answer');
    expect(branchMessages[1]?.role).toBe('assistant');
  });

  test('rejects forking at a non-assistant message', async () => {
    workspaceRegistry.create(projectRoot);
    const parent = sessionManager.createSession(projectRoot, 'llama3', 'ollama');
    const { user1Id } = seedConversation(parent.id);

    const handler = createApiHandler(buildDeps());
    const res = await call(
      handler,
      'POST',
      `/api/sessions/${parent.id}/fork-at-message`,
      { messageId: user1Id, editedContent: 'should not work' },
    );
    expect(res?.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe('fork_failed');
  });

  test('returns 404 for unknown session', async () => {
    workspaceRegistry.create(projectRoot);
    const handler = createApiHandler(buildDeps());
    const res = await call(
      handler,
      'POST',
      `/api/sessions/missing-id/fork-at-message`,
      { messageId: 'whatever', editedContent: 'x' },
    );
    expect(res?.status).toBe(404);
  });

  test('returns 400 for unknown messageId', async () => {
    workspaceRegistry.create(projectRoot);
    const parent = sessionManager.createSession(projectRoot, 'llama3', 'ollama');
    seedConversation(parent.id);

    const handler = createApiHandler(buildDeps());
    const res = await call(
      handler,
      'POST',
      `/api/sessions/${parent.id}/fork-at-message`,
      { messageId: 'does-not-exist', editedContent: 'x' },
    );
    expect(res?.status).toBe(400);
  });

  test('rejects missing fields with 400', async () => {
    workspaceRegistry.create(projectRoot);
    const parent = sessionManager.createSession(projectRoot, 'llama3', 'ollama');
    const handler = createApiHandler(buildDeps());
    const res = await call(
      handler,
      'POST',
      `/api/sessions/${parent.id}/fork-at-message`,
      { messageId: '' },
    );
    expect(res?.status).toBe(400);
  });
});
