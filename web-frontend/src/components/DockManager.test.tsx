/**
 * DockManager — drop-zone classification + panelsAtPosition selector +
 * movePanel store integration.
 */

import { beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_PANEL_LAYOUT,
  useStore,
  type DockPanelId,
  type PanelPosition,
} from '../state/store';

import { classifyDropZone, isDockPanelId, panelsAtPosition } from './DockManager';

const initialState = useStore.getState();

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignored */
  }
  useStore.setState({
    ...initialState,
    panelLayout: {
      panels: DEFAULT_PANEL_LAYOUT.panels.map((p) => ({ ...p })),
    },
  });
});

describe('classifyDropZone', () => {
  test('returns left when X within left gutter', () => {
    expect(classifyDropZone(40, 400, 1200, 800)).toBe('left');
  });

  test('returns right when X within right gutter', () => {
    expect(classifyDropZone(1180, 400, 1200, 800)).toBe('right');
  });

  test('returns bottom when Y within bottom gutter', () => {
    expect(classifyDropZone(600, 770, 1200, 800)).toBe('bottom');
  });

  test('returns null in the centre', () => {
    expect(classifyDropZone(600, 400, 1200, 800)).toBeNull();
  });

  test('bottom-corner conflict resolves to bottom (priority rule)', () => {
    expect(classifyDropZone(40, 770, 1200, 800)).toBe('bottom');
    expect(classifyDropZone(1180, 770, 1200, 800)).toBe('bottom');
  });

  test('zero viewport returns null', () => {
    expect(classifyDropZone(40, 40, 0, 0)).toBeNull();
  });
});

describe('panelsAtPosition', () => {
  test('filters panels by position', () => {
    const right = panelsAtPosition(DEFAULT_PANEL_LAYOUT, 'right');
    expect(right).toContain('tasks');
    expect(right).toContain('agents');
    expect(right).toContain('browser');
    expect(right).not.toContain('files');
  });

  test('returns empty array for unused position', () => {
    expect(panelsAtPosition({ panels: [] }, 'right')).toEqual([]);
  });
});

describe('isDockPanelId', () => {
  test('accepts known ids', () => {
    expect(isDockPanelId('tasks')).toBe(true);
    expect(isDockPanelId('files')).toBe(true);
  });

  test('rejects unknown ids', () => {
    expect(isDockPanelId('foo')).toBe(false);
    expect(isDockPanelId('')).toBe(false);
  });
});

describe('movePanel store integration', () => {
  test('moving a panel updates the slice + persists', () => {
    useStore.getState().movePanel('tasks', 'left');
    const tasksEntry = useStore
      .getState()
      .panelLayout.panels.find((p) => p.id === 'tasks');
    expect(tasksEntry?.position).toBe('left');
    expect(panelsAtPosition(useStore.getState().panelLayout, 'left')).toContain(
      'tasks',
    );
  });

  test('moving the same panel twice replaces the position', () => {
    const order: PanelPosition[] = ['left', 'bottom', 'right'];
    const panelId: DockPanelId = 'agents';
    for (const pos of order) {
      useStore.getState().movePanel(panelId, pos);
      const entry = useStore
        .getState()
        .panelLayout.panels.find((p) => p.id === panelId);
      expect(entry?.position).toBe(pos);
    }
  });
});
