/**
 * Agent reliability regression tests.
 *
 * Covers the failure modes uncovered by the agent-reliability investigation:
 *
 *  Fix 1 — `<DONE>` + tool calls on the same turn must execute the tool
 *          calls BEFORE terminating. Previously the runner short-circuited
 *          and dropped the writes silently ("files don't get written").
 *
 *  Fix 2 — Hitting MAX_TURNS must surface as `onError` (status 'failed'),
 *          NOT `onDone` (status 'done'). Otherwise the parent cannot
 *          distinguish "agent completed" from "agent ran out of turns."
 *
 *  Fix 3 — A throwing `onMessage` listener must not abort the streaming
 *          callback chain. Defensive try/catch keeps the turn alive.
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
  tempDir = mkdtempSync(join(tmpdir(), 'lc-runner-reliability-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('runner-factory AGENT-RELIABILITY-FIX-1 — <DONE> + tools on same turn', () => {
  test('write_file emitted on same turn as <DONE> is still executed', async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const cfgMgr = new ConfigManager(join(tempDir, 'config.toml'));

    // The worker emits one turn that contains BOTH a write_file tool call
    // AND the <DONE> sentinel. Before Fix 1, the runner saw <DONE>, marked
    // the worker terminal, and returned without executing the write.
    // After Fix 1, the write runs first and <DONE> only ends the loop
    // after the tool calls have committed.
    const adapter: WorkerAdapter = {
      streamChat: async (p) => {
        p.onChunk?.('Writing the file. <DONE>\n\nSummary: wrote target.txt');
        p.onToolCalls?.([
          {
            id: 'call-1',
            name: 'write_file',
            arguments: { path: 'target.txt', content: 'hello agent' },
          },
        ]);
        p.onDone?.({ finishReason: 'tool_calls' });
      },
    };

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
          createAdapterForModel: () => adapter,
          resolveProjectRoot: () => tempDir,
        }),
      });
      return _orch;
    };

    const lead = sm.createSession(tempDir, 'lead', 'fake');
    const orch = getOrch();
    const handle = await orch.spawn(lead.id, {
      task: 'write target.txt then <DONE>',
      files: ['target.txt'],
      isolation: 'shared',
    });
    const result = await handle.done();

    expect(result.status).toBe('done');

    // The file MUST exist on disk. Before Fix 1, the write was silently
    // dropped; this assertion catches the regression.
    const fs = await import('node:fs/promises');
    const written = await fs.readFile(join(tempDir, 'target.txt'), 'utf8');
    expect(written).toBe('hello agent');

    // The synthetic tool reply must also be persisted — confirms the
    // executor actually ran (not just that we got lucky with files).
    const childMsgs = sm.getAllMessages(handle.childSessionId);
    const toolReplies = childMsgs.filter((m) => m.role === 'tool');
    expect(toolReplies.length).toBe(1);
    expect(toolReplies[0]?.toolName).toBe('write_file');
  });
});

describe('runner-factory AGENT-RELIABILITY-FIX-2 — MAX_TURNS surfaces as failure', () => {
  test('worker hitting cap produces status=failed, not done', async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const cfgMgr = new ConfigManager(join(tempDir, 'config.toml'));

    // Adapter that NEVER emits <DONE> and always emits a tool call → the
    // loop will exhaust MAX_TURNS=40. Using a cheap no-op tool (read_file
    // on a missing path) so each turn settles quickly.
    let turn = 0;
    const adapter: WorkerAdapter = {
      streamChat: async (p) => {
        turn += 1;
        p.onChunk?.(`turn ${turn}`);
        p.onToolCalls?.([
          {
            id: `call-${turn}`,
            name: 'read_file',
            arguments: { path: 'does-not-exist.txt' },
          },
        ]);
        p.onDone?.({ finishReason: 'tool_calls' });
      },
    };

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
          defaultTimeoutSec: 30,
        },
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: () => adapter,
          resolveProjectRoot: () => tempDir,
        }),
      });
      return _orch;
    };

    const lead = sm.createSession(tempDir, 'lead', 'fake');
    const orch = getOrch();
    const handle = await orch.spawn(lead.id, {
      task: 'loop until cap',
      files: [],
      isolation: 'shared',
    });
    const result = await handle.done();

    // Before Fix 2: status would have been 'done' with a misleading
    // synthetic summary. After Fix 2: failed + error referencing the cap.
    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
    expect(result.error ?? '').toMatch(/exhausted|MAX_TURNS|without <DONE>/i);
  });
});

describe('runner-factory AGENT-RELIABILITY-FIX-3 — throwing onMessage must not abort', () => {
  test('listener exception in orchestrator forwarding does not break the worker', async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const cfgMgr = new ConfigManager(join(tempDir, 'config.toml'));

    // Adapter emits text chunks + <DONE> with no tool calls.
    const adapter: WorkerAdapter = {
      streamChat: async (p) => {
        p.onChunk?.('part 1 ');
        p.onChunk?.('part 2 ');
        p.onChunk?.('<DONE>\nsummary: ok');
        p.onDone?.({ finishReason: 'stop' });
      },
    };

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
          createAdapterForModel: () => adapter,
          resolveProjectRoot: () => tempDir,
        }),
      });
      return _orch;
    };

    // Subscribe a listener that THROWS on the first agent_status event —
    // this is the listener path the orchestrator uses to forward
    // `onMessage` text into the parent's WS feed. Before Fix 3, the
    // throw aborted the streaming callback chain.
    let listenerThrows = true;
    const orch = getOrch();
    orch.subscribe((evt) => {
      if (evt.type === 'agent_status' && listenerThrows) {
        listenerThrows = false;
        throw new Error('listener exploded');
      }
    });

    const lead = sm.createSession(tempDir, 'lead', 'fake');
    const handle = await orch.spawn(lead.id, {
      task: 'stream three chunks',
      files: [],
      isolation: 'shared',
    });
    const result = await handle.done();

    // The worker must still finish despite the listener throw.
    expect(result.status).toBe('done');
    // And the summary must reflect the FULL accumulated text — if Fix 3
    // hadn't wrapped onMessage, the post-throw chunks would have been
    // lost and the summary would be empty or partial.
    expect(result.summary).toContain('ok');
  });
});
