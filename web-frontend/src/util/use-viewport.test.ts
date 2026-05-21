/**
 * useViewport — breakpoint resolution + ResizeObserver propagation.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  resolveBreakpoint,
  useViewport,
  useViewportDataAttribute,
  VIEWPORT_BREAKPOINTS,
} from './use-viewport';

/**
 * jsdom ships a working ResizeObserver only in newer versions. We
 * install a controllable stub so we can simulate fires deterministically
 * regardless of the runtime.
 */
type Cb = (entries: ResizeObserverEntry[]) => void;
const observers: Cb[] = [];

class StubResizeObserver {
  private readonly cb: Cb;
  constructor(cb: Cb) {
    this.cb = cb;
    observers.push(cb);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    const idx = observers.indexOf(this.cb);
    if (idx !== -1) observers.splice(idx, 1);
  }
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height,
  });
}

function flushObservers(): void {
  for (const cb of observers.slice()) {
    cb([]);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  (
    globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }
  ).ResizeObserver = StubResizeObserver;
  setViewport(1280, 800);
  observers.length = 0;
  delete document.documentElement.dataset.viewport;
});

afterEach(() => {
  vi.useRealTimers();
  observers.length = 0;
});

describe('resolveBreakpoint', () => {
  test('mobile below 768', () => {
    expect(resolveBreakpoint(0)).toBe('mobile');
    expect(resolveBreakpoint(400)).toBe('mobile');
    expect(resolveBreakpoint(VIEWPORT_BREAKPOINTS.mobile - 1)).toBe('mobile');
  });

  test('tablet 768..1023', () => {
    expect(resolveBreakpoint(VIEWPORT_BREAKPOINTS.mobile)).toBe('tablet');
    expect(resolveBreakpoint(900)).toBe('tablet');
    expect(resolveBreakpoint(VIEWPORT_BREAKPOINTS.tablet - 1)).toBe('tablet');
  });

  test('desktop 1024..1439', () => {
    expect(resolveBreakpoint(VIEWPORT_BREAKPOINTS.tablet)).toBe('desktop');
    expect(resolveBreakpoint(1280)).toBe('desktop');
    expect(resolveBreakpoint(VIEWPORT_BREAKPOINTS.desktop - 1)).toBe('desktop');
  });

  test('wide at and above 1440', () => {
    expect(resolveBreakpoint(VIEWPORT_BREAKPOINTS.desktop)).toBe('wide');
    expect(resolveBreakpoint(2560)).toBe('wide');
  });
});

describe('useViewport — initial read', () => {
  test('returns the current window dimensions on first render', () => {
    setViewport(1280, 800);
    const { result } = renderHook(() => useViewport());
    expect(result.current.width).toBe(1280);
    expect(result.current.height).toBe(800);
    expect(result.current.breakpoint).toBe('desktop');
  });

  test('classifies mobile widths on first render', () => {
    setViewport(600, 800);
    const { result } = renderHook(() => useViewport());
    expect(result.current.breakpoint).toBe('mobile');
  });
});

describe('useViewport — ResizeObserver propagation', () => {
  test('ResizeObserver fires update the returned breakpoint', () => {
    setViewport(1280, 800);
    const { result } = renderHook(() => useViewport());
    expect(result.current.breakpoint).toBe('desktop');

    act(() => {
      setViewport(700, 800);
      flushObservers();
    });
    expect(result.current.breakpoint).toBe('mobile');
    expect(result.current.width).toBe(700);
  });

  test('trailing flush also propagates the final size', () => {
    setViewport(1280, 800);
    const { result } = renderHook(() => useViewport());

    // Burst of resizes — leading apply takes the first, throttled
    // trailing flush picks up the settled value.
    act(() => {
      setViewport(900, 700);
      flushObservers();
    });
    expect(result.current.breakpoint).toBe('tablet');

    act(() => {
      setViewport(500, 700);
      flushObservers();
      vi.advanceTimersByTime(200);
    });
    expect(result.current.breakpoint).toBe('mobile');
  });
});

describe('useViewportDataAttribute', () => {
  test('mirrors the active breakpoint onto <html data-viewport>', () => {
    setViewport(1280, 800);
    const { rerender } = renderHook(() => useViewportDataAttribute());
    expect(document.documentElement.dataset.viewport).toBe('desktop');

    act(() => {
      setViewport(500, 800);
      flushObservers();
    });
    rerender();
    expect(document.documentElement.dataset.viewport).toBe('mobile');
  });
});
