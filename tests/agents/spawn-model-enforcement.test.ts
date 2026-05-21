/**
 * Strict worker-slot allow-list enforcement in `spawn_agent`.
 *
 * The lead may NOT pick an arbitrary model id when the user has
 * configured `cfg.agents.workerSlots`. Tests cover:
 *   - explicit model that matches a slot   -> ok
 *   - explicit model with no matching slot -> rejected with a message
 *     listing the configured slots
 *   - unspecified model                    -> uses slot 0 (or
 *     `workerModel` fallback when slots are absent)
 *   - `slot: <i>` -> uses the i-th slot's model
 *   - `slot: <out-of-range>` -> rejected
 *   - both `slot` + `model` supplied -> slot wins
 *   - `cfg.workerSlots` absent      -> falls back to the legacy
 *     single-model `cfg.workerModel` allow-list
 *
 * The tests exercise both the pure resolver (`resolveSpawnTarget`)
 * for unit-style assertions AND the full `spawnAgent` tool against a
 * real (test-instantiated) `AgentOrchestrator` for the integration
 * path.
 */

import { describe, expect, test } from 'bun:test';

import {
  resolveSpawnTarget,
  spawnAgent,
  type AgentToolContext,
} from '@/tools/agent';
import {
  AgentOrchestrator,
} from '@/agents/orchestrator';
import { buildAgentRunnerFactory, type WorkerAdapter } from '@/agents/runner-factory';
import { SessionManager } from '@/sessions/session-manager';
import { ConfigManager } from '@/config/config-manager';
import { openDb } from '@/sessions/db';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentsConfig } from '@/types/global';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-spawn-enf-'));
}

function makeFakeAdapter(text: string): WorkerAdapter {
  return {
    streamChat: async (params) => {
      params.onChunk?.(text);
      params.onDone?.({ finishReason: 'stop' });
    },
  };
}

const TWO_SLOT_CONFIG: AgentsConfig = {
  workerModel: 'deepseek/coder',
  workerSlots: [
    { model: 'deepseek/coder', skills: ['typescript'] },
    { model: 'qwen/qwen3-max' },
  ],
  maxConcurrent: 3,
  isolation: 'shared',
  approval: 'auto',
  defaultTimeoutSec: 5,
};

const NO_SLOTS_CONFIG: AgentsConfig = {
  workerModel: 'deepseek/coder',
  maxConcurrent: 3,
  isolation: 'shared',
  approval: 'auto',
  defaultTimeoutSec: 5,
};

describe('resolveSpawnTarget — slot allow-list enforcement', () => {
  test('explicit model matching a slot is accepted', () => {
    const out = resolveSpawnTarget({ model: 'deepseek/coder' }, TWO_SLOT_CONFIG);
    expect(out.model).toBe('deepseek/coder');
    // Slot 0 carries skills:['typescript'] -> inherited by default.
    expect(out.skills).toEqual(['typescript']);
  });

  test('explicit model NOT in any slot is rejected with message listing configured slots', () => {
    let caught: Error | null = null;
    try {
      resolveSpawnTarget({ model: 'random/unknown' }, TWO_SLOT_CONFIG);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    const msg = caught?.message ?? '';
    expect(msg).toContain("Model 'random/unknown' is not configured");
    expect(msg).toContain('"deepseek/coder"');
    expect(msg).toContain('"qwen/qwen3-max"');
  });

  test('no model specified uses slot 0', () => {
    const out = resolveSpawnTarget({}, TWO_SLOT_CONFIG);
    expect(out.model).toBe('deepseek/coder');
    expect(out.skills).toEqual(['typescript']);
  });

  test('slot: 1 uses the qwen model from slot 1', () => {
    const out = resolveSpawnTarget({ slot: 1 }, TWO_SLOT_CONFIG);
    expect(out.model).toBe('qwen/qwen3-max');
    // Slot 1 carries no skills -> none inherited.
    expect(out.skills).toBeUndefined();
  });

  test('slot: 5 (out of range) is rejected', () => {
    let caught: Error | null = null;
    try {
      resolveSpawnTarget({ slot: 5 }, TWO_SLOT_CONFIG);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message ?? '').toContain('slot 5 is out of range');
  });

  test('both slot and model supplied — slot wins', () => {
    // slot 0 -> deepseek; user also passed model='qwen/qwen3-max'.
    const out = resolveSpawnTarget(
      { slot: 0, model: 'qwen/qwen3-max' },
      TWO_SLOT_CONFIG,
    );
    expect(out.model).toBe('deepseek/coder');
  });

  test('caller-supplied skills win over slot-default skills', () => {
    const out = resolveSpawnTarget(
      { model: 'deepseek/coder', skills: ['rust'] },
      TWO_SLOT_CONFIG,
    );
    expect(out.skills).toEqual(['rust']);
  });

  test('legacy: no workerSlots — single-model allow-list using workerModel', () => {
    const out = resolveSpawnTarget(
      { model: 'deepseek/coder' },
      NO_SLOTS_CONFIG,
    );
    expect(out.model).toBe('deepseek/coder');
    expect(out.skills).toBeUndefined();
  });

  test('legacy: unknown model still rejected when only workerModel is configured', () => {
    let caught: Error | null = null;
    try {
      resolveSpawnTarget({ model: 'random/unknown' }, NO_SLOTS_CONFIG);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message ?? '').toContain('not configured as a worker slot');
  });

  test('slot: 0 with no slots configured is rejected', () => {
    let caught: Error | null = null;
    try {
      resolveSpawnTarget({ slot: 0 }, NO_SLOTS_CONFIG);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message ?? '').toContain('no worker slots are configured');
  });
});

describe('spawn_agent integration — strict slot enforcement via AgentToolContext', () => {
  function makeOrchAndCtx(
    agentsConfig: AgentsConfig,
    workerText = '<DONE>\nDone.',
  ): { orch: AgentOrchestrator; ctx: AgentToolContext; cleanup: () => void } {
    const tmp = tmpHome();
    const sm = new SessionManager(openDb(':memory:'));
    const cfgMgr = new ConfigManager(path.join(tmp, 'config.toml'));
    let _orch: AgentOrchestrator | null = null;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: '/tmp/fake-root',
        config: agentsConfig,
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: () => makeFakeAdapter(workerText),
          resolveProjectRoot: () => '/tmp/fake-root',
        }),
      });
      return _orch;
    };
    const orch = getOrch();
    const lead = sm.createSession('/tmp/fake-root', 'lead', 'fake');
    const ctx: AgentToolContext = {
      projectRoot: '/tmp/fake-root',
      dangerouslyAllowAll: true,
      agents: orch,
      parentSessionId: lead.id,
      callerAgentId: 'lead',
      agentsConfig,
    };
    return {
      orch,
      ctx,
      cleanup: () => {
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      },
    };
  }

  test('rejects model not in configured slots and surfaces the allow-list', async () => {
    const { ctx, cleanup } = makeOrchAndCtx(TWO_SLOT_CONFIG);
    try {
      const res = await spawnAgent(
        { task: 'edit foo', files: [], model: 'random/unknown' },
        ctx,
      );
      expect(res.success).toBe(false);
      const err = res.error ?? '';
      expect(err).toContain("Model 'random/unknown'");
      expect(err).toContain('"deepseek/coder"');
      expect(err).toContain('"qwen/qwen3-max"');
    } finally {
      cleanup();
    }
  });

  test('accepts model that matches a slot and assigns the right model to the worker', async () => {
    const { orch, ctx, cleanup } = makeOrchAndCtx(TWO_SLOT_CONFIG);
    try {
      const res = await spawnAgent(
        { task: 'edit foo', files: ['foo.ts'], model: 'qwen/qwen3-max' },
        ctx,
      );
      expect(res.success).toBe(true);
      const { agentId } = JSON.parse(res.output) as { agentId: string };
      const handle = orch.get(ctx.parentSessionId ?? '', agentId);
      expect(handle?.model).toBe('qwen/qwen3-max');
      // Drain so the test doesn't leak background work.
      await handle?.done();
    } finally {
      cleanup();
    }
  });

  test('slot: 0 routes to the first configured slot model', async () => {
    const { orch, ctx, cleanup } = makeOrchAndCtx(TWO_SLOT_CONFIG);
    try {
      const res = await spawnAgent(
        { task: 'work', files: [], slot: 0 },
        ctx,
      );
      expect(res.success).toBe(true);
      const { agentId } = JSON.parse(res.output) as { agentId: string };
      const handle = orch.get(ctx.parentSessionId ?? '', agentId);
      expect(handle?.model).toBe('deepseek/coder');
      await handle?.done();
    } finally {
      cleanup();
    }
  });

  test('slot out-of-range surfaces a clear error', async () => {
    const { ctx, cleanup } = makeOrchAndCtx(TWO_SLOT_CONFIG);
    try {
      const res = await spawnAgent(
        { task: 'work', files: [], slot: 9 },
        ctx,
      );
      expect(res.success).toBe(false);
      expect(res.error ?? '').toContain('slot 9 is out of range');
    } finally {
      cleanup();
    }
  });

  test('with no slots configured falls back to workerModel and rejects others', async () => {
    const { orch, ctx, cleanup } = makeOrchAndCtx(NO_SLOTS_CONFIG);
    try {
      // Allowed.
      const ok = await spawnAgent(
        { task: 'work', files: [], model: 'deepseek/coder' },
        ctx,
      );
      expect(ok.success).toBe(true);
      const { agentId } = JSON.parse(ok.output) as { agentId: string };
      const handle = orch.get(ctx.parentSessionId ?? '', agentId);
      expect(handle?.model).toBe('deepseek/coder');
      await handle?.done();

      // Rejected.
      const rejected = await spawnAgent(
        { task: 'work', files: [], model: 'random/unknown' },
        ctx,
      );
      expect(rejected.success).toBe(false);
      expect(rejected.error ?? '').toContain('not configured as a worker slot');
    } finally {
      cleanup();
    }
  });

  test('default model picks slot 0 when neither model nor slot supplied', async () => {
    const { orch, ctx, cleanup } = makeOrchAndCtx(TWO_SLOT_CONFIG);
    try {
      const res = await spawnAgent({ task: 'work', files: [] }, ctx);
      expect(res.success).toBe(true);
      const { agentId } = JSON.parse(res.output) as { agentId: string };
      const handle = orch.get(ctx.parentSessionId ?? '', agentId);
      expect(handle?.model).toBe('deepseek/coder');
      await handle?.done();
    } finally {
      cleanup();
    }
  });
});
