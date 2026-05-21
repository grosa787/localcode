/**
 * Agent team store slice — pure unit tests for upsertAgent,
 * updateAgentStatus, appendTeamMessage, and auto-open behaviour.
 */

import { beforeEach, describe, expect, test } from 'vitest';

import { useStore, TEAM_MESSAGE_CAP, type AgentNode } from '../state/store';

const initialState = useStore.getState();

beforeEach(() => {
  useStore.setState({
    ...initialState,
    agentTree: {},
    teamMessages: {},
    agentTeamPanelOpen: false,
    agentTeamAutoOpenedFor: [],
  });
});

function makeAgent(overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    agentId: 'a1',
    parentAgentId: null,
    parentSessionId: 's1',
    model: 'anthropic/claude-opus-4',
    task: 'do work',
    ownedFiles: ['src/foo.ts'],
    startedAt: 1_000,
    status: 'running',
    ...overrides,
  };
}

describe('agent team slice', () => {
  test('upsertAgent inserts a new agent under the parent session', () => {
    useStore.getState().upsertAgent(makeAgent());
    const list = useStore.getState().agentTree['s1'];
    expect(list).toBeDefined();
    expect(list).toHaveLength(1);
    expect(list?.[0]?.agentId).toBe('a1');
  });

  test('upsertAgent merges fields when re-upserting the same agentId', () => {
    useStore.getState().upsertAgent(makeAgent());
    useStore.getState().upsertAgent(makeAgent({ task: 'updated task' }));
    const list = useStore.getState().agentTree['s1'];
    expect(list).toHaveLength(1);
    expect(list?.[0]?.task).toBe('updated task');
  });

  test('first agent_spawned auto-opens the panel and records sessionId', () => {
    expect(useStore.getState().agentTeamPanelOpen).toBe(false);
    useStore.getState().upsertAgent(makeAgent());
    expect(useStore.getState().agentTeamPanelOpen).toBe(true);
    expect(useStore.getState().agentTeamAutoOpenedFor).toEqual(['s1']);
  });

  test('subsequent spawns do not re-open after the user closed the panel', () => {
    useStore.getState().upsertAgent(makeAgent({ agentId: 'a1' }));
    useStore.getState().closeAgentTeamPanel();
    useStore.getState().upsertAgent(makeAgent({ agentId: 'a2', startedAt: 2_000 }));
    expect(useStore.getState().agentTeamPanelOpen).toBe(false);
  });

  test('updateAgentStatus mutates the matching node', () => {
    useStore.getState().upsertAgent(makeAgent());
    useStore
      .getState()
      .updateAgentStatus('s1', 'a1', { status: 'done', summary: 'ok' });
    const node = useStore.getState().agentTree['s1']?.[0];
    expect(node?.status).toBe('done');
    expect(node?.summary).toBe('ok');
  });

  test('updateAgentStatus is a no-op when agent is unknown', () => {
    useStore.getState().updateAgentStatus('s1', 'missing', { status: 'failed' });
    expect(useStore.getState().agentTree['s1']).toBeUndefined();
  });

  test('appendTeamMessage records messages keyed by sessionId', () => {
    useStore.getState().appendTeamMessage({
      id: 'm1',
      sessionId: 's1',
      from: 'a1',
      to: 'a2',
      message: 'hello',
      at: 100,
    });
    expect(useStore.getState().teamMessages['s1']).toHaveLength(1);
  });

  test('appendTeamMessage caps history at TEAM_MESSAGE_CAP', () => {
    for (let i = 0; i < TEAM_MESSAGE_CAP + 25; i += 1) {
      useStore.getState().appendTeamMessage({
        id: `m${i}`,
        sessionId: 's1',
        from: 'a1',
        to: 'a2',
        message: String(i),
        at: i,
      });
    }
    const list = useStore.getState().teamMessages['s1'];
    expect(list).toHaveLength(TEAM_MESSAGE_CAP);
    expect(list?.[0]?.id).toBe('m25');
  });

  test('toggleAgentTeamPanel flips the open flag', () => {
    expect(useStore.getState().agentTeamPanelOpen).toBe(false);
    useStore.getState().toggleAgentTeamPanel();
    expect(useStore.getState().agentTeamPanelOpen).toBe(true);
    useStore.getState().toggleAgentTeamPanel();
    expect(useStore.getState().agentTeamPanelOpen).toBe(false);
  });

  test('clearAgentTeam removes tree, messages, and auto-open marker', () => {
    useStore.getState().upsertAgent(makeAgent());
    useStore.getState().appendTeamMessage({
      id: 'm1',
      sessionId: 's1',
      from: 'a1',
      to: 'all',
      message: 'broadcast',
      at: 1,
    });
    useStore.getState().clearAgentTeam('s1');
    expect(useStore.getState().agentTree['s1']).toBeUndefined();
    expect(useStore.getState().teamMessages['s1']).toBeUndefined();
    expect(useStore.getState().agentTeamAutoOpenedFor).toEqual([]);
  });
});
