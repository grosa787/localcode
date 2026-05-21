/**
 * AgentOrchestrator tests — spawn/await/cancel/maxConcurrent/dispose,
 * status events, team-bus integration.
 *
 * Uses a fake `AgentRunner` and isolation='shared' (so we don't depend
 * on git in this suite — worktree-specific behaviour is exercised by
 * `worktree.test.ts`).
 */

import { describe, expect, test } from 'bun:test';

import {
  AgentOrchestrator,
  type AgentRunner,
  type AgentRunnerCallbacks,
  type AgentRunnerSpec,
  type OrchestratorEvent,
} from '@/agents/orchestrator';
import type { AgentsConfig, SpawnAgentRequest } from '@/agents/types';

const baseConfig: AgentsConfig = {
  workerModel: 'fake-worker',
  maxConcurrent: 3,
  isolation: 'shared',
  approval: 'auto',
  defaultTimeoutSec: 5,
};

interface ControlledRunner extends AgentRunner {
  spec: AgentRunnerSpec;
  callbacks: AgentRunnerCallbacks | null;
  cancelCount: number;
}

function makeOrchestrator(opts?: Partial<AgentsConfig>): {
  orch: AgentOrchestrator;
  runners: ControlledRunner[];
  events: OrchestratorEvent[];
} {
  const runners: ControlledRunner[] = [];
  const events: OrchestratorEvent[] = [];
  const orch = new AgentOrchestrator({
    projectRoot: '/tmp/fake-root',
    config: { ...baseConfig, ...(opts ?? {}) },
    runnerFactory: (spec) => {
      const r: ControlledRunner = {
        spec,
        callbacks: null,
        cancelCount: 0,
        async start(cbs) {
          this.callbacks = cbs;
        },
        async cancel() {
          this.cancelCount += 1;
        },
      };
      runners.push(r);
      return r;
    },
    idGenerator: (() => {
      let n = 0;
      return () => `a${++n}`;
    })(),
  });
  orch.subscribe((e) => events.push(e));
  return { orch, runners, events };
}

const baseReq: SpawnAgentRequest = {
  task: 'do the thing',
  files: ['src/foo.ts'],
};

describe('AgentOrchestrator.spawn', () => {
  test('returns a handle in running status and emits agent_spawned', async () => {
    const { orch, runners, events } = makeOrchestrator();
    const handle = await orch.spawn('parent-1', baseReq);
    expect(handle.agentId).toBe('a1');
    expect(handle.parentSessionId).toBe('parent-1');
    expect(handle.childSessionId).toBe('parent-1.agent.a1');
    expect(handle.getStatus()).toBe('running');
    expect(runners.length).toBe(1);
    const spawned = events.find((e) => e.type === 'agent_spawned');
    expect(spawned).toBeDefined();
  });

  test('rejects empty task', async () => {
    const { orch } = makeOrchestrator();
    await expect(orch.spawn('p', { task: '   ', files: [] })).rejects.toThrow();
  });

  test('honours maxConcurrent', async () => {
    const { orch } = makeOrchestrator({ maxConcurrent: 2 });
    await orch.spawn('parent', baseReq);
    await orch.spawn('parent', baseReq);
    await expect(orch.spawn('parent', baseReq)).rejects.toThrow(/maxConcurrent/);
  });
});

describe('AgentOrchestrator.await + completion', () => {
  test('runner.onDone resolves done() with summary', async () => {
    const { orch, runners } = makeOrchestrator();
    const handle = await orch.spawn('parent', baseReq);
    // Wait until the runner has been started.
    await new Promise((r) => setTimeout(r, 5));
    const r = runners[0];
    expect(r).toBeDefined();
    r!.callbacks!.onDone({ summary: 'work complete', filesChanged: ['src/foo.ts'] });
    const result = await handle.done();
    expect(result.status).toBe('done');
    expect(result.summary).toBe('work complete');
    expect(result.filesChanged).toEqual(['src/foo.ts']);
  });

  test('runner.onError resolves done() with status=failed', async () => {
    const { orch, runners } = makeOrchestrator();
    const handle = await orch.spawn('parent', baseReq);
    await new Promise((r) => setTimeout(r, 5));
    runners[0]!.callbacks!.onError('exploded');
    const result = await handle.done();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('exploded');
  });
});

describe('AgentOrchestrator.cancel + dispose', () => {
  test('cancel marks status cancelled and invokes runner.cancel', async () => {
    const { orch, runners } = makeOrchestrator();
    const handle = await orch.spawn('parent', baseReq);
    await new Promise((r) => setTimeout(r, 5));
    await handle.cancel('user requested');
    expect(handle.getStatus()).toBe('cancelled');
    expect(runners[0]!.cancelCount).toBeGreaterThanOrEqual(1);
    const result = await handle.done();
    expect(result.status).toBe('cancelled');
    expect(result.error).toBe('user requested');
  });

  test('disposeTeam cancels every live agent under the parent', async () => {
    const { orch, runners } = makeOrchestrator();
    const h1 = await orch.spawn('parent', baseReq);
    const h2 = await orch.spawn('parent', baseReq);
    await orch.disposeTeam('parent');
    expect(h1.getStatus()).toBe('cancelled');
    expect(h2.getStatus()).toBe('cancelled');
    expect(runners.length).toBe(2);
    expect(runners[0]!.cancelCount).toBeGreaterThanOrEqual(1);
    expect(runners[1]!.cancelCount).toBeGreaterThanOrEqual(1);
  });
});

describe('AgentOrchestrator.team-bus', () => {
  test('postTeamMessage emits agent_team_message', async () => {
    const { orch, events } = makeOrchestrator();
    orch.postTeamMessage('parent', 'lead', 'all', 'hello team');
    const evt = events.find((e) => e.type === 'agent_team_message');
    expect(evt).toBeDefined();
    if (evt && evt.type === 'agent_team_message') {
      expect(evt.message).toBe('hello team');
      expect(evt.from).toBe('lead');
    }
  });

  test('readTeamMessages routes to recipient and skips own', async () => {
    const { orch } = makeOrchestrator();
    await orch.spawn('parent', baseReq);
    orch.postTeamMessage('parent', 'lead', 'all', 'plan');
    orch.postTeamMessage('parent', 'a1', 'all', 'echo'); // a1's own
    const forA1 = orch.readTeamMessages('parent', 'a1', 0);
    expect(forA1.length).toBe(1);
    expect(forA1[0]?.message).toBe('plan');
  });
});

describe('AgentOrchestrator.lastMessage tracking', () => {
  test('runner.onMessage updates the snapshot lastMessage', async () => {
    const { orch, runners } = makeOrchestrator();
    const handle = await orch.spawn('parent', baseReq);
    await new Promise((r) => setTimeout(r, 5));
    runners[0]!.callbacks!.onMessage('streaming text');
    expect(handle.snapshot().lastMessage).toBe('streaming text');
  });
});
