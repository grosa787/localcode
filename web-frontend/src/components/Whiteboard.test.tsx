/**
 * Whiteboard — UI behaviour around the lazy tldraw mount.
 *
 * The actual tldraw editor is dynamically imported via React.lazy +
 * Suspense, so we mock the lazy module (`./WhiteboardEditor`) with a
 * tiny stub that synchronously publishes a controllable
 * `WhiteboardEditorHandle`. The tests then drive the toolbar to verify:
 *   - the loading fallback is replaced by the stub when the lazy chunk
 *     resolves,
 *   - clicking "Send to chat" exports a PNG, publishes
 *     `whiteboardPendingImage` into the store, and toasts on success,
 *   - the vision-capability warning fires when the active model is
 *     text-only (the user-facing message also fires, the attachment
 *     still goes through),
 *   - clicking "Send to chat" on an empty canvas surfaces the "nothing
 *     to send" toast and does not publish a pending image.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { WhiteboardEditorHandle } from './Whiteboard';
import type { WhiteboardEditorProps } from './WhiteboardEditor';
import { useStore } from '../state/store';

// In-test override of what the WhiteboardEditor stub's `exportPng` will
// produce. Tests mutate this directly to control "empty canvas" vs
// "real export" branches.
interface ExportFixture {
  base64: string;
  width: number;
  height: number;
  sizeBytes: number;
}
let exportFixture: ExportFixture | null = {
  base64: 'iVBORw0KGgo=',
  width: 320,
  height: 240,
  sizeBytes: 12,
};

// Captured handle so individual tests can simulate a mid-test remount
// (not used yet — kept for future expansion).
let lastPublishedHandle: WhiteboardEditorHandle | null = null;

// Lazy-import target stub. We export a named `WhiteboardEditor` that
// React.lazy resolves to via `.default`, mirroring the production
// shape.
vi.mock('./WhiteboardEditor', () => {
  return {
    WhiteboardEditor: (props: WhiteboardEditorProps) => {
      // Publish a handle on first render so the toolbar buttons enable.
      // We avoid useEffect here to keep the test surface synchronous.
      if (lastPublishedHandle === null) {
        const handle: WhiteboardEditorHandle = {
          clear: vi.fn(),
          undo: vi.fn(),
          redo: vi.fn(),
          selectTool: vi.fn(),
          exportPng: vi.fn(async () => exportFixture),
        };
        lastPublishedHandle = handle;
        // Defer the onMount call to a microtask so render completes
        // first — matches the real component's mount order.
        queueMicrotask(() => props.onMount(handle));
      }
      return null;
    },
  };
});

const initialState = useStore.getState();

beforeEach(() => {
  exportFixture = {
    base64: 'iVBORw0KGgo=',
    width: 320,
    height: 240,
    sizeBytes: 12,
  };
  lastPublishedHandle = null;
  try {
    window.localStorage.clear();
  } catch {
    /* ignored */
  }
  useStore.setState({
    ...initialState,
    whiteboardOpen: true,
    whiteboardPendingImage: null,
    activeBackend: 'openai',
    currentModel: 'gpt-4o',
    toasts: [],
  });
});

afterEach(() => {
  cleanup();
});

async function renderWhiteboard(): Promise<HTMLElement> {
  // Dynamically import so the vi.mock above intercepts the lazy chunk.
  const { Whiteboard } = await import('./Whiteboard');
  const { container } = render(<Whiteboard />);
  // Wait for the lazy chunk + queued microtask to settle.
  await waitFor(() => {
    expect(screen.getByTestId('whiteboard-send')).toBeTruthy();
  });
  // Force the publish microtask to flush so the handle is captured.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('Whiteboard', () => {
  test('renders toolbar + canvas container', async () => {
    await renderWhiteboard();
    expect(screen.getByTestId('whiteboard')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-canvas')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-tool-draw')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-tool-erase')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-tool-undo')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-tool-redo')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-tool-clear')).toBeTruthy();
  });

  test('clicking Send to chat publishes pending image + toasts success', async () => {
    await renderWhiteboard();
    const sendBtn = screen.getByTestId('whiteboard-send');
    await act(async () => {
      fireEvent.click(sendBtn);
      // Drain the async export + state updates.
      await Promise.resolve();
      await Promise.resolve();
    });
    const pending = useStore.getState().whiteboardPendingImage;
    expect(pending).not.toBeNull();
    expect(pending?.base64).toBe('iVBORw0KGgo=');
    expect(pending?.mimeType).toBe('image/png');
    expect(pending?.width).toBe(320);
    expect(pending?.height).toBe(240);
    const toasts = useStore.getState().toasts;
    const success = toasts.find((t) => t.level === 'success');
    expect(success).toBeTruthy();
  });

  test('warns when active model is not vision-capable', async () => {
    useStore.setState((st) => ({
      ...st,
      activeBackend: 'openai',
      currentModel: 'gpt-3.5-turbo',
    }));
    await renderWhiteboard();
    await act(async () => {
      fireEvent.click(screen.getByTestId('whiteboard-send'));
      await Promise.resolve();
      await Promise.resolve();
    });
    const toasts = useStore.getState().toasts;
    const warning = toasts.find((t) => t.level === 'warning');
    expect(warning).toBeTruthy();
    // Send still proceeded — pending image is populated.
    expect(useStore.getState().whiteboardPendingImage).not.toBeNull();
  });

  test('empty canvas → nothing-to-send warning, no pending image', async () => {
    exportFixture = null;
    await renderWhiteboard();
    await act(async () => {
      fireEvent.click(screen.getByTestId('whiteboard-send'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useStore.getState().whiteboardPendingImage).toBeNull();
    const toasts = useStore.getState().toasts;
    const warning = toasts.find(
      (t) => t.level === 'warning' && t.message.includes('empty'),
    );
    expect(warning).toBeTruthy();
  });

  test('Send blocked when no model is selected', async () => {
    useStore.setState((st) => ({
      ...st,
      activeBackend: null,
      currentModel: null,
    }));
    await renderWhiteboard();
    await act(async () => {
      fireEvent.click(screen.getByTestId('whiteboard-send'));
      await Promise.resolve();
    });
    expect(useStore.getState().whiteboardPendingImage).toBeNull();
    const toasts = useStore.getState().toasts;
    const warning = toasts.find(
      (t) => t.level === 'warning' && t.message.toLowerCase().includes('model'),
    );
    expect(warning).toBeTruthy();
  });
});
