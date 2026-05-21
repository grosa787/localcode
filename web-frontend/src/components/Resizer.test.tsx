/**
 * Resizer — drag start/move/end + persistence + pure helpers.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { JSX } from 'react';

import { useStore } from '../state/store';

import { Resizer, clampResizeValue, computeDraggedValue } from './Resizer';

/**
 * JSDOM strips `clientX`, `clientY`, and `pointerId` from PointerEvent
 * init dicts, so `fireEvent.pointerDown(node, { clientX: 200 })` reaches
 * the handler as `e.clientX === undefined`. We dispatch native events
 * directly with the fields force-set via `Object.defineProperty`, which
 * is what react-testing-library does internally for `MouseEvent` but
 * misses for `PointerEvent` in this jsdom version.
 */
/**
 * Dispatches pointer events via RTL's `fireEvent` (so React picks them
 * up correctly) and then re-asserts the `clientX/Y/pointerId` fields
 * onto the synthetic event so the handler sees the right coordinates.
 * Done in two steps because JSDOM's PointerEvent constructor drops
 * these fields silently.
 */
function firePointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  target: Element,
  init: { clientX: number; clientY: number; pointerId?: number },
): void {
  // Wrap a one-shot listener to mutate the event before React's
  // delegated listener at the root sees it. The listener runs at the
  // capture phase on the target's owner document so it always fires
  // before React's bubble-phase root listener.
  const onCapture = (ev: Event): void => {
    Object.defineProperty(ev, 'clientX', {
      value: init.clientX,
      configurable: true,
    });
    Object.defineProperty(ev, 'clientY', {
      value: init.clientY,
      configurable: true,
    });
    Object.defineProperty(ev, 'pointerId', {
      value: init.pointerId ?? 1,
      configurable: true,
    });
  };
  document.addEventListener(type, onCapture, { capture: true, once: true });
  try {
    switch (type) {
      case 'pointerdown':
        fireEvent.pointerDown(target);
        break;
      case 'pointermove':
        fireEvent.pointerMove(target);
        break;
      case 'pointerup':
        fireEvent.pointerUp(target);
        break;
      case 'pointercancel':
        fireEvent.pointerCancel(target);
        break;
    }
  } finally {
    document.removeEventListener(type, onCapture, { capture: true });
  }
}

const initialState = useStore.getState();

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignored */
  }
  useStore.setState({ ...initialState, resizers: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Resizer — pure helpers', () => {
  test('clampResizeValue bounds within min/max', () => {
    expect(clampResizeValue(-10, 0, 100)).toBe(0);
    expect(clampResizeValue(250, 0, 100)).toBe(100);
    expect(clampResizeValue(50, 0, 100)).toBe(50);
    expect(clampResizeValue(Number.NaN, 0, 100)).toBe(0);
  });

  test('computeDraggedValue handles before/after growth', () => {
    expect(computeDraggedValue(100, 25, 'before', 50, 400)).toBe(125);
    expect(computeDraggedValue(100, 25, 'after', 50, 400)).toBe(75);
    expect(computeDraggedValue(100, 10000, 'before', 50, 400)).toBe(400);
    expect(computeDraggedValue(100, -10000, 'before', 50, 400)).toBe(50);
  });
});

interface HarnessProps {
  initial: number;
  min: number;
  max: number;
  growth?: 'before' | 'after';
  direction?: 'horizontal' | 'vertical';
}

function Harness({
  initial,
  min,
  max,
  growth = 'before',
  direction = 'horizontal',
}: HarnessProps): JSX.Element {
  const [v, setV] = useState(initial);
  return (
    <>
      <div data-testid="value">{v}</div>
      <Resizer
        persistKey="sidebar-test"
        value={v}
        onResize={setV}
        direction={direction}
        min={min}
        max={max}
        growth={growth}
      />
    </>
  );
}

describe('Resizer — drag interaction', () => {
  test('dragging horizontally updates the value', () => {
    render(<Harness initial={200} min={120} max={400} />);
    const handle = screen.getByTestId('resizer-sidebar-test');
    firePointer('pointerdown', handle, { clientX: 200, clientY: 0 });
    firePointer('pointermove', handle, { clientX: 260, clientY: 0 });
    expect(screen.getByTestId('value').textContent).toBe('260');
    firePointer('pointerup', handle, { clientX: 260, clientY: 0 });
    // Persistence: store's resizers map should hold the released value.
    expect(useStore.getState().resizers['sidebar-test']).toBe(260);
  });

  test('drag clamps to max', () => {
    render(<Harness initial={300} min={100} max={400} />);
    const handle = screen.getByTestId('resizer-sidebar-test');
    firePointer('pointerdown', handle, { clientX: 300, clientY: 0 });
    firePointer('pointermove', handle, { clientX: 999, clientY: 0 });
    expect(screen.getByTestId('value').textContent).toBe('400');
    firePointer('pointerup', handle, { clientX: 999, clientY: 0 });
    expect(useStore.getState().resizers['sidebar-test']).toBe(400);
  });

  test('growth=after inverts the drag direction', () => {
    render(<Harness initial={300} min={120} max={500} growth="after" />);
    const handle = screen.getByTestId('resizer-sidebar-test');
    firePointer('pointerdown', handle, { clientX: 300, clientY: 0 });
    // Drag right; growth=after means the value should decrease.
    firePointer('pointermove', handle, { clientX: 360, clientY: 0 });
    expect(screen.getByTestId('value').textContent).toBe('240');
  });

  test('vertical resizer reads Y coordinate', () => {
    render(
      <Harness initial={200} min={100} max={400} direction="vertical" />,
    );
    const handle = screen.getByTestId('resizer-sidebar-test');
    firePointer('pointerdown', handle, { clientX: 0, clientY: 200 });
    firePointer('pointermove', handle, { clientX: 0, clientY: 250 });
    expect(screen.getByTestId('value').textContent).toBe('250');
  });

  test('ArrowRight nudges the value and persists', () => {
    render(<Harness initial={200} min={100} max={400} />);
    const handle = screen.getByTestId('resizer-sidebar-test');
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(screen.getByTestId('value').textContent).toBe('208');
    expect(useStore.getState().resizers['sidebar-test']).toBe(208);
  });
});
