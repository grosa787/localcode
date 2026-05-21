/**
 * ProviderChip — auto-flip popover placement when chip lives near
 * the bottom of the viewport (the composer row case).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { useStore } from '../state/store';

import { ProviderChip } from './ProviderChip';

const initialState = useStore.getState();

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
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(performance.now());
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  useStore.setState({
    ...initialState,
    activeBackend: 'anthropic',
    locale: 'en',
  });
});

afterEach(() => {
  cleanup();
  observers.length = 0;
  vi.unstubAllGlobals();
});

describe('ProviderChip popover flip', () => {
  test('opens upward when chip is near the bottom of the viewport', () => {
    // Pretend the chip button lives at y=720 in an 800-tall viewport.
    const origGetClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      // Match the chip button by data-testid; fall back to a generic
      // rect for siblings (the cog).
      const node = this as HTMLElement;
      if (node.dataset?.testid === 'provider-chip-button') {
        return {
          x: 40,
          y: 720,
          width: 80,
          height: 28,
          top: 720,
          bottom: 748,
          left: 40,
          right: 120,
          toJSON: () => undefined,
        } as DOMRect;
      }
      if (node.getAttribute?.('role') === 'dialog') {
        // ProviderPicker root — taller than the gap below, forces flip.
        return {
          x: 40,
          y: 0,
          width: 320,
          height: 200,
          top: 0,
          bottom: 200,
          left: 40,
          right: 360,
          toJSON: () => undefined,
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        toJSON: () => undefined,
      } as DOMRect;
    };

    try {
      const onSwitch = vi.fn(async () => ({
        ok: true as const,
        backend: 'anthropic' as const,
        baseUrl: 'https://api.anthropic.com',
        models: [] as readonly string[],
        currentModel: '',
      }));

      act(() => {
        render(<ProviderChip onSwitch={onSwitch} />);
      });

      // Open the dropdown by clicking the chip.
      act(() => {
        fireEvent.click(screen.getByTestId('provider-chip-button'));
      });

      const popover = screen.getByRole('dialog', { name: /provider/i });
      const style = popover.getAttribute('style') ?? '';
      // Auto-flipped to top → `bottom: calc(100% + Xpx)` should be set.
      expect(style).toMatch(/bottom:\s*calc\(100%\s*\+\s*\d+px\)/);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origGetClientRect;
    }
  });
});
