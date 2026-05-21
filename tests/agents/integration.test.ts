/**
 * End-to-end integration test for the multi-agent foundation.
 *
 * Wires together AgentOrchestrator + AgentRunnerFactory + a fake adapter
 * that replays canned SSE callbacks. Verifies:
 *   - the lead's `spawn_agent` tool spins up a worker via the factory,
 *   - the worker's adapter is exercised, emits chunks + tool_calls,
 *   - emits `<DONE>\nSummary` and resolves `await_agent`,
 *   - WS-shaped events are emitted: agent_spawned, agent_status,
 *     agent_completed,
 *   - workers cannot spawn sub-sub-agents.
 */

import { describe, expect, test } from 'bun:test';

import {
  AgentOrchestrator,
  type OrchestratorEvent,
} from '@/agents/orchestrator';
import type { AgentsConfig } from '@/agents/types';
import { buildAgentRunnerFactory, type WorkerAdapter } from '@/agents/runner-factory';
import { spawnAgent, awaitAgent, type AgentToolContext } from '@/tools/agent';
import { SessionManager } from '@/sessions/session-manager';
import { ConfigManager } from '@/config/config-manager';
import { openDb } from '@/sessions/db';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function makeFakeAdapter(
  scripted: (signal?: AbortSignal) => Promise<{
    text: string;
  }>,
): WorkerAdapter {
  return {
    streamChat: async (params) => {
      const { text } = await scripted(params.signal);
      params.onChunk?.(text);
      params.onDone?.({ finishReason: 'stop' });
    },
  };
}

const baseConfig: AgentsConfig = {
  workerModel: 'fake-worker',
  maxConcurrent: 3,
  isolation: 'shared',
  approval: 'auto',
  defaultTimeoutSec: 5,
};

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-agent-int-'));
  return dir;
}

describe('multi-agent integration', () => {
  test('spawn_agent tool drives worker through to <DONE> summary', async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const events: OrchestratorEvent[] = [];

    const tmp = tmpHome();
    const cfgMgr = new ConfigManager(path.join(tmp, 'config.toml'));

    let _orch: AgentOrchestrator | null = null;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: '/tmp/fake-root',
        config: baseConfig,
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: () =>
            makeFakeAdapter(async () => ({
              text: 'Working...\n<DONE>\nFiles edited: src/foo.ts. No conflicts.',
            })),
          resolveProjectRoot: () => '/tmp/fake-root',
        }),
      });
      _orch.subscribe((e) => events.push(e));
      return _orch;
    };

    // Lead sets up its session then invokes spawn_agent.
    const leadSession = sm.createSession('/tmp/fake-root', 'lead-model', 'fake');
    const ctx: AgentToolContext = {
      projectRoot: '/tmp/fake-root',
      dangerouslyAllowAll: true,
      agents: getOrch(),
      parentSessionId: leadSession.id,
      callerAgentId: 'lead',
    };

    const spawnRes = await spawnAgent(
      { task: 'edit foo', files: ['src/foo.ts'] },
      ctx,
    );
    expect(spawnRes.success).toBe(true);
    const { agentId } = JSON.parse(spawnRes.output) as { agentId: string };

    // Drain the orchestrator events: await_agent waits for the runner's
    // onDone, which is fired by the fake adapter once it streams text.
    const awaitRes = await awaitAgent(
      { agentId, timeoutSec: 5 },
      ctx,
    );
    expect(awaitRes.success).toBe(true);
    const result = JSON.parse(awaitRes.output) as {
      status: string;
      summary: string;
    };
    expect(result.status).toBe('done');
    expect(result.summary).toContain('Files edited');

    // Required WS frames.
    const spawned = events.find((e) => e.type === 'agent_spawned');
    const completed = events.find((e) => e.type === 'agent_completed');
    expect(spawned).toBeDefined();
    expect(completed).toBeDefined();
    if (completed?.type === 'agent_completed') {
      expect(completed.summary).toContain('Files edited');
    }
    expect(events.some((e) => e.type === 'agent_status')).toBe(true);
  });

  test('worker cannot spawn a sub-sub-agent', async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const tmp = tmpHome();
    const cfgMgr = new ConfigManager(path.join(tmp, 'config.toml'));

    let _orch: AgentOrchestrator | null = null;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: '/tmp/fake-root',
        config: baseConfig,
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: () =>
            makeFakeAdapter(async () => ({ text: '<DONE>\nDone.' })),
          resolveProjectRoot: () => '/tmp/fake-root',
        }),
      });
      return _orch;
    };

    const lead = sm.createSession('/tmp/fake-root', 'lead', 'fake');
    const orch = getOrch();
    // Simulate the worker's tool ctx — callerAgentId !== 'lead'.
    const workerCtx: AgentToolContext = {
      projectRoot: '/tmp/fake-root',
      dangerouslyAllowAll: true,
      agents: orch,
      parentSessionId: lead.id,
      callerAgentId: 'a1',
    };
    const res = await spawnAgent({ task: 'sub-sub', files: [] }, workerCtx);
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/restricted to the lead/i);
  });

  test('factory propagates AgentToolContext into worker tool execution', async () => {
    // We verify that when the worker's adapter emits a tool_call for
    // team_send, the orchestrator's bus receives it (i.e. the worker's
    // ctx had `agents` + `parentSessionId` + `callerAgentId` wired).
    const sm = new SessionManager(openDb(':memory:'));
    const tmp = tmpHome();
    const cfgMgr = new ConfigManager(path.join(tmp, 'config.toml'));

    let _orch: AgentOrchestrator | null = null;
    let workerSpec: { agentId: string; parentSessionId: string } | null = null;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: '/tmp/fake-root',
        config: baseConfig,
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: (): WorkerAdapter => ({
            streamChat: async (params) => {
              // First turn: emit a tool_call.
              if (workerSpec !== null) {
                params.onToolCalls?.([
                  {
                    id: 'tc-1',
                    name: 'team_send',
                    arguments: { to: 'all', message: 'starting' },
                  },
                ]);
                params.onDone?.({ finishReason: 'stop' });
                workerSpec = null; // next call should finalise
                return;
              }
              params.onChunk?.('<DONE>\nSent broadcast');
              params.onDone?.({ finishReason: 'stop' });
            },
          }),
          resolveProjectRoot: () => '/tmp/fake-root',
        }),
      });
      return _orch;
    };

    const lead = sm.createSession('/tmp/fake-root', 'lead', 'fake');
    const orch = getOrch();
    workerSpec = { agentId: 'a1', parentSessionId: lead.id };
    const handle = await orch.spawn(lead.id, {
      task: 'broadcast',
      files: [],
    });
    const result = await handle.done();
    expect(result.status).toBe('done');
    // Lead reads the bus — should see the broadcast.
    const msgs = orch.readTeamMessages(lead.id, 'lead', 0);
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0]?.message).toBe('starting');
    expect(msgs[0]?.from).toBe(handle.agentId);
  });

  test('worker cancel cascades runner.cancel + terminal status', async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const tmp = tmpHome();
    const cfgMgr = new ConfigManager(path.join(tmp, 'config.toml'));

    let _orch: AgentOrchestrator | null = null;
    let aborted = false;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: '/tmp/fake-root',
        config: baseConfig,
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: (): WorkerAdapter => ({
            streamChat: (params) =>
              new Promise<void>((resolve) => {
                params.signal?.addEventListener('abort', () => {
                  aborted = true;
                  params.onDone?.({ finishReason: 'aborted' });
                  resolve();
                });
              }),
          }),
          resolveProjectRoot: () => '/tmp/fake-root',
        }),
      });
      return _orch;
    };

    const lead = sm.createSession('/tmp/fake-root', 'lead', 'fake');
    const orch = getOrch();
    const handle = await orch.spawn(lead.id, { task: 'long', files: [] });
    // Give runner a chance to start.
    await new Promise((r) => setTimeout(r, 10));
    await handle.cancel('user requested');
    expect(handle.getStatus()).toBe('cancelled');
    const r = await handle.done();
    expect(r.status).toBe('cancelled');
    expect(aborted).toBe(true);
  });

  test('worker turn loop emits onDone summary when no tool_calls', async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const tmp = tmpHome();
    const cfgMgr = new ConfigManager(path.join(tmp, 'config.toml'));

    let _orch: AgentOrchestrator | null = null;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: '/tmp/fake-root',
        config: baseConfig,
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: () =>
            makeFakeAdapter(async () => ({
              text: 'Done early\n<DONE>\nNothing left to change.',
            })),
          resolveProjectRoot: () => '/tmp/fake-root',
        }),
      });
      return _orch;
    };

    const lead = sm.createSession('/tmp/fake-root', 'lead', 'fake');
    const handle = await getOrch().spawn(lead.id, {
      task: 'noop',
      files: [],
    });
    const result = await handle.done();
    expect(result.status).toBe('done');
    expect(result.summary).toContain('Nothing left');
  });
});
