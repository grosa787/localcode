/**
 * H5 — Sub-agents must not auto-approve `run_command` even when the
 * team's approval policy is 'auto'.
 *
 * The runner-factory wires a ToolExecutor whose allow-list excludes the
 * shell. When the worker emits a run_command call and there is no
 * approval callback (orchestrator does NOT wire one), the executor
 * returns a structured error rather than invoking the shell. The worker
 * sees the rejection like any other tool failure and continues.
 *
 * We exercise this end-to-end through `buildAgentRunnerFactory` and a
 * fake adapter that emits exactly one run_command tool call and then
 * <DONE>. The orchestrator's session persistence stores the synthetic
 * tool reply, so we can grep it for the "requires approval" signature.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentOrchestrator } from '@/agents/orchestrator';
import { buildAgentRunnerFactory, type WorkerAdapter } from '@/agents/runner-factory';
import { SessionManager } from '@/sessions/session-manager';
import { ConfigManager } from '@/config/config-manager';
import { openDb } from '@/sessions/db';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lc-runner-approval-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('runner-factory H5 — sub-agent run_command guardrail', () => {
  test('worker with auto-policy still cannot auto-shell — run_command call returns approval error', async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const cfgMgr = new ConfigManager(join(tempDir, 'config.toml'));

    // Counts how many turns the adapter has been called; turn 0 emits a
    // run_command tool call, turn 1 emits <DONE> so the worker exits.
    let turn = 0;

    let _orch: AgentOrchestrator | null = null;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: tempDir,
        config: {
          workerModel: 'fake',
          maxConcurrent: 3,
          isolation: 'shared',
          // Auto-policy — the very setting H5 makes safe for sub-agents.
          approval: 'auto',
          defaultTimeoutSec: 5,
        },
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: (): WorkerAdapter => ({
            streamChat: async (p) => {
              const current = turn;
              turn += 1;
              if (current === 0) {
                // Emit a single run_command tool call. No <DONE> in this
                // turn — the runner will execute tool calls and loop.
                p.onChunk?.('Running rm -rf to test the guardrail');
                p.onToolCalls?.([
                  {
                    id: 'call-1',
                    name: 'run_command',
                    arguments: { command: 'echo pwned' },
                  },
                ]);
                p.onDone?.({ finishReason: 'tool_calls' });
                return;
              }
              // Turn 1: surrender with <DONE>.
              p.onChunk?.('Cannot complete — <DONE>');
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
    const handle = await orch.spawn(lead.id, {
      task: 'try to shell out',
      files: [],
    });
    const result = await handle.done();

    // The worker finishes (it sees the tool rejection and surrenders),
    // status 'done'. The key assertion is the persisted tool reply
    // showing the run_command was blocked by the approval guard.
    expect(['done', 'failed']).toContain(result.status);

    const childMsgs = sm.getAllMessages(handle.childSessionId);
    const toolReplies = childMsgs.filter((m) => m.role === 'tool');
    // Exactly one tool reply — the rejection for run_command.
    expect(toolReplies.length).toBeGreaterThanOrEqual(1);
    const runCmdReply = toolReplies.find((m) => m.toolName === 'run_command');
    expect(runCmdReply).toBeDefined();
    const content = String(runCmdReply?.content ?? '');
    // The tool-executor produces "requires approval but no approvalCallback".
    expect(content.toLowerCase()).toMatch(/requires approval|no approval/);
    // Sanity: command was NOT executed. The fake "echo pwned" would
    // not have appeared in any output stream — there is no stream to
    // appear in here, but the rejection message is the gate.
    expect(content).not.toContain('pwned');
  });

  test('worker with per-action-policy also blocks run_command (mutating writes also need approval)', async () => {
    const sm = new SessionManager(openDb(':memory:'));
    const cfgMgr = new ConfigManager(join(tempDir, 'config.toml'));
    let turn = 0;
    let _orch: AgentOrchestrator | null = null;
    const getOrch = (): AgentOrchestrator => {
      if (_orch !== null) return _orch;
      _orch = new AgentOrchestrator({
        projectRoot: tempDir,
        config: {
          workerModel: 'fake',
          maxConcurrent: 3,
          isolation: 'shared',
          approval: 'per-action', // also covers the case
          defaultTimeoutSec: 5,
        },
        runnerFactory: buildAgentRunnerFactory({
          orchestrator: () => getOrch(),
          sessionManager: sm,
          configManager: cfgMgr,
          createAdapterForModel: (): WorkerAdapter => ({
            streamChat: async (p) => {
              const current = turn;
              turn += 1;
              if (current === 0) {
                p.onToolCalls?.([
                  {
                    id: 'call-1',
                    name: 'run_command',
                    arguments: { command: 'echo pwned-manual' },
                  },
                ]);
                p.onDone?.({ finishReason: 'tool_calls' });
                return;
              }
              p.onChunk?.('<DONE>');
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

    const childMsgs = sm.getAllMessages(handle.childSessionId);
    const runCmd = childMsgs.find(
      (m) => m.role === 'tool' && m.toolName === 'run_command',
    );
    expect(runCmd).toBeDefined();
    expect(String(runCmd?.content ?? '').toLowerCase()).toMatch(
      /requires approval|no approval/,
    );
  });
});
