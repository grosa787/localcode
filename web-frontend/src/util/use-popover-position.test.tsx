/**
 * usePopoverPosition — geometry resolver + the React hook wiring.
 *
 * The pure resolver is verified directly (no DOM). The hook test
 * mounts a tiny harness that exposes the resolved placement so we
 * can assert the side flip + style output against mocked
 * `getBoundingClientRect` values.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect, useRef } from 'react';

import {
  buildPopoverStyle,
  resolvePopoverPlacement,
  usePopoverPosition,
} from './use-popover-position';

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
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

beforeEach(() => {
  (
    globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }
  ).ResizeObserver = StubResizeObserver;
  observers.length = 0;
  setViewport(1280, 800);
  // requestAnimationFrame in jsdom defaults to setTimeout(16) — we
  // run it synchronously to keep tests deterministic.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(performance.now());
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  cleanup();
  observers.length = 0;
  vi.unstubAllGlobals();
});

describe('resolvePopoverPlacement', () => {
  test('keeps preferred side when there is room', () => {
    const out = resolvePopoverPlacement({
      anchor: { top: 100, bottom: 128, left: 40, right: 100 },
      popover: { width: 220, height: 200 },
      viewport: { width: 1280, height: 800 },
      preferredSide: 'bottom',
      gap: 6,
    });
    expect(out.side).toBe('bottom');
    expect(out.align).toBe('start');
  });

  test('flips bottom→top when there is no room below (composer-at-bottom case)', () => {
    // Anchor is the composer chip near the bottom of the screen.
    const out = resolvePopoverPlacement({
      anchor: { top: 720, bottom: 748, left: 40, right: 120 },
      popover: { width: 220, height: 200 },
      viewport: { width: 1280, height: 800 },
      preferredSide: 'bottom',
      gap: 6,
    });
    expect(out.side).toBe('top');
  });

  test('flips top→bottom when there is no room above', () => {
    const out = resolvePopoverPlacement({
      anchor: { top: 8, bottom: 36, left: 40, right: 120 },
      popover: { width: 220, height: 200 },
      viewport: { width: 1280, height: 800 },
      preferredSide: 'top',
      gap: 6,
    });
    expect(out.side).toBe('bottom');
  });

  test('side=top respected when there is room above', () => {
    const out = resolvePopoverPlacement({
      anchor: { top: 720, bottom: 748, left: 40, right: 120 },
      popover: { width: 220, height: 200 },
      viewport: { width: 1280, height: 800 },
      preferredSide: 'top',
      gap: 6,
    });
    expect(out.side).toBe('top');
  });

  test('flips horizontal to end-align when popover would overflow right edge', () => {
    const out = resolvePopoverPlacement({
      anchor: { top: 720, bottom: 748, left: 1180, right: 1240 },
      popover: { width: 320, height: 200 },
      viewport: { width: 1280, height: 800 },
      preferredSide: 'top',
      gap: 6,
    });
    expect(out.align).toBe('end');
  });

  test('falls back to 240px estimate when popover not yet measured', () => {
    const out = resolvePopoverPlacement({
      anchor: { top: 720, bottom: 748, left: 40, right: 120 },
      popover: null,
      viewport: { width: 1280, height: 800 },
      preferredSide: 'bottom',
      gap: 6,
    });
    // 800 - 748 - 6 = 46px below → estimated 240px doesn't fit → flip.
    expect(out.side).toBe('top');
  });

  test('80px below, 200px popover → top; 500px below → bottom', () => {
    // First scenario from the task spec.
    const tight = resolvePopoverPlacement({
      anchor: { top: 514, bottom: 514, left: 40, right: 120 },
      popover: { width: 220, height: 200 },
      viewport: { width: 1280, height: 600 },
      preferredSide: 'bottom',
      gap: 6,
    });
    expect(tight.side).toBe('top');

    const roomy = resolvePopoverPlacement({
      anchor: { top: 94, bottom: 94, left: 40, right: 120 },
      popover: { width: 220, height: 200 },
      viewport: { width: 1280, height: 600 },
      preferredSide: 'bottom',
      gap: 6,
    });
    expect(roomy.side).toBe('bottom');
  });
});

describe('buildPopoverStyle', () => {
  test('top + start anchors via bottom+left', () => {
    const s = buildPopoverStyle('top', 'start', 6);
    expect(s.bottom).toBe('calc(100% + 6px)');
    expect(s.top).toBe('auto');
    expect(s.left).toBe(0);
    expect(s.right).toBe('auto');
  });

  test('bottom + end anchors via top+right', () => {
    const s = buildPopoverStyle('bottom', 'end', 8);
    expect(s.top).toBe('calc(100% + 8px)');
    expect(s.bottom).toBe('auto');
    expect(s.right).toBe(0);
    expect(s.left).toBe('auto');
  });
});

interface HarnessProps {
  open: boolean;
  anchorRect: DOMRectInit;
  popoverRect: DOMRectInit;
  preferredSide: 'top' | 'bottom';
  onPlacement: (style: React.CSSProperties, side: 'top' | 'bottom') => void;
}

function buildRect(init: DOMRectInit): DOMRect {
  const x = init.x ?? 0;
  const y = init.y ?? 0;
  const width = init.width ?? 0;
  const height = init.height ?? 0;
  return {
    x,
    y,
    width,
    height,
    top: y,
    bottom: y + height,
    left: x,
    right: x + width,
    toJSON: () => undefined,
  } as DOMRect;
}

function PlacementHarness(props: HarnessProps): JSX.Element {
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Stub getBoundingClientRect via Object.defineProperty on the
  // element prototype is intrusive; instead we set it on the node
  // each render (the hook measures lazily via rAF after refs
  // attach, so this lands in time).
  useEffect(() => {
    const a = anchorRef.current;
    if (a !== null) {
      a.getBoundingClientRect = () => buildRect(props.anchorRect);
    }
    const p = popoverRef.current;
    if (p !== null) {
      p.getBoundingClientRect = () => buildRect(props.popoverRect);
    }
  });

  const placement = usePopoverPosition({
    anchorRef,
    popoverRef,
    preferredSide: props.preferredSide,
    open: props.open,
    gap: 6,
  });

  // Report every placement so the test sees the post-measurement
  // value, not the initial preferred-side default.
  useEffect(() => {
    props.onPlacement(placement.style, placement.side);
  }, [placement.style, placement.side, props]);

  return (
    <div style={{ position: 'relative' }}>
      <div ref={anchorRef}>anchor</div>
      {props.open ? (
        <div ref={popoverRef} style={placement.style} data-testid="popover">
          content
        </div>
      ) : null}
    </div>
  );
}

describe('usePopoverPosition (hook)', () => {
  test('flips to top when space below is short', () => {
    setViewport(1280, 800);
    let lastSide: 'top' | 'bottom' = 'bottom';
    let lastStyle: React.CSSProperties = {};
    act(() => {
      render(
        <PlacementHarness
          open
          anchorRect={{ x: 40, y: 720, width: 80, height: 28 }}
          popoverRect={{ x: 0, y: 0, width: 220, height: 200 }}
          preferredSide="bottom"
          onPlacement={(style, side) => {
            lastSide = side;
            lastStyle = style;
          }}
        />,
      );
    });
    expect(lastSide).toBe('top');
    expect(lastStyle.bottom).toBe('calc(100% + 6px)');
  });

  test('keeps preferred top when there is room above', () => {
    setViewport(1280, 800);
    let lastSide: 'top' | 'bottom' = 'bottom';
    act(() => {
      render(
        <PlacementHarness
          open
          anchorRect={{ x: 40, y: 720, width: 80, height: 28 }}
          popoverRect={{ x: 0, y: 0, width: 220, height: 200 }}
          preferredSide="top"
          onPlacement={(_style, side) => {
            lastSide = side;
          }}
        />,
      );
    });
    expect(lastSide).toBe('top');
  });
});
