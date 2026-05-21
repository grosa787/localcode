/**
 * Composer — AGENT-REPLY-SECTION routing contract.
 *
 * The full Composer mount depends on the ApiClients context which is
 * intentionally not exported (mirrors Composer.queue.test.tsx +
 * Composer.dragdrop.test.tsx). We pin the contract by static source
 * inspection and by exercising the store's reply-mode actions
 * directly (the store is the single source of truth for the on/off
 * flag the Composer reads).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, test } from 'vitest';

import { useStore } from '../state/store';

const composerSource = readFileSync(
  resolve(__dirname, 'Composer.tsx'),
  'utf8',
);

const chatViewSource = readFileSync(
  resolve(__dirname, 'ChatView.tsx'),
  'utf8',
);

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState({ ...initialState, agentReplyTarget: null });
});

describe('Composer source — AGENT-REPLY-SECTION', () => {
  test('source contains the AGENT-REPLY-SECTION markers', () => {
    expect(composerSource).toMatch(/AGENT-REPLY-SECTION/);
    expect(composerSource).toMatch(/\/AGENT-REPLY-SECTION/);
  });

  test('reply-mode header renders only when agentReply is non-null', () => {
    // The header conditional must short-circuit when no target is set so
    // we don't render an empty banner.
    expect(composerSource).toMatch(
      /props\.agentReply\s*!==\s*undefined\s*&&\s*props\.agentReply\s*!==\s*null/,
    );
    expect(composerSource).toMatch(/composer-agent-reply-header/);
    expect(composerSource).toMatch(/composer-agent-reply-exit/);
  });

  test('submit routes to agentReply.onAgentReply, NOT props.onSend', () => {
    // The branch must fire BEFORE the queue/onSend paths so reply mode
    // pre-empts both. Spot-check the early-return.
    expect(composerSource).toMatch(
      /props\.agentReply\s*!==\s*undefined\s*&&\s*props\.agentReply\s*!==\s*null/,
    );
    expect(composerSource).toMatch(/props\.agentReply\.onAgentReply\(text\)/);
  });
});

describe('ChatView source — agentReply wiring', () => {
  test('ChatView passes agentReply prop to <Composer>', () => {
    expect(chatViewSource).toMatch(/agentReply=\{agentReplyComposerProps\}/);
  });

  test('agentReplyComposerProps sends relay_to_agent over WS', () => {
    expect(chatViewSource).toMatch(/type:\s*['"]relay_to_agent['"]/);
    expect(chatViewSource).toMatch(/agentId:\s*agentReplyTarget\.agentId/);
  });

  test('agentReplyComposerProps wires the store exit action', () => {
    expect(chatViewSource).toMatch(/exitAgentReply/);
  });
});

describe('store — reply-mode actions', () => {
  test('enterAgentReply sets the target', () => {
    useStore.getState().enterAgentReply({
      parentSessionId: 's1',
      agentId: 'a1',
      label: 'a1',
    });
    const t = useStore.getState().agentReplyTarget;
    expect(t).not.toBeNull();
    expect(t?.agentId).toBe('a1');
    expect(t?.parentSessionId).toBe('s1');
  });

  test('exitAgentReply clears the target', () => {
    useStore.getState().enterAgentReply({
      parentSessionId: 's1',
      agentId: 'a1',
      label: 'a1',
    });
    useStore.getState().exitAgentReply();
    expect(useStore.getState().agentReplyTarget).toBeNull();
  });

  test('updateAgentStatus to a terminal status clears matching reply target', () => {
    // Seed an agent and a matching reply target.
    useStore.getState().upsertAgent({
      agentId: 'a1',
      parentAgentId: null,
      parentSessionId: 's1',
      model: 'm',
      task: 't',
      ownedFiles: [],
      startedAt: 0,
      status: 'running',
    });
    useStore.getState().enterAgentReply({
      parentSessionId: 's1',
      agentId: 'a1',
      label: 'a1',
    });
    expect(useStore.getState().agentReplyTarget).not.toBeNull();

    useStore.getState().updateAgentStatus('s1', 'a1', { status: 'done' });
    expect(useStore.getState().agentReplyTarget).toBeNull();
  });

  test('updateAgentStatus on a different agent leaves reply target intact', () => {
    useStore.getState().upsertAgent({
      agentId: 'a1',
      parentAgentId: null,
      parentSessionId: 's1',
      model: 'm',
      task: 't',
      ownedFiles: [],
      startedAt: 0,
      status: 'running',
    });
    useStore.getState().upsertAgent({
      agentId: 'a2',
      parentAgentId: null,
      parentSessionId: 's1',
      model: 'm',
      task: 't',
      ownedFiles: [],
      startedAt: 0,
      status: 'running',
    });
    useStore.getState().enterAgentReply({
      parentSessionId: 's1',
      agentId: 'a1',
      label: 'a1',
    });

    useStore.getState().updateAgentStatus('s1', 'a2', { status: 'done' });
    const t = useStore.getState().agentReplyTarget;
    expect(t?.agentId).toBe('a1');
  });
});
