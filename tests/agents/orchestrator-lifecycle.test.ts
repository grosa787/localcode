/**
 * AgentOrchestrator — AGENT-LIFECYCLE-SECTION coverage.
 *
 * Verifies that a worker completing (done / failed / cancelled) moves
 * from `listActive()` into `listHistory()` and that an `agent_removed`
 * event fires once per terminal transition. These are the contracts
 * the SPA/TUI panels lean on to drop completed rows from the
 * "currently running" view while keeping the entry queryable.
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
}

function makeOrchestrator(): {
  orch: AgentOrchestrator;
  runners: ControlledRunner[];
  events: OrchestratorEvent[];
} {
  const runners: ControlledRunner[] = [];
  const events: OrchestratorEvent[] = [];
  const orch = new AgentOrchestrator({
    projectRoot: '/tmp/fake-root',
    config: baseConfig,
    runnerFactory: (spec) => {
      const r: ControlledRunner = {
        spec,
        callbacks: null,
        async start(cbs) {
          this.callbacks = cbs;
        },
        async cancel() {
          /* no-op */
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
  files: [],
};

describe('AgentOrchestrator — AGENT-LIFECYCLE-SECTION', () => {
  test('completed agent moves from active → history', async () => {
    const { orch, runners } = makeOrchestrator();
    const handle = await orch.spawn('parent', baseReq);
    await new Promise((r) => setTimeout(r, 5));
    expect(orch.listActive('parent').length).toBe(1);
    expect(orch.listHistory('parent').length).toBe(0);

    runners[0]!.callbacks!.onDone({ summary: 'done' });
    await handle.done();

    expect(orch.listActive('parent').length).toBe(0);
    expect(orch.listHistory('parent').length).toBe(1);
    // `list()` still returns the historical entry so `await_agent` /
    // post-mortem lookups don't break.
    expect(orch.list('parent').length).toBe(1);
    expect(orch.get('parent', handle.agentId)).toBeDefined();
  });

  test('failed agent moves to history with status=failed', async () => {
    const { orch, runners } = makeOrchestrator();
    const handle = await orch.spawn('parent', baseReq);
    await new Promise((r) => setTimeout(r, 5));
    runners[0]!.callbacks!.onError('boom');
    await handle.done();

    expect(orch.listActive('parent').length).toBe(0);
    const hist = orch.listHistory('parent');
    expect(hist.length).toBe(1);
    expect(hist[0]?.getStatus()).toBe('failed');
  });

  test('cancelled agent moves to history with status=cancelled', async () => {
    const { orch } = makeOrchestrator();
    const handle = await orch.spawn('parent', baseReq);
    await new Promise((r) => setTimeout(r, 5));
    await handle.cancel('user');
    expect(orch.listActive('parent').length).toBe(0);
    const hist = orch.listHistory('parent');
    expect(hist.length).toBe(1);
    expect(hist[0]?.getStatus()).toBe('cancelled');
  });

  test('emits agent_removed exactly once with terminal status', async () => {
    const { orch, runners, events } = makeOrchestrator();
    const handle = await orch.spawn('parent', baseReq);
    await new Promise((r) => setTimeout(r, 5));
    runners[0]!.callbacks!.onDone({ summary: 'ok' });
    await handle.done();

    const removed = events.filter((e) => e.type === 'agent_removed');
    expect(removed.length).toBe(1);
    const first = removed[0];
    if (first !== undefined && first.type === 'agent_removed') {
      expect(first.agentId).toBe(handle.agentId);
      expect(first.sessionId).toBe('parent');
      expect(first.status).toBe('done');
      expect(typeof first.removedAt).toBe('number');
    }
  });

  test('multiple agents — only completed ones move to history', async () => {
    const { orch, runners } = makeOrchestrator();
    const h1 = await orch.spawn('parent', baseReq);
    const h2 = await orch.spawn('parent', baseReq);
    const h3 = await orch.spawn('parent', baseReq);
    await new Promise((r) => setTimeout(r, 5));

    runners[0]!.callbacks!.onDone({ summary: 'done' });
    await h1.done();

    expect(orch.listActive('parent').length).toBe(2);
    expect(orch.listHistory('parent').length).toBe(1);
    expect(h2.getStatus()).toBe('running');
    expect(h3.getStatus()).toBe('running');
  });

  test('countLive — terminal agents do NOT count against maxConcurrent', async () => {
    const { orch, runners } = makeOrchestrator();
    const h1 = await orch.spawn('parent', baseReq);
    const h2 = await orch.spawn('parent', baseReq);
    const h3 = await orch.spawn('parent', baseReq);
    await new Promise((r) => setTimeout(r, 5));

    // Terminate the first three.
    runners[0]!.callbacks!.onDone({ summary: '1' });
    runners[1]!.callbacks!.onDone({ summary: '2' });
    runners[2]!.callbacks!.onDone({ summary: '3' });
    await Promise.all([h1.done(), h2.done(), h3.done()]);

    // The cap is 3; after termination we should be able to spawn again.
    const h4 = await orch.spawn('parent', baseReq);
    expect(h4.getStatus()).toBe('running');
    expect(orch.listActive('parent').length).toBe(1);
    expect(orch.listHistory('parent').length).toBe(3);
  });
});
