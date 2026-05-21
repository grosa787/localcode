/**
 * Whiteboard store slice — open/close/toggle + pending-image plumbing
 * + dock-layout side effects (a hidden whiteboard panel is restored to
 * the right dock when `openWhiteboard` runs).
 */

import { beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_DOCK_PANEL_IDS,
  DEFAULT_PANEL_LAYOUT,
  useStore,
  type WhiteboardPendingImage,
} from './store';

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
    rightDockTabOrder: [...DEFAULT_DOCK_PANEL_IDS],
    rightDockCollapsed: false,
    activeRightDockTab: 'tasks',
    whiteboardOpen: false,
    whiteboardPendingImage: null,
  });
});

describe('whiteboard slice — open/close/toggle', () => {
  test('default whiteboardOpen is false', () => {
    expect(useStore.getState().whiteboardOpen).toBe(false);
  });

  test('openWhiteboard sets open + active right-dock tab', () => {
    useStore.getState().openWhiteboard();
    const st = useStore.getState();
    expect(st.whiteboardOpen).toBe(true);
    expect(st.activeRightDockTab).toBe('whiteboard');
  });

  test('closeWhiteboard sets open to false', () => {
    useStore.getState().openWhiteboard();
    useStore.getState().closeWhiteboard();
    expect(useStore.getState().whiteboardOpen).toBe(false);
  });

  test('toggleWhiteboard flips state and activates the tab', () => {
    useStore.getState().toggleWhiteboard();
    expect(useStore.getState().whiteboardOpen).toBe(true);
    expect(useStore.getState().activeRightDockTab).toBe('whiteboard');
    useStore.getState().toggleWhiteboard();
    expect(useStore.getState().whiteboardOpen).toBe(false);
  });

  test('openWhiteboard restores the panel to the right dock when hidden', () => {
    // Hide the whiteboard panel first.
    useStore.getState().movePanel('whiteboard', 'hidden');
    expect(
      useStore
        .getState()
        .panelLayout.panels.find((p) => p.id === 'whiteboard')?.position,
    ).toBe('hidden');
    useStore.getState().openWhiteboard();
    expect(
      useStore
        .getState()
        .panelLayout.panels.find((p) => p.id === 'whiteboard')?.position,
    ).toBe('right');
  });

  test('openWhiteboard creates the panel entry if it was missing', () => {
    useStore.setState((st) => ({
      ...st,
      panelLayout: { panels: st.panelLayout.panels.filter((p) => p.id !== 'whiteboard') },
    }));
    useStore.getState().openWhiteboard();
    const entry = useStore
      .getState()
      .panelLayout.panels.find((p) => p.id === 'whiteboard');
    expect(entry).toBeDefined();
    expect(entry?.position).toBe('right');
  });
});

describe('whiteboard slice — pending image plumbing', () => {
  test('setWhiteboardPendingImage publishes + clears the slot', () => {
    const img: WhiteboardPendingImage = {
      base64: 'aGVsbG8=',
      mimeType: 'image/png',
      width: 100,
      height: 50,
      sizeBytes: 5,
      name: 'doodle.png',
    };
    useStore.getState().setWhiteboardPendingImage(img);
    expect(useStore.getState().whiteboardPendingImage).toEqual(img);
    useStore.getState().setWhiteboardPendingImage(null);
    expect(useStore.getState().whiteboardPendingImage).toBeNull();
  });
});
