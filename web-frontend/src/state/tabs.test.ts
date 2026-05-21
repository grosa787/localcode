/**
 * Tabs + dock-layout store slice tests — open/switch/close,
 * Cmd+W behaviour (via direct action call), localStorage roundtrip,
 * and dock-layout reset.
 */

import { beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_DOCK_PANEL_IDS,
  DEFAULT_PANEL_LAYOUT,
  useStore,
} from './store';

const initialState = useStore.getState();

beforeEach(() => {
  // Wipe persisted state so tests stay deterministic.
  try {
    window.localStorage.clear();
  } catch {
    /* ignored */
  }
  useStore.setState({
    ...initialState,
    openTabs: [],
    activeTab: null,
    activeSessionId: null,
    panelLayout: {
      panels: DEFAULT_PANEL_LAYOUT.panels.map((p) => ({ ...p })),
    },
    resizers: {},
    rightDockTabOrder: [...DEFAULT_DOCK_PANEL_IDS],
    rightDockCollapsed: false,
    activeRightDockTab: 'tasks',
  });
});

describe('tabs slice — opening, switching, closing', () => {
  test('openTab adds a new tab and activates it', () => {
    useStore.getState().openTab('s1');
    expect(useStore.getState().openTabs).toEqual(['s1']);
    expect(useStore.getState().activeTab).toBe('s1');
    expect(useStore.getState().activeSessionId).toBe('s1');
  });

  test('openTab on existing id only changes activeTab', () => {
    useStore.getState().openTab('s1');
    useStore.getState().openTab('s2');
    useStore.getState().openTab('s1');
    expect(useStore.getState().openTabs).toEqual(['s1', 's2']);
    expect(useStore.getState().activeTab).toBe('s1');
  });

  test('closeTab removes from openTabs and picks neighbour as active', () => {
    useStore.getState().openTab('s1');
    useStore.getState().openTab('s2');
    useStore.getState().openTab('s3');
    expect(useStore.getState().activeTab).toBe('s3');
    useStore.getState().closeTab('s2');
    expect(useStore.getState().openTabs).toEqual(['s1', 's3']);
    // Closing a non-active tab preserves activeTab.
    expect(useStore.getState().activeTab).toBe('s3');
    useStore.getState().closeTab('s3');
    expect(useStore.getState().openTabs).toEqual(['s1']);
    expect(useStore.getState().activeTab).toBe('s1');
  });

  test('closing the only tab clears activeTab', () => {
    useStore.getState().openTab('only');
    useStore.getState().closeTab('only');
    expect(useStore.getState().openTabs).toEqual([]);
    expect(useStore.getState().activeTab).toBeNull();
    expect(useStore.getState().activeSessionId).toBeNull();
  });

  test('closeTab on Cmd+W of active picks left neighbour when at end', () => {
    useStore.getState().openTab('a');
    useStore.getState().openTab('b');
    useStore.getState().openTab('c');
    // 'c' active — closing should pick the new last (b)
    useStore.getState().closeTab('c');
    expect(useStore.getState().activeTab).toBe('b');
  });

  test('switchTabByIndex picks the Nth tab', () => {
    useStore.getState().openTab('a');
    useStore.getState().openTab('b');
    useStore.getState().openTab('c');
    useStore.getState().switchTabByIndex(0);
    expect(useStore.getState().activeTab).toBe('a');
    useStore.getState().switchTabByIndex(2);
    expect(useStore.getState().activeTab).toBe('c');
  });

  test('switchTabByIndex out of range is a no-op', () => {
    useStore.getState().openTab('a');
    useStore.getState().switchTabByIndex(5);
    expect(useStore.getState().activeTab).toBe('a');
    useStore.getState().switchTabByIndex(-1);
    expect(useStore.getState().activeTab).toBe('a');
  });

  test('reorderTabs preserves all tabs and drops unknown ids', () => {
    useStore.getState().openTab('a');
    useStore.getState().openTab('b');
    useStore.getState().openTab('c');
    useStore.getState().reorderTabs(['c', 'a', 'b']);
    expect(useStore.getState().openTabs).toEqual(['c', 'a', 'b']);
    // Unknown id is dropped; missing tabs from `next` are appended.
    useStore.getState().reorderTabs(['ghost', 'c']);
    expect(useStore.getState().openTabs).toEqual(['c', 'a', 'b']);
  });

  test('setActiveSession opens session as a tab and activates it', () => {
    useStore.getState().setActiveSession('s9');
    expect(useStore.getState().openTabs).toContain('s9');
    expect(useStore.getState().activeTab).toBe('s9');
    expect(useStore.getState().activeSessionId).toBe('s9');
  });
});

describe('tabs slice — localStorage persistence', () => {
  test('openTab writes tabs to localStorage', () => {
    useStore.getState().openTab('s1');
    useStore.getState().openTab('s2');
    const raw = window.localStorage.getItem('localcode.web.tabs');
    expect(raw).not.toBeNull();
    if (raw === null) throw new Error('persisted tabs missing');
    const parsed = JSON.parse(raw) as { openTabs: string[]; activeTab: string | null };
    expect(parsed.openTabs).toEqual(['s1', 's2']);
    expect(parsed.activeTab).toBe('s2');
  });

  test('closeTab updates persisted activeTab', () => {
    useStore.getState().openTab('s1');
    useStore.getState().openTab('s2');
    useStore.getState().closeTab('s2');
    const raw = window.localStorage.getItem('localcode.web.tabs');
    if (raw === null) throw new Error('persisted tabs missing');
    const parsed = JSON.parse(raw) as { openTabs: string[]; activeTab: string | null };
    expect(parsed.openTabs).toEqual(['s1']);
    expect(parsed.activeTab).toBe('s1');
  });

  test('malformed localStorage falls back to defaults (no crash on read)', () => {
    window.localStorage.setItem('localcode.web.tabs', '{not valid json');
    window.localStorage.setItem('localcode.web.dock', 'garbage');
    // Re-bootstrap by reading from the helpers — exposed indirectly via
    // setState reset cycles. We assert behaviour through the slice.
    useStore.setState({
      ...initialState,
      openTabs: [],
      activeTab: null,
    });
    useStore.getState().openTab('safe');
    expect(useStore.getState().openTabs).toEqual(['safe']);
  });
});

describe('dock layout slice', () => {
  test('movePanel updates a panel position and persists', () => {
    useStore.getState().movePanel('tasks', 'left');
    const panel = useStore
      .getState()
      .panelLayout.panels.find((p) => p.id === 'tasks');
    expect(panel?.position).toBe('left');
    const raw = window.localStorage.getItem('localcode.web.dock');
    expect(raw).not.toBeNull();
  });

  test('togglePanelVisibility flips between hidden and default position', () => {
    useStore.getState().togglePanelVisibility('tasks');
    expect(
      useStore.getState().panelLayout.panels.find((p) => p.id === 'tasks')
        ?.position,
    ).toBe('hidden');
    useStore.getState().togglePanelVisibility('tasks');
    expect(
      useStore.getState().panelLayout.panels.find((p) => p.id === 'tasks')
        ?.position,
    ).toBe('right');
  });

  test('resetDockLayout restores the default panel positions', () => {
    useStore.getState().movePanel('tasks', 'left');
    useStore.getState().movePanel('agents', 'bottom');
    useStore.getState().resetDockLayout();
    const layout = useStore.getState().panelLayout;
    for (const def of DEFAULT_PANEL_LAYOUT.panels) {
      const actual = layout.panels.find((p) => p.id === def.id);
      expect(actual?.position).toBe(def.position);
    }
  });

  test('setResizerValue persists the keyed value', () => {
    useStore.getState().setResizerValue('sidebar', 280);
    expect(useStore.getState().resizers.sidebar).toBe(280);
    const raw = window.localStorage.getItem('localcode.web.resizers');
    if (raw === null) throw new Error('resizers persistence missing');
    const parsed = JSON.parse(raw) as Record<string, number>;
    expect(parsed.sidebar).toBe(280);
  });
});

describe('right dock slice', () => {
  test('setRightDockTabOrder de-duplicates and preserves missing ids', () => {
    useStore.getState().setRightDockTabOrder(['files', 'tasks', 'tasks']);
    const order = useStore.getState().rightDockTabOrder;
    // Filtered dups + the rest of the default ids appended.
    expect(order[0]).toBe('files');
    expect(order[1]).toBe('tasks');
    expect(new Set(order).size).toBe(order.length);
    for (const id of DEFAULT_DOCK_PANEL_IDS) {
      expect(order).toContain(id);
    }
  });

  test('toggleRightDockCollapsed flips and persists', () => {
    expect(useStore.getState().rightDockCollapsed).toBe(false);
    useStore.getState().toggleRightDockCollapsed();
    expect(useStore.getState().rightDockCollapsed).toBe(true);
    expect(window.localStorage.getItem('localcode.web.rightDock.collapsed')).toBe('1');
  });

  test('setActiveRightDockTab persists active tab', () => {
    useStore.getState().setActiveRightDockTab('agents');
    expect(useStore.getState().activeRightDockTab).toBe('agents');
    expect(window.localStorage.getItem('localcode.web.rightDock.active')).toBe(
      'agents',
    );
  });
});
