/**
 * COST-PERSIST-SECTION — sub-agent rows must carry cost_usd.
 *
 * The runner-factory wires usage telemetry from the worker's
 * `streamChat` callbacks into `SessionManager.addMessage` so sub-agent
 * transcript rows contribute to the dashboard aggregates just like the
 * lead. Regression guard: an assistant turn with non-zero token usage
 * persisted under the worker session id must surface a non-zero `cost`
 * on read-back and a non-zero `totalCost` in the per-session
 * aggregator.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentOrchestrator } from '@/agents/orchestrator';
import {
  buildAgentRunnerFactory,
  type WorkerAdapter,
} from '@/agents/runner-factory';
import { SessionManager } from '@/sessions/session-manager';
import { ConfigManager } from '@/config/config-manager';
import { openDb } from '@/sessions/db';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lc-subagent-cost-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('runner-factory — sub-agent cost persistence', () => {
  test('worker assistant row persists cost_usd from streamed usage', async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const cfgMgr = new ConfigManager(join(tempDir, 'config.toml'));

    // Worker emits a single turn that completes (no <DONE> needed when
    // the model returns finishReason='stop' with no tool calls; the
    // runner detects terminal via `pendingToolCalls.length === 0` +
    // streamError === null path). To keep the test focused on cost
    // wiring, we include a <DONE> sentinel to force termination after
    // a single turn.
    const adapter: WorkerAdapter = {
      streamChat: async (p) => {
        p.onChunk?.('Working… <DONE>');
        p.onDone?.({
          finishReason: 'stop',
          usage: {
            promptTokens: 10_000,
            completionTokens: 5_000,
          },
          durationMs: 750,
        });
      },
    };

    let _orch: AgentOrchestrator | null = null;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: tempDir,
        config: {
          // gpt-4o-mini has a non-zero static price so cost > 0.
          workerModel: 'gpt-4o-mini',
          maxConcurrent: 1,
          isolation: 'shared',
          approval: 'auto',
          defaultTimeoutSec: 5,
        },
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: () => adapter,
          resolveProjectRoot: () => tempDir,
          // Backend hint so the resolver can pick a non-null price for
          // gpt-4o-mini even though the session row is synthetic.
          resolveBackend: () => 'openai',
        }),
      });
      return _orch;
    };

    const lead = sm.createSession(tempDir, 'lead', 'openai');
    const orch = getOrch();
    const handle = await orch.spawn(lead.id, {
      task: 'one turn then <DONE>',
      files: [],
      isolation: 'shared',
    });
    const result = await handle.done();
    expect(result.status).toBe('done');

    // Sub-agent session id follows the `<parent>.agent.<id>` convention.
    const childMsgs = sm.getAllMessages(handle.childSessionId);
    const assistantRows = childMsgs.filter((m) => m.role === 'assistant');
    expect(assistantRows.length).toBeGreaterThan(0);
    const row = assistantRows[0]!;
    expect(row.tokensInput).toBe(10_000);
    expect(row.tokensOutput).toBe(5_000);
    expect(row.cost).toBeDefined();
    expect(row.cost).toBeGreaterThan(0);
    // gpt-4o-mini: 0.15 in / 0.6 out per 1M
    //   = 0.0015 + 0.003 = 0.0045 USD.
    expect(row.cost).toBeCloseTo(0.0045, 6);
  });
});
