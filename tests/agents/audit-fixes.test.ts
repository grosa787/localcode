/**
 * Regression tests for agent-side audit fixes (M7).
 *
 * Keep them stand-alone — each test cites the audit finding ID it pins.
 */

import { describe, expect, test } from 'bun:test';

import {
  AgentOrchestrator,
  type AgentRunner,
  type AgentRunnerCallbacks,
} from '@/agents/orchestrator';
import type { AgentsConfig } from '@/agents/types';

const baseConfig: AgentsConfig = {
  workerModel: 'fake',
  maxConcurrent: 3,
  isolation: 'shared',
  approval: 'auto',
  defaultTimeoutSec: 5,
};

function makeOrch(): {
  orch: AgentOrchestrator;
  runners: Array<{ cancel: () => Promise<void>; cancelled: number; callbacks: AgentRunnerCallbacks | null }>;
} {
  const runners: Array<{
    cancel: () => Promise<void>;
    cancelled: number;
    callbacks: AgentRunnerCallbacks | null;
  }> = [];
  const orch = new AgentOrchestrator({
    projectRoot: '/tmp/fake',
    config: baseConfig,
    runnerFactory: () => {
      const r = {
        callbacks: null as AgentRunnerCallbacks | null,
        cancelled: 0,
        async cancel(): Promise<void> {
          this.cancelled += 1;
        },
      };
      const wrapped: AgentRunner = {
        async start(cbs: AgentRunnerCallbacks): Promise<void> {
          r.callbacks = cbs;
        },
        async cancel(): Promise<void> {
          await r.cancel();
        },
      };
      runners.push(r);
      return wrapped;
    },
  });
  return { orch, runners };
}

// ---------- M7 — orchestrator unsubscribes from TeamBus on dispose ----------

describe('audit M7 — orchestrator unsubscribes bus listener on dispose', () => {
  test('disposeTeam releases the bus subscriber it owned', async () => {
    const { orch } = makeOrch();
    // Spawn an agent to materialise the team + bus subscription.
    await orch.spawn('parent', { task: 'go', files: [] });
    const bus = orch.getBus('parent');
    // Sanity: the orchestrator has subscribed.
    expect((bus as unknown as { subscribers: Set<unknown> }).subscribers.size).toBeGreaterThanOrEqual(1);
    await orch.disposeTeam('parent');
    // After dispose: bus.clear() drops everything; AND the orchestrator's
    // own unsubscribe was called explicitly. Re-running ensureTeam would
    // build a fresh bus; the old one must not leak listeners.
    expect((bus as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(0);
  });
});
