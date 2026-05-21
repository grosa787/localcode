/**
 * useResizeObserver — measure an element's content-box width/height and
 * re-render the caller when it changes.
 *
 * Returns `[ref, size]`. Attach `ref` to the element you want measured.
 * `size` is `null` until the first observation arrives, then `{ width,
 * height }` in CSS pixels.
 *
 * Notes:
 *   - SSR safe: when `globalThis.ResizeObserver` is absent (server, very
 *     old browsers, some test runners) the hook degrades to a one-shot
 *     `getBoundingClientRect()` read on mount.
 *   - The observer is detached on unmount (no leaks).
 *   - Updates are coalesced via `requestAnimationFrame` so a burst of
 *     entries during drag-resize triggers at most one state set per
 *     frame.
 */
import { useEffect, useRef, useState } from 'react';

export interface ObservedSize {
  width: number;
  height: number;
}

export interface UseResizeObserverResult<T extends Element> {
  ref: React.RefObject<T>;
  size: ObservedSize | null;
}

export function useResizeObserver<T extends Element>(): UseResizeObserverResult<T> {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<ObservedSize | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;

    // Fallback: no ResizeObserver — measure once and bail.
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (typeof RO !== 'function') {
      const rect = node.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
      return;
    }

    let rafId: number | null = null;
    let pending: ObservedSize | null = null;

    const flush = (): void => {
      rafId = null;
      if (pending !== null) {
        setSize(pending);
        pending = null;
      }
    };

    const ro = new RO((entries) => {
      const last = entries[entries.length - 1];
      if (last === undefined) return;
      // Prefer `contentBoxSize` (modern), fall back to `contentRect`.
      let width = last.contentRect.width;
      let height = last.contentRect.height;
      const boxes = last.contentBoxSize;
      if (boxes !== undefined) {
        const box = Array.isArray(boxes) ? boxes[0] : boxes;
        if (box !== undefined) {
          width = box.inlineSize;
          height = box.blockSize;
        }
      }
      pending = { width, height };
      if (rafId === null) {
        rafId = requestAnimationFrame(flush);
      }
    });

    ro.observe(node);

    // Seed an initial value synchronously so callers don't render once
    // with `null` and then again on the first observation tick.
    const initial = node.getBoundingClientRect();
    setSize({ width: initial.width, height: initial.height });

    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  return { ref, size };
}
