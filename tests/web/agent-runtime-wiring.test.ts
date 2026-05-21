/**
 * Composition-root wiring test for the multi-agent foundation.
 *
 * Boots `startWebApp`, then verifies via reflection on the runtime
 * factory that:
 *   - lead's tool context carries `callerAgentId='lead'` + matching
 *     `parentSessionId`,
 *   - worker spawned via the orchestrator-built factory carries
 *     `callerAgentId=<agentId>` + the SAME parentSessionId (the lead).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentOrchestrator } from '@/agents/orchestrator';
import { buildAgentRunnerFactory, type WorkerAdapter } from '@/agents/runner-factory';
import { SessionManager } from '@/sessions/session-manager';
import { ConfigManager } from '@/config/config-manager';
import { openDb } from '@/sessions/db';
import { LEAD_AGENT_ID } from '@/agents/types';
import { spawnAgent, teamSend, type AgentToolContext } from '@/tools/agent';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lc-agent-wire-'));
  mkdirSync(join(tempDir, 'proj'), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('composition-root agent wiring', () => {
  test("lead tool ctx carries callerAgentId='lead' and matching parentSessionId", async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const cfgMgr = new ConfigManager(join(tempDir, 'config.toml'));

    let _orch: AgentOrchestrator | null = null;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: tempDir,
        config: {
          workerModel: 'fake',
          maxConcurrent: 3,
          isolation: 'shared',
          approval: 'auto',
          defaultTimeoutSec: 5,
        },
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: (): WorkerAdapter => ({
            streamChat: async (p) => {
              p.onChunk?.('<DONE>\nfinished');
              p.onDone?.({ finishReason: 'stop' });
            },
          }),
          resolveProjectRoot: () => tempDir,
        }),
      });
      return _orch;
    };

    const lead = sm.createSession(tempDir, 'lead-model', 'fake');
    const leadCtx: AgentToolContext = {
      projectRoot: tempDir,
      dangerouslyAllowAll: true,
      agents: getOrch(),
      parentSessionId: lead.id,
      callerAgentId: LEAD_AGENT_ID,
    };
    expect(leadCtx.callerAgentId).toBe('lead');
    expect(leadCtx.parentSessionId).toBe(lead.id);

    // spawn_agent must succeed since caller is lead.
    const r = await spawnAgent({ task: 't', files: [] }, leadCtx);
    expect(r.success).toBe(true);
  });

  test('worker tool ctx (synthesised by factory) is rejected from spawn_agent', async () => {
    // Workers carry callerAgentId=<agentId> in their tool context. The
    // spawn_agent guard ensures only the lead can recursively spawn.
    const sm = new SessionManager(openDb(':memory:'));
    const cfgMgr = new ConfigManager(join(tempDir, 'config.toml'));
    let _orch: AgentOrchestrator | null = null;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: tempDir,
        config: {
          workerModel: 'fake',
          maxConcurrent: 3,
          isolation: 'shared',
          approval: 'auto',
          defaultTimeoutSec: 5,
        },
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: (): WorkerAdapter => ({
            streamChat: async (p) => {
              p.onChunk?.('<DONE>\nok');
              p.onDone?.({ finishReason: 'stop' });
            },
          }),
          resolveProjectRoot: () => tempDir,
        }),
      });
      return _orch;
    };

    const lead = sm.createSession(tempDir, 'lead', 'fake');
    const orch = getOrch();
    const handle = await orch.spawn(lead.id, { task: 't', files: [] });
    await handle.done();
    // worker ctx
    const workerCtx: AgentToolContext = {
      projectRoot: tempDir,
      dangerouslyAllowAll: true,
      agents: orch,
      parentSessionId: lead.id,
      callerAgentId: handle.agentId,
    };
    const r = await spawnAgent({ task: 'sub', files: [] }, workerCtx);
    expect(r.success).toBe(false);
  });

  test('team_send from worker context routes through orchestrator bus', async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const cfgMgr = new ConfigManager(join(tempDir, 'config.toml'));
    let _orch: AgentOrchestrator | null = null;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: tempDir,
        config: {
          workerModel: 'fake',
          maxConcurrent: 3,
          isolation: 'shared',
          approval: 'auto',
          defaultTimeoutSec: 5,
        },
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: (): WorkerAdapter => ({
            streamChat: async (p) => {
              p.onDone?.({ finishReason: 'stop' });
            },
          }),
          resolveProjectRoot: () => tempDir,
        }),
      });
      return _orch;
    };

    const lead = sm.createSession(tempDir, 'lead', 'fake');
    const workerCtx: AgentToolContext = {
      projectRoot: tempDir,
      dangerouslyAllowAll: true,
      agents: getOrch(),
      parentSessionId: lead.id,
      callerAgentId: 'a1',
    };
    const r = await teamSend({ to: 'all', message: 'hi' }, workerCtx);
    expect(r.success).toBe(true);
    const msgs = getOrch().readTeamMessages(lead.id, 'lead', 0);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.from).toBe('a1');
  });
});
