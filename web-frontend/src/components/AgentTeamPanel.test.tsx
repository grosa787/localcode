/**
 * AgentTeamPanel — AGENT-LIFECYCLE-SECTION coverage.
 *
 *   - Completed agents are hidden by default; the toggle reveals them.
 *   - Clicking the Reply chip on a running agent enters reply-mode and
 *     dispatches `enterAgentReply` in the store.
 *   - The active reply target renders the "× Exit" chip and clicking
 *     it clears the store.
 *   - The reply button is hidden for terminated agents.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { useStore, type AgentNode } from '../state/store';
import { AgentTeamPanel } from './AgentTeamPanel';

const initialState = useStore.getState();

function makeAgent(overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    agentId: 'agentXY1',
    parentAgentId: null,
    parentSessionId: 's1',
    model: 'anthropic/claude-opus-4',
    task: 'do work',
    ownedFiles: ['src/foo.ts'],
    startedAt: Date.now(),
    status: 'running',
    ...overrides,
  };
}

beforeEach(() => {
  useStore.setState({
    ...initialState,
    agentTree: {},
    teamMessages: {},
    agentTeamPanelOpen: true,
    agentTeamAutoOpenedFor: [],
    agentReplyTarget: null,
    activeSessionId: 's1',
  });
});

afterEach(() => {
  useStore.setState({ ...initialState });
});

describe('AgentTeamPanel — completed-agent filter', () => {
  test('completed agents are hidden by default', () => {
    useStore.setState({
      agentTree: {
        s1: [
          makeAgent({ agentId: 'live-001' }),
          makeAgent({ agentId: 'done-002', status: 'done' }),
          makeAgent({ agentId: 'fail-003', status: 'failed' }),
        ],
      },
    });
    render(<AgentTeamPanel />);
    expect(document.body.textContent).toContain('live-001');
    expect(document.body.textContent).not.toContain('done-002');
    expect(document.body.textContent).not.toContain('fail-003');
  });

  test('toggling "Show completed" reveals terminated agents', () => {
    useStore.setState({
      agentTree: {
        s1: [
          makeAgent({ agentId: 'live-001' }),
          makeAgent({ agentId: 'done-002', status: 'done' }),
        ],
      },
    });
    render(<AgentTeamPanel />);
    expect(document.body.textContent).not.toContain('done-002');
    const checkbox = screen.getByTestId('agent-team-show-completed');
    act(() => {
      fireEvent.click(checkbox);
    });
    expect(document.body.textContent).toContain('done-002');
  });

  test('hidden completed count badge appears when toggle is off', () => {
    useStore.setState({
      agentTree: {
        s1: [
          makeAgent({ agentId: 'live-001' }),
          makeAgent({ agentId: 'done-002', status: 'done' }),
          makeAgent({ agentId: 'fail-003', status: 'failed' }),
        ],
      },
    });
    render(<AgentTeamPanel />);
    // The badge text is `+2` for the two hidden terminal rows.
    expect(document.body.textContent).toMatch(/\+2/);
  });

  test('hidden count disappears when all completed are revealed', () => {
    useStore.setState({
      agentTree: {
        s1: [
          makeAgent({ agentId: 'live-001' }),
          makeAgent({ agentId: 'done-002', status: 'done' }),
        ],
      },
    });
    render(<AgentTeamPanel />);
    expect(document.body.textContent).toMatch(/\+1/);
    act(() => {
      fireEvent.click(screen.getByTestId('agent-team-show-completed'));
    });
    expect(document.body.textContent ?? '').not.toMatch(/\+1\b/);
  });
});

describe('AgentTeamPanel — reply mode', () => {
  test('clicking Reply on a running agent enters reply-mode in the store', () => {
    useStore.setState({
      agentTree: { s1: [makeAgent({ agentId: 'live-001' })] },
    });
    render(<AgentTeamPanel />);
    const replyBtn = screen.getByTestId('agent-row-reply-live-001');
    act(() => {
      fireEvent.click(replyBtn);
    });
    const target = useStore.getState().agentReplyTarget;
    expect(target).not.toBeNull();
    expect(target?.agentId).toBe('live-001');
    expect(target?.parentSessionId).toBe('s1');
  });

  test('active reply target shows the × exit chip; clicking it clears state', () => {
    useStore.setState({
      agentTree: { s1: [makeAgent({ agentId: 'live-001' })] },
      agentReplyTarget: {
        parentSessionId: 's1',
        agentId: 'live-001',
        label: 'live-001',
      },
    });
    render(<AgentTeamPanel />);
    const exitBtn = screen.getByTestId('agent-row-exit-reply-live-001');
    act(() => {
      fireEvent.click(exitBtn);
    });
    expect(useStore.getState().agentReplyTarget).toBeNull();
  });

  test('terminated agent does not surface the Reply button', () => {
    useStore.setState({
      agentTree: { s1: [makeAgent({ agentId: 'done-002', status: 'done' })] },
    });
    render(<AgentTeamPanel />);
    // Reveal completed agents so the row is mounted.
    act(() => {
      fireEvent.click(screen.getByTestId('agent-team-show-completed'));
    });
    expect(screen.queryByTestId('agent-row-reply-done-002')).toBeNull();
  });
});
