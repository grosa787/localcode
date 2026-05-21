/**
 * Tests for the usage telemetry pipeline:
 *   - `src/llm/pricing.ts` — table lookup + cost math.
 *   - `SessionManager.getUsageStats` — SQL aggregation, per-model + per-day
 *     bucketing, project filter, top-sessions sort.
 *   - `GET /api/usage` — REST envelope, validation, empty period handling.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';
import {
  computeCost,
  PRICING,
  resolvePricing,
} from '@/llm/pricing';
import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import {
  createApiHandler,
  type ApiDeps,
  type ProviderAdapter,
} from '@/web/api';
import { WorkspaceRegistry } from '@/web/workspace/workspace-registry';
import type { Backend, Message } from '@/types/global';

// ============================================================
// pricing.ts
// ============================================================

describe('resolvePricing', () => {
  test('exact match on canonical id', () => {
    const p = resolvePricing('anthropic/claude-3.5-sonnet');
    expect(p).not.toBeNull();
    expect(p?.inputPer1M).toBe(3.0);
    expect(p?.outputPer1M).toBe(15.0);
  });

  test('basename match for vendor-native ids', () => {
    // "claude-3-5-sonnet" lacks the "anthropic/" prefix but should still resolve.
    const p = resolvePricing('claude-3-5-sonnet');
    expect(p).not.toBeNull();
    expect(p?.inputPer1M).toBe(3.0);
  });

  test('longest-prefix match with variant suffix', () => {
    // The dated revision suffix isn't pre-registered; prefix match wins.
    const p = resolvePricing('openai/gpt-4o-2024-08-06');
    expect(p).not.toBeNull();
    expect(p?.inputPer1M).toBe(2.5);
  });

  test('unknown models return null', () => {
    expect(resolvePricing('local/qwen-fancy')).toBeNull();
    expect(resolvePricing('ollama/llama3')).toBeNull();
    expect(resolvePricing('')).toBeNull();
  });
});

describe('computeCost', () => {
  test('cloud model: in + out math', () => {
    // gpt-4o-mini: 0.15 input / 0.6 output per 1M.
    // 100k in + 50k out = 100_000 * 0.15/1e6 + 50_000 * 0.6/1e6
    //                   = 0.015 + 0.03 = 0.045
    const cost = computeCost('openai/gpt-4o-mini', 100_000, 50_000);
    expect(cost).toBeCloseTo(0.045, 5);
  });

  test('cached tokens billed at cached rate', () => {
    // gpt-4o: input 2.5, cached 1.25, output 10.0 per 1M.
    // 1000 in (200 cached) + 0 out → 800 * 2.5/1e6 + 200 * 1.25/1e6
    //                                = 0.002 + 0.00025 = 0.00225
    const cost = computeCost('openai/gpt-4o', 1000, 0, 200);
    expect(cost).toBeCloseTo(0.00225, 6);
  });

  test('cached fallback to input rate when cached rate absent', () => {
    // Ensure we test a model w/o cachedInputPer1M
    const p = PRICING['anthropic/claude-3-opus'];
    expect(p).toBeDefined();
    // Add a sentinel without cached price
    PRICING['__test_no_cache__'] = { inputPer1M: 1.0, outputPer1M: 2.0 };
    try {
      // 1000 in (all cached) → at input rate fallback = 1000 * 1/1e6 = 0.001
      const cost = computeCost('__test_no_cache__', 1000, 0, 1000);
      expect(cost).toBeCloseTo(0.001, 6);
    } finally {
      delete PRICING['__test_no_cache__'];
    }
  });

  test('unknown model returns 0', () => {
    expect(computeCost('ollama/llama3', 1_000_000, 1_000_000)).toBe(0);
  });

  test('non-positive tokens clamp to 0', () => {
    expect(computeCost('openai/gpt-4o', -100, -50)).toBe(0);
    expect(computeCost('openai/gpt-4o', 0, 0)).toBe(0);
    expect(computeCost('openai/gpt-4o', Number.NaN, 100)).toBeCloseTo(
      (100 * 10.0) / 1_000_000,
      8,
    );
  });

  test('cachedIn caps at tokensIn (defensive)', () => {
    // If a caller passes cachedIn > tokensIn, we don't go negative on fresh.
    // gpt-4o: 200 in, 500 cached should still produce a non-negative result.
    const cost = computeCost('openai/gpt-4o', 200, 0, 500);
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// SessionManager.getUsageStats
// ============================================================

describe('SessionManager.getUsageStats', () => {
  let db: Database | null = null;
  let sm: SessionManager;

  beforeEach(() => {
    db = openDb(':memory:');
    sm = new SessionManager(db);
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = null;
  });

  function makeMessage(
    role: Message['role'],
    content: string,
    extra: Partial<Message> = {},
  ): Message {
    return {
      id: crypto.randomUUID(),
      role,
      content,
      createdAt: Date.now(),
      ...extra,
    };
  }

  test('empty database returns zeros', () => {
    const stats = sm.getUsageStats();
    expect(stats.totalTokensIn).toBe(0);
    expect(stats.totalTokensOut).toBe(0);
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.sessionCount).toBe(0);
    expect(stats.turnCount).toBe(0);
    expect(stats.perModel).toEqual([]);
    expect(stats.perDay).toEqual([]);
    expect(stats.topSessions).toEqual([]);
  });

  test('totals + perModel + perDay aggregate correctly', () => {
    const s1 = sm.createSession('/p1', 'openai/gpt-4o-mini', 'openai');
    const s2 = sm.createSession('/p2', 'anthropic/claude-3.5-sonnet', 'anthropic');

    // Two assistant turns on s1 with gpt-4o-mini.
    sm.addMessage(s1.id, makeMessage('assistant', 'a', {
      tokensInput: 1000,
      tokensOutput: 500,
      model: 'openai/gpt-4o-mini',
    }));
    sm.addMessage(s1.id, makeMessage('assistant', 'a2', {
      tokensInput: 2000,
      tokensOutput: 1000,
      model: 'openai/gpt-4o-mini',
    }));
    // One turn on s2 with sonnet.
    sm.addMessage(s2.id, makeMessage('assistant', 'b', {
      tokensInput: 4000,
      tokensOutput: 1500,
      model: 'anthropic/claude-3.5-sonnet',
    }));

    const stats = sm.getUsageStats();
    expect(stats.totalTokensIn).toBe(7000);
    expect(stats.totalTokensOut).toBe(3000);
    expect(stats.turnCount).toBe(3);
    expect(stats.sessionCount).toBe(2);

    expect(stats.perModel).toHaveLength(2);
    // perModel is sorted by cost desc — sonnet's cost (~0.0345) > mini (~0.001+).
    const sonnet = stats.perModel.find(
      (m) => m.model === 'anthropic/claude-3.5-sonnet',
    );
    const mini = stats.perModel.find(
      (m) => m.model === 'openai/gpt-4o-mini',
    );
    expect(sonnet).toBeDefined();
    expect(mini).toBeDefined();
    expect(sonnet?.turns).toBe(1);
    expect(mini?.turns).toBe(2);
    expect(mini?.tokensIn).toBe(3000);
    expect(mini?.tokensOut).toBe(1500);

    // perDay contains today's date.
    expect(stats.perDay.length).toBeGreaterThan(0);
    const today = new Date().toISOString().slice(0, 10);
    const day = stats.perDay.find((d) => d.date === today);
    expect(day).toBeDefined();
    expect(day?.tokensIn).toBe(7000);
  });

  test('projectRoot filter restricts to one workspace', () => {
    const s1 = sm.createSession('/proj/a', 'openai/gpt-4o-mini', 'openai');
    const s2 = sm.createSession('/proj/b', 'openai/gpt-4o-mini', 'openai');
    sm.addMessage(s1.id, makeMessage('assistant', 'a', {
      tokensInput: 100,
      tokensOutput: 50,
      model: 'openai/gpt-4o-mini',
    }));
    sm.addMessage(s2.id, makeMessage('assistant', 'b', {
      tokensInput: 999,
      tokensOutput: 999,
      model: 'openai/gpt-4o-mini',
    }));

    const filtered = sm.getUsageStats({ projectRoot: '/proj/a' });
    expect(filtered.sessionCount).toBe(1);
    expect(filtered.totalTokensIn).toBe(100);
    expect(filtered.totalTokensOut).toBe(50);
  });

  test('modelFilter substring match', () => {
    const s = sm.createSession('/p', 'openai/gpt-4o', 'openai');
    sm.addMessage(s.id, makeMessage('assistant', 'a', {
      tokensInput: 100,
      tokensOutput: 50,
      model: 'openai/gpt-4o',
    }));
    sm.addMessage(s.id, makeMessage('assistant', 'b', {
      tokensInput: 200,
      tokensOutput: 100,
      model: 'anthropic/claude-3.5-haiku',
    }));

    const openaiOnly = sm.getUsageStats({ modelFilter: 'openai' });
    expect(openaiOnly.turnCount).toBe(1);
    expect(openaiOnly.totalTokensIn).toBe(100);

    const anthOnly = sm.getUsageStats({ modelFilter: 'CLAUDE' });
    expect(anthOnly.turnCount).toBe(1);
    expect(anthOnly.totalTokensIn).toBe(200);
  });

  test('topSessions sorted by cost desc', () => {
    const s1 = sm.createSession('/p', 'openai/gpt-4o', 'openai');
    const s2 = sm.createSession('/p', 'openai/gpt-4o-mini', 'openai');
    sm.updateTitle(s1.id, 'big chat');
    sm.updateTitle(s2.id, 'small chat');

    // s1: expensive (gpt-4o, lots of tokens)
    sm.addMessage(s1.id, makeMessage('assistant', 'a', {
      tokensInput: 10_000,
      tokensOutput: 5_000,
      model: 'openai/gpt-4o',
    }));
    // s2: cheap (gpt-4o-mini, fewer tokens)
    sm.addMessage(s2.id, makeMessage('assistant', 'b', {
      tokensInput: 1_000,
      tokensOutput: 500,
      model: 'openai/gpt-4o-mini',
    }));

    const stats = sm.getUsageStats();
    expect(stats.topSessions).toHaveLength(2);
    expect(stats.topSessions[0]?.sessionId).toBe(s1.id);
    expect(stats.topSessions[0]?.title).toBe('big chat');
    expect(stats.topSessions[0]?.cost).toBeGreaterThan(
      stats.topSessions[1]?.cost ?? 0,
    );
  });

  test('sub-agent sessions excluded from aggregation', () => {
    sm.createSession('/p', 'openai/gpt-4o-mini', 'openai', {
      id: 'parent.agent.worker1',
    });
    const subAgent = sm.getSession('parent.agent.worker1');
    expect(subAgent).not.toBeNull();
    if (subAgent === null) throw new Error('precondition');

    sm.addMessage(subAgent.id, makeMessage('assistant', 'a', {
      tokensInput: 9_999,
      tokensOutput: 9_999,
      model: 'openai/gpt-4o',
    }));
    const stats = sm.getUsageStats();
    expect(stats.turnCount).toBe(0);
    expect(stats.sessionCount).toBe(0);
  });

  test('sinceMs filter excludes older messages', () => {
    const s = sm.createSession('/p', 'openai/gpt-4o-mini', 'openai');
    const old = makeMessage('assistant', 'old', {
      tokensInput: 100,
      tokensOutput: 50,
      model: 'openai/gpt-4o-mini',
      createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days ago
    });
    const fresh = makeMessage('assistant', 'fresh', {
      tokensInput: 200,
      tokensOutput: 100,
      model: 'openai/gpt-4o-mini',
    });
    sm.addMessage(s.id, old);
    sm.addMessage(s.id, fresh);

    // Default since = 30 days ago — old row excluded.
    const recent = sm.getUsageStats();
    expect(recent.totalTokensIn).toBe(200);

    // Explicit since = 0 (all time) — both rows included.
    const all = sm.getUsageStats({ sinceMs: 0 });
    expect(all.totalTokensIn).toBe(300);
  });

  test('messages without token telemetry are excluded', () => {
    const s = sm.createSession('/p', 'openai/gpt-4o-mini', 'openai');
    // User message (no token columns)
    sm.addMessage(s.id, makeMessage('user', 'hi'));
    // Assistant without tokens
    sm.addMessage(s.id, makeMessage('assistant', 'untracked'));
    // Assistant with tokens
    sm.addMessage(s.id, makeMessage('assistant', 'a', {
      tokensInput: 100,
      tokensOutput: 50,
      model: 'openai/gpt-4o-mini',
    }));
    const stats = sm.getUsageStats();
    expect(stats.turnCount).toBe(1);
    expect(stats.totalTokensIn).toBe(100);
  });
});

// ============================================================
// REST: GET /api/usage
// ============================================================

describe('GET /api/usage', () => {
  let tempDir: string;
  let configPath: string;
  let workspacesPath: string;
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
      createAdapterForBackend: (_b: Backend): ProviderAdapter => ({
        getModels: async () => [],
      }),
    };
  }

  function call(
    handler: ReturnType<typeof createApiHandler>,
    path: string,
  ): Promise<Response | null> {
    const url = new URL(`http://localhost${path}`);
    return handler(new Request(url), url);
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'localcode-usage-'));
    configPath = join(tempDir, 'config.toml');
    workspacesPath = join(tempDir, 'workspaces.json');
    projectRoot = join(tempDir, 'proj');
    mkdirSync(projectRoot, { recursive: true });

    configManager = new ConfigManager(configPath);
    const cfg = getDefaultConfig('ollama');
    cfg.model.current = 'llama3';
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

  test('empty period returns zeros', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, '/api/usage');
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.totalTokensIn).toBe(0);
    expect(body.totalTokensOut).toBe(0);
    expect(body.sessionCount).toBe(0);
    expect(body.perModel).toEqual([]);
  });

  test('happy path returns aggregated data', async () => {
    const s = sessionManager.createSession(
      projectRoot,
      'openai/gpt-4o-mini',
      'openai',
    );
    sessionManager.addMessage(s.id, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'hi',
      createdAt: Date.now(),
      tokensInput: 1000,
      tokensOutput: 500,
      model: 'openai/gpt-4o-mini',
    });

    const handler = createApiHandler(buildDeps());
    const res = await call(handler, '/api/usage');
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.totalTokensIn).toBe(1000);
    expect(body.totalTokensOut).toBe(500);
    expect(body.turnCount).toBe(1);
    expect(body.totalCostUsd).toBeGreaterThan(0);
    expect(body.perModel).toHaveLength(1);
    expect(body.perModel[0].model).toBe('openai/gpt-4o-mini');
  });

  test('projectId filter restricts to one workspace', async () => {
    const w = workspaceRegistry.create(projectRoot);
    const otherProj = join(tempDir, 'other');
    mkdirSync(otherProj, { recursive: true });

    const s1 = sessionManager.createSession(
      projectRoot,
      'openai/gpt-4o-mini',
      'openai',
    );
    const s2 = sessionManager.createSession(
      otherProj,
      'openai/gpt-4o-mini',
      'openai',
    );
    sessionManager.addMessage(s1.id, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'in scope',
      createdAt: Date.now(),
      tokensInput: 100,
      tokensOutput: 50,
      model: 'openai/gpt-4o-mini',
    });
    sessionManager.addMessage(s2.id, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'out of scope',
      createdAt: Date.now(),
      tokensInput: 9999,
      tokensOutput: 9999,
      model: 'openai/gpt-4o-mini',
    });

    const handler = createApiHandler(buildDeps());
    const res = await call(handler, `/api/usage?projectId=${w.id}`);
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.totalTokensIn).toBe(100);
    expect(body.totalTokensOut).toBe(50);
    expect(body.sessionCount).toBe(1);
  });

  test('unknown projectId returns 404', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, '/api/usage?projectId=does-not-exist');
    expect(res?.status).toBe(404);
  });

  test('rejects unsupported method', async () => {
    const handler = createApiHandler(buildDeps());
    const url = new URL('http://localhost/api/usage');
    const res = await handler(new Request(url, { method: 'POST' }), url);
    expect(res?.status).toBe(405);
  });

  test('invalid sinceMs returns 400', async () => {
    const handler = createApiHandler(buildDeps());
    const res = await call(handler, '/api/usage?sinceMs=notanumber');
    expect(res?.status).toBe(400);
  });

  test('modelFilter passthrough', async () => {
    const s = sessionManager.createSession(
      projectRoot,
      'openai/gpt-4o-mini',
      'openai',
    );
    sessionManager.addMessage(s.id, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'a',
      createdAt: Date.now(),
      tokensInput: 100,
      tokensOutput: 50,
      model: 'openai/gpt-4o-mini',
    });
    sessionManager.addMessage(s.id, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'b',
      createdAt: Date.now(),
      tokensInput: 200,
      tokensOutput: 100,
      model: 'anthropic/claude-3.5-sonnet',
    });

    const handler = createApiHandler(buildDeps());
    const res = await call(handler, '/api/usage?modelFilter=anthropic');
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.turnCount).toBe(1);
    expect(body.totalTokensIn).toBe(200);
  });
});
