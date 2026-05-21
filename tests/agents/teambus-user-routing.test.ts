/**
 * AGENT-INBOUND-MSG-SECTION — TeamBus user-routing contract.
 *
 * Verifies that `orchestrator.postTeamMessage(parentSessionId, 'lead',
 * agentId, text)` is observable by a worker subscribed via
 * `bus.subscribe(...)`. The worker runner (runner-factory.ts) uses this
 * exact subscription path to buffer user follow-ups during a turn and
 * flush them at the next boundary, so this test pins the contract.
 *
 * We test against the orchestrator + bus directly rather than mounting
 * a full ChatRuntime runner — the routing/filtering logic is what
 * matters; the injection-on-next-turn behaviour belongs in an
 * integration test (out of scope for this slice).
 */

import { describe, expect, test } from 'bun:test';

import {
  AgentOrchestrator,
  type AgentRunner,
  type AgentRunnerSpec,
} from '@/agents/orchestrator';
import type { AgentsConfig, SpawnAgentRequest, TeamBusMessage } from '@/agents/types';

const baseConfig: AgentsConfig = {
  workerModel: 'fake-worker',
  maxConcurrent: 3,
  isolation: 'shared',
  approval: 'auto',
  defaultTimeoutSec: 5,
};

const baseReq: SpawnAgentRequest = { task: 'do thing', files: [] };

function makeOrchestrator(): AgentOrchestrator {
  return new AgentOrchestrator({
    projectRoot: '/tmp/fake-root',
    config: baseConfig,
    runnerFactory: (_spec: AgentRunnerSpec): AgentRunner => ({
      async start() {
        /* no-op */
      },
      async cancel() {
        /* no-op */
      },
    }),
    idGenerator: (() => {
      let n = 0;
      return () => `a${++n}`;
    })(),
  });
}

describe('TeamBus user-routing — postTeamMessage lead → agentId', () => {
  test('worker subscriber receives lead → agentId unicast', async () => {
    const orch = makeOrchestrator();
    const handle = await orch.spawn('parent-1', baseReq);
    const inbound: TeamBusMessage[] = [];
    const bus = orch.getBus('parent-1');
    const unsubscribe = bus.subscribe((m) => {
      // Mirror the runner-factory filter contract: from === 'lead'
      // AND to === agentId.
      if (m.from === 'lead' && m.to === handle.agentId) {
        inbound.push(m);
      }
    });

    orch.postTeamMessage('parent-1', 'lead', handle.agentId, 'follow up');
    expect(inbound.length).toBe(1);
    expect(inbound[0]?.message).toBe('follow up');
    unsubscribe();
  });

  test('worker ignores lead messages addressed to a different agent', async () => {
    const orch = makeOrchestrator();
    const h1 = await orch.spawn('parent-1', baseReq);
    const h2 = await orch.spawn('parent-1', baseReq);
    const intoH1: TeamBusMessage[] = [];
    const intoH2: TeamBusMessage[] = [];
    const bus = orch.getBus('parent-1');
    const unsub1 = bus.subscribe((m) => {
      if (m.from === 'lead' && m.to === h1.agentId) intoH1.push(m);
    });
    const unsub2 = bus.subscribe((m) => {
      if (m.from === 'lead' && m.to === h2.agentId) intoH2.push(m);
    });

    orch.postTeamMessage('parent-1', 'lead', h1.agentId, 'for h1');
    orch.postTeamMessage('parent-1', 'lead', h2.agentId, 'for h2');

    expect(intoH1.length).toBe(1);
    expect(intoH1[0]?.message).toBe('for h1');
    expect(intoH2.length).toBe(1);
    expect(intoH2[0]?.message).toBe('for h2');
    unsub1();
    unsub2();
  });

  test('worker filters out peer-to-peer messages even if addressed to itself', async () => {
    // The runner-factory subscription deliberately ignores `from !==
    // 'lead'` to keep the inbound-user-message lane scoped to the
    // human-operator path. Peer agent messages still flow through the
    // `team_read` tool that the worker invokes itself.
    const orch = makeOrchestrator();
    const h1 = await orch.spawn('parent-1', baseReq);
    const h2 = await orch.spawn('parent-1', baseReq);
    const inboundForH1: TeamBusMessage[] = [];
    const bus = orch.getBus('parent-1');
    const unsub = bus.subscribe((m) => {
      if (m.from === 'lead' && m.to === h1.agentId) inboundForH1.push(m);
    });

    // h2 → h1 unicast — must not show up in h1's user-inbound queue.
    orch.postTeamMessage('parent-1', h2.agentId, h1.agentId, 'peer note');
    expect(inboundForH1.length).toBe(0);
    unsub();
  });

  test('postTeamMessage emits agent_team_message orchestrator event', async () => {
    const orch = makeOrchestrator();
    const handle = await orch.spawn('parent-1', baseReq);
    const evts: { type: string; from: string; to: string }[] = [];
    orch.subscribe((e) => {
      if (e.type === 'agent_team_message') {
        evts.push({ type: e.type, from: e.from, to: e.to });
      }
    });
    orch.postTeamMessage('parent-1', 'lead', handle.agentId, 'hi');
    expect(evts.length).toBe(1);
    expect(evts[0]?.from).toBe('lead');
    expect(evts[0]?.to).toBe(handle.agentId);
  });
});
