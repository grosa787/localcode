/**
 * ProjectBar — top-icon row tests.
 *
 * After Wave 8B (RightDock removal), every panel must be reachable via
 * an icon button in ProjectBar. This suite asserts:
 *   1. Each icon button is present (Tasks, Agents, Browser, Memory,
 *      Files, Usage).
 *   2. Clicking each toggles the corresponding store flag.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { useStore } from '../state/store';
import { ProjectBar } from './ProjectBar';

const initialState = useStore.getState();

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignored */
  }
  useStore.setState({
    ...initialState,
    projects: [
      {
        id: 'p1',
        root: '/tmp/proj',
        label: 'proj',
        lastUsedAt: Date.now(),
      },
    ],
    activeProjectId: 'p1',
    sessions: [],
    activeSessionId: null,
    tasksPanelOpen: false,
    agentTeamPanelOpen: false,
    memoryOverlayOpen: false,
  });
});

afterEach(() => {
  useStore.setState({ ...initialState });
});

describe('ProjectBar — top-icon row', () => {
  test('renders the tasks icon button', () => {
    render(<ProjectBar />);
    expect(screen.getByTestId('projectbar-tasks')).not.toBeNull();
  });

  test('renders the agents icon button', () => {
    render(<ProjectBar />);
    expect(screen.getByTestId('projectbar-agents')).not.toBeNull();
  });

  test('renders the browser icon button', () => {
    render(<ProjectBar />);
    expect(screen.getByTestId('projectbar-browser')).not.toBeNull();
  });

  test('renders the memory icon button', () => {
    render(<ProjectBar />);
    expect(screen.getByTestId('projectbar-memory')).not.toBeNull();
  });

  test('renders the files icon button', () => {
    render(<ProjectBar />);
    expect(screen.getByTestId('projectbar-files')).not.toBeNull();
  });

  test('renders the usage icon button', () => {
    render(<ProjectBar />);
    expect(screen.getByTestId('projectbar-usage')).not.toBeNull();
  });
});

describe('ProjectBar — icon button toggles', () => {
  test('Tasks button toggles tasksPanelOpen', () => {
    render(<ProjectBar />);
    expect(useStore.getState().tasksPanelOpen).toBe(false);
    fireEvent.click(screen.getByTestId('projectbar-tasks'));
    expect(useStore.getState().tasksPanelOpen).toBe(true);
    fireEvent.click(screen.getByTestId('projectbar-tasks'));
    expect(useStore.getState().tasksPanelOpen).toBe(false);
  });

  test('Agents button toggles agentTeamPanelOpen', () => {
    render(<ProjectBar />);
    expect(useStore.getState().agentTeamPanelOpen).toBe(false);
    fireEvent.click(screen.getByTestId('projectbar-agents'));
    expect(useStore.getState().agentTeamPanelOpen).toBe(true);
  });

  test('Memory button opens memoryOverlayOpen', () => {
    render(<ProjectBar />);
    expect(useStore.getState().memoryOverlayOpen).toBe(false);
    fireEvent.click(screen.getByTestId('projectbar-memory'));
    expect(useStore.getState().memoryOverlayOpen).toBe(true);
  });

  test('Memory button closes when already open', () => {
    useStore.setState({ memoryOverlayOpen: true });
    render(<ProjectBar />);
    fireEvent.click(screen.getByTestId('projectbar-memory'));
    expect(useStore.getState().memoryOverlayOpen).toBe(false);
  });

  test('Files button toggles fileBrowserOpen', () => {
    render(<ProjectBar />);
    const before = useStore.getState().fileBrowserOpen;
    fireEvent.click(screen.getByTestId('projectbar-files'));
    expect(useStore.getState().fileBrowserOpen).toBe(!before);
  });

  test('Usage button opens usageDashboardOpen', () => {
    render(<ProjectBar />);
    expect(useStore.getState().usageDashboardOpen).toBe(false);
    fireEvent.click(screen.getByTestId('projectbar-usage'));
    expect(useStore.getState().usageDashboardOpen).toBe(true);
  });
});
