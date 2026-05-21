/**
 * Wave 5A (TA team) — TUI multi-agent attach flow.
 *
 * The full flow is:
 *
 *   1. User runs `/spawn <template> ...` (or `spawn_agent`) — orchestrator
 *      creates a worker, fires `agent_spawned`.
 *   2. app.tsx subscribes to orchestrator events and rebuilds the
 *      `agentWorkers: AgentRow[]` snapshot on every event. The
 *      AgentPanel mounts under the InputBar.
 *   3. Tab in 'input' mode flips reducer into `agent-focus`. ↑/↓
 *      moves `agentSelectedIdx`. Enter dispatches AGENT_ATTACH.
 *   4. The composer's onSubmit checks `currentConversant`. If it's a
 *      worker id, the message is posted onto the team bus via
 *      `orchestrator.postTeamMessage(parentSessionId, 'lead', agentId, text)`
 *      instead of feeding the LLM stream.
 *
 * Verified here:
 *
 *   - app.tsx imports the orchestrator + AgentRow types and constructs
 *     the orchestrator lazily (the `AGENT-PANEL-SECTION` markers must
 *     stay intact).
 *   - app.tsx subscribes to orchestrator events and uses
 *     `orchestrator.list(sessionId)` to build the snapshot.
 *   - The composer-route branch in onSubmit calls `postTeamMessage`
 *     with `LEAD_AGENT_ID` as the sender and the attached agentId as
 *     the recipient.
 *   - ChatScreen mounts <AgentPanel> only when `workers.length > 0`.
 *
 * Drives the actual orchestrator + TeamBus runtime to confirm the
 * envelope shape end-to-end without paying the cost of mounting ink.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentOrchestrator } from '@/agents/orchestrator';
import { LEAD_AGENT_ID } from '@/agents/types';
import type {
  AgentRunner,
  AgentRunnerSpec,
} from '@/agents/orchestrator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_TSX = path.resolve(HERE, '..', '..', 'src', 'app.tsx');
const CHAT_SCREEN_TSX = path.resolve(
  HERE,
  '..',
  '..',
  'src',
  'ui',
  'screens',
  'ChatScreen.tsx',
);

describe('TUI attach flow — source invariants', () => {
  const appSrc = readFileSync(APP_TSX, 'utf8');
  const chatScreenSrc = readFileSync(CHAT_SCREEN_TSX, 'utf8');

  test('app.tsx imports AgentOrchestrator + AgentRow + LEAD_AGENT_ID', () => {
    expect(appSrc).toContain("from '@/agents/orchestrator'");
    expect(appSrc).toContain("LEAD_AGENT_ID");
    expect(appSrc).toContain("from '@/ui/components/AgentPanel'");
  });

  test('app.tsx subscribes to orchestrator events (TUI path)', () => {
    // The subscription effect lives next to the AGENT-PANEL-SECTION
    // marker block so future refactors don't accidentally rip it out.
    expect(appSrc).toContain('AGENT-PANEL-SECTION');
    expect(appSrc).toContain('orch.subscribe(');
    expect(appSrc).toContain('orch.list(sessionId)');
  });

  test('app.tsx routes attached-conversant submissions to TeamBus', () => {
    // The onSubmit attached-worker branch must call postTeamMessage
    // with LEAD_AGENT_ID as the sender (matches the bus contract).
    expect(appSrc).toContain('postTeamMessage(');
    expect(appSrc).toContain("currentConversant !== 'lead'");
    expect(appSrc).toMatch(/postTeamMessage\([\s\S]*LEAD_AGENT_ID/);
  });

  test('ChatScreen mounts <AgentPanel> only when workers > 0', () => {
    // The component MUST short-circuit on empty workers (per the
    // panel's "never unmount mid-session" contract — the parent
    // ChatScreen owns the mount/unmount boundary).
    expect(chatScreenSrc).toContain('<AgentPanel');
    expect(chatScreenSrc).toMatch(
      /agentWorkers[^&]*&&\s*agentWorkers\.length\s*>\s*0/,
    );
  });

  test('Tab handler in ChatScreen guards on workerCount > 0', () => {
    // Without workers the Tab keystroke must fall through (so future
    // Tab-driven features can claim it). The handler block lives
    // inside AGENT-PANEL-SECTION.
    expect(chatScreenSrc).toContain('AGENT-PANEL-SECTION');
    expect(chatScreenSrc).toMatch(/if\s*\(\s*workerCount\s*<=\s*0\s*\)\s*return/);
  });
});

describe('TUI attach flow — runtime envelope', () => {
  /**
   * Spin up a real orchestrator + fake runner, send a team message as
   * if the composer dispatched it, and assert the envelope shape that
   * the worker would see via `team_read`. This confirms the wiring
   * contract: lead → worker unicast with the user's text body.
   */
  test('lead → worker bus message lands with the expected envelope', async () => {
    const fakeRunner: AgentRunner = {
      start: async () => undefined,
      cancel: async () => undefined,
    };
    const orch = new AgentOrchestrator({
      projectRoot: '/tmp/attach-flow-test',
      config: {
        workerModel: 'm',
        maxConcurrent: 5,
        isolation: 'shared',
        approval: 'auto',
        defaultTimeoutSec: 60,
      },
      runnerFactory: (_spec: AgentRunnerSpec) => fakeRunner,
      idGenerator: () => 'w1',
    });

    const parent = 'parent-session';
    await orch.spawn(parent, {
      task: 'do the thing',
      files: [],
      isolation: 'shared',
    });

    const composerText = 'Please refactor lib/foo.ts';
    const envelope = orch.postTeamMessage(parent, LEAD_AGENT_ID, 'w1', composerText);

    expect(envelope.from).toBe(LEAD_AGENT_ID);
    expect(envelope.to).toBe('w1');
    expect(envelope.message).toBe(composerText);
    expect(typeof envelope.at).toBe('number');

    // The worker would consume via `team_read`.
    const inbox = orch.readTeamMessages(parent, 'w1', 0);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.from).toBe(LEAD_AGENT_ID);
    expect(inbox[0]?.message).toBe(composerText);

    await orch.disposeAll();
  });
});
