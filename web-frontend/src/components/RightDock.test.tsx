/**
 * RightDock — tab switching, reorder via drag, collapse, adaptive
 * overflow (tier classification), keyboard navigation.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import {
  DEFAULT_DOCK_PANEL_IDS,
  DEFAULT_PANEL_LAYOUT,
  useStore,
} from '../state/store';

import {
  RightDock,
  computeTabTier,
  computeVisibleRightDockTabs,
  nextTabIndex,
  reorderAfterDrop,
} from './RightDock';

const initialState = useStore.getState();

// jsdom does not implement ResizeObserver. We install a controllable
// mock that exposes the most recent callback so tests can synthesise
// container-width changes deterministically.
interface MockObserver {
  trigger: (width: number) => void;
}
const observers: MockObserver[] = [];

class FakeResizeObserver {
  private cb: ResizeObserverCallback;
  private target: Element | null = null;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    observers.push({
      trigger: (width: number) => {
        if (this.target === null) return;
        const entry = {
          contentRect: { width, height: 34, top: 0, left: 0, bottom: 34, right: width, x: 0, y: 0, toJSON: () => ({}) } as DOMRectReadOnly,
          target: this.target,
          borderBoxSize: [],
          contentBoxSize: [{ inlineSize: width, blockSize: 34 }],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry;
        this.cb([entry], this as unknown as ResizeObserver);
      },
    });
  }
  observe(target: Element): void {
    this.target = target;
  }
  unobserve(): void {
    this.target = null;
  }
  disconnect(): void {
    this.target = null;
  }
}

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
    rightDockTabOrder: [...DEFAULT_DOCK_PANEL_IDS],
    rightDockCollapsed: false,
    activeRightDockTab: 'tasks',
  });
  observers.length = 0;
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
  // Run requestAnimationFrame callbacks synchronously so tier updates
  // settle within `act()` without test sleeps.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

function triggerStripWidth(width: number): void {
  act(() => {
    for (const obs of observers) obs.trigger(width);
  });
}

describe('computeVisibleRightDockTabs', () => {
  test('filters to right-docked panels respecting saved order', () => {
    const visible = computeVisibleRightDockTabs(
      ['agents', 'tasks', 'browser', 'logs'],
      ['tasks', 'agents', 'browser'],
    );
    expect(visible).toEqual(['agents', 'tasks', 'browser']);
  });

  test('appends right panels missing from order', () => {
    const visible = computeVisibleRightDockTabs(
      ['agents'],
      ['tasks', 'agents'],
    );
    expect(visible).toEqual(['agents', 'tasks']);
  });

  test('drops order ids that are not docked right', () => {
    const visible = computeVisibleRightDockTabs(
      ['tasks', 'agents', 'browser'],
      ['tasks'],
    );
    expect(visible).toEqual(['tasks']);
  });
});

describe('reorderAfterDrop', () => {
  test('moves source before target', () => {
    expect(reorderAfterDrop(['a', 'b', 'c'] as never[], 'c' as never, 'a' as never))
      .toEqual(['c', 'a', 'b']);
  });

  test('noop when source == target', () => {
    expect(reorderAfterDrop(['tasks', 'agents'], 'tasks', 'tasks')).toEqual([
      'tasks',
      'agents',
    ]);
  });

  test('noop when source missing', () => {
    expect(reorderAfterDrop(['tasks'], 'agents', 'tasks')).toEqual(['tasks']);
  });
});

describe('computeTabTier', () => {
  test('comfortable when generous width per tab', () => {
    // 8 tabs × 110px (= 880) + 44 chrome = 924 — round to 1200 just to be safe.
    expect(computeTabTier(1200, 8)).toBe('comfortable');
  });

  test('cramped between icon and comfortable thresholds', () => {
    // 8 tabs at 600 → (600-44)/8 ≈ 69 px/tab → cramped.
    expect(computeTabTier(600, 8)).toBe('cramped');
  });

  test('icon when widths drop below icon threshold', () => {
    // 8 tabs at 200 → (200-44)/8 ≈ 19 px/tab → icon.
    expect(computeTabTier(200, 8)).toBe('icon');
  });

  test('comfortable when no tabs', () => {
    expect(computeTabTier(100, 0)).toBe('comfortable');
  });

  test('comfortable on pre-measurement (zero width)', () => {
    expect(computeTabTier(0, 5)).toBe('comfortable');
  });
});

describe('nextTabIndex', () => {
  test('ArrowRight wraps to start', () => {
    expect(nextTabIndex('ArrowRight', 4, 5)).toBe(0);
  });
  test('ArrowLeft wraps to end', () => {
    expect(nextTabIndex('ArrowLeft', 0, 5)).toBe(4);
  });
  test('Home jumps to 0', () => {
    expect(nextTabIndex('Home', 3, 5)).toBe(0);
  });
  test('End jumps to last', () => {
    expect(nextTabIndex('End', 0, 5)).toBe(4);
  });
  test('ignores unrelated keys', () => {
    expect(nextTabIndex('Enter', 0, 5)).toBeNull();
  });
  test('returns null on empty list', () => {
    expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull();
  });
});

describe('RightDock — rendering', () => {
  test('renders the tabs for right-docked panels', () => {
    render(<RightDock />);
    expect(screen.getByTestId('right-dock')).not.toBeNull();
    expect(screen.getByTestId('right-dock-tab-tasks')).not.toBeNull();
    expect(screen.getByTestId('right-dock-tab-agents')).not.toBeNull();
    expect(screen.getByTestId('right-dock-tab-browser')).not.toBeNull();
  });

  test('clicking a tab switches the active panel', () => {
    render(<RightDock />);
    fireEvent.click(screen.getByTestId('right-dock-tab-agents'));
    expect(useStore.getState().activeRightDockTab).toBe('agents');
    expect(screen.getByTestId('right-dock-body-agents')).not.toBeNull();
  });

  test('collapse button toggles the collapsed state', () => {
    render(<RightDock />);
    const collapseBtn = screen.getByLabelText(/collapse right dock/i);
    fireEvent.click(collapseBtn);
    expect(useStore.getState().rightDockCollapsed).toBe(true);
    expect(screen.queryByTestId('right-dock-body-tasks')).toBeNull();
  });

  test('returns null when no panels are docked right', () => {
    const movePanel = useStore.getState().movePanel;
    for (const def of DEFAULT_PANEL_LAYOUT.panels) {
      if (def.position === 'right') movePanel(def.id, 'hidden');
    }
    const { container } = render(<RightDock />);
    expect(container.querySelector('aside')).toBeNull();
  });
});

describe('RightDock — adaptive tiers', () => {
  test('comfortable tier at 1200px shows labels', () => {
    render(<RightDock />);
    triggerStripWidth(1200);
    const strip = screen.getByTestId('right-dock-strip');
    expect(strip.getAttribute('data-tier')).toBe('comfortable');
    expect(screen.getByTestId('right-dock-tab-tasks').textContent).toContain('Tasks');
    expect(screen.getByTestId('right-dock-tab-memory').textContent).toContain('Memory');
  });

  test('cramped tier at 600px keeps labels and enables overflow', () => {
    render(<RightDock />);
    triggerStripWidth(600);
    const strip = screen.getByTestId('right-dock-strip');
    expect(strip.getAttribute('data-tier')).toBe('cramped');
    const lastTab = screen.getByTestId('right-dock-tab-memory');
    expect(lastTab.textContent).toContain('Memory');
    // Label span exists so text-overflow: ellipsis can take effect.
    const labelSpan = lastTab.querySelector('span:last-child');
    expect(labelSpan).not.toBeNull();
    expect(labelSpan?.textContent).toBe('Memory');
  });

  test('icon tier at 200px hides labels and keeps title + aria-label', () => {
    render(<RightDock />);
    triggerStripWidth(200);
    const strip = screen.getByTestId('right-dock-strip');
    expect(strip.getAttribute('data-tier')).toBe('icon');
    const tab = screen.getByTestId('right-dock-tab-memory');
    // Label span is gone (icon-only mode).
    expect(tab.querySelectorAll('span').length).toBe(1);
    // …but the label is still discoverable for screen readers + tooltip.
    expect(tab.getAttribute('title')).toBe('Memory');
    expect(tab.getAttribute('aria-label')).toBe('Memory');
  });

  test('drag-reorder still works in cramped tier', () => {
    render(<RightDock />);
    triggerStripWidth(600);
    const beforeOrder = useStore.getState().rightDockTabOrder.slice();
    const browser = screen.getByTestId('right-dock-tab-browser');
    const tasks = screen.getByTestId('right-dock-tab-tasks');
    fireEvent.dragStart(browser, {
      dataTransfer: { setData: () => {}, getData: () => 'browser', effectAllowed: '' },
    });
    fireEvent.dragOver(tasks, {
      dataTransfer: { dropEffect: '' },
    });
    fireEvent.drop(tasks, {
      dataTransfer: { getData: () => 'browser' },
    });
    const afterOrder = useStore.getState().rightDockTabOrder;
    expect(afterOrder).not.toEqual(beforeOrder);
    expect(afterOrder.indexOf('browser')).toBeLessThan(afterOrder.indexOf('tasks'));
  });

  test('drag-reorder still works in icon tier', () => {
    render(<RightDock />);
    triggerStripWidth(200);
    const beforeOrder = useStore.getState().rightDockTabOrder.slice();
    const browser = screen.getByTestId('right-dock-tab-browser');
    const tasks = screen.getByTestId('right-dock-tab-tasks');
    fireEvent.dragStart(browser, {
      dataTransfer: { setData: () => {}, getData: () => 'browser', effectAllowed: '' },
    });
    fireEvent.drop(tasks, {
      dataTransfer: { getData: () => 'browser' },
    });
    const afterOrder = useStore.getState().rightDockTabOrder;
    expect(afterOrder.indexOf('browser')).toBeLessThan(afterOrder.indexOf('tasks'));
    expect(afterOrder).not.toEqual(beforeOrder);
  });
});

describe('RightDock — keyboard navigation', () => {
  test('ArrowRight focuses + activates the next tab', () => {
    render(<RightDock />);
    triggerStripWidth(1200);
    const tasks = screen.getByTestId('right-dock-tab-tasks');
    tasks.focus();
    fireEvent.keyDown(tasks, { key: 'ArrowRight' });
    expect(useStore.getState().activeRightDockTab).toBe('agents');
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'right-dock-tab-agents',
    );
  });

  test('ArrowLeft wraps to last', () => {
    render(<RightDock />);
    triggerStripWidth(1200);
    const tasks = screen.getByTestId('right-dock-tab-tasks');
    tasks.focus();
    fireEvent.keyDown(tasks, { key: 'ArrowLeft' });
    // Last visible tab in DEFAULT_DOCK_PANEL_IDS that is right-docked.
    const last = useStore.getState().rightDockTabOrder.filter((id) => {
      const def = useStore
        .getState()
        .panelLayout.panels.find((p) => p.id === id);
      return def?.position === 'right';
    });
    const expected = last[last.length - 1];
    expect(useStore.getState().activeRightDockTab).toBe(expected);
  });

  test('Home jumps to first, End to last', () => {
    render(<RightDock />);
    triggerStripWidth(1200);
    const tasks = screen.getByTestId('right-dock-tab-tasks');
    tasks.focus();
    fireEvent.keyDown(tasks, { key: 'End' });
    const order = useStore.getState().rightDockTabOrder.filter((id) => {
      const def = useStore
        .getState()
        .panelLayout.panels.find((p) => p.id === id);
      return def?.position === 'right';
    });
    expect(useStore.getState().activeRightDockTab).toBe(order[order.length - 1]);
    fireEvent.keyDown(document.activeElement ?? tasks, { key: 'Home' });
    expect(useStore.getState().activeRightDockTab).toBe(order[0]);
  });
});
