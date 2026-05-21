/**
 * Resizer — reusable drag-handle between two flex children.
 *
 * Renders a thin (4px) interactive bar that, when dragged, calls
 * `onResize(value)` with the new clamped value. Persistence happens
 * via the store's `setResizerValue(persistKey, value)` slice — pass a
 * stable `persistKey` to round-trip the user's choice through
 * localStorage.
 *
 * The component is layout-agnostic: parent decides whether the size
 * applies to width or height by passing `direction='horizontal'`
 * (drag updates X / parent width) or `direction='vertical'`
 * (drag updates Y / parent height).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { useStore } from '../state/store';

import styles from './Resizer.module.css';

export type ResizerDirection = 'horizontal' | 'vertical';

export interface ResizerProps {
  /** Stable key used for persistence (e.g. `sidebar`, `right-dock`). */
  persistKey: string;
  /** Current value in pixels. */
  value: number;
  /** Callback fired during + after drag with the clamped px value. */
  onResize: (value: number) => void;
  direction: ResizerDirection;
  /** Minimum allowed value in px. */
  min: number;
  /** Maximum allowed value in px. */
  max: number;
  /**
   * Direction of "growth" relative to the handle. `'before'` means
   * dragging away from the handle grows the element to its left/top
   * (sidebar pattern); `'after'` means dragging grows the element
   * to its right/bottom (right-dock pattern).
   */
  growth?: 'before' | 'after';
  /** Optional aria-label override. */
  ariaLabel?: string;
}

export function clampResizeValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function computeDraggedValue(
  startValue: number,
  delta: number,
  growth: 'before' | 'after',
  min: number,
  max: number,
): number {
  // `growth = 'before'`: dragging in the positive direction grows the
  // element preceding the handle. `growth = 'after'`: dragging in the
  // positive direction grows the element following the handle (so the
  // sign of `delta` is inverted).
  const signed = growth === 'before' ? startValue + delta : startValue - delta;
  return clampResizeValue(signed, min, max);
}

export function Resizer({
  persistKey,
  value,
  onResize,
  direction,
  min,
  max,
  growth = 'before',
  ariaLabel,
}: ResizerProps): JSX.Element {
  const setResizerValue = useStore((s) => s.setResizerValue);
  const dragRef = useRef<{ start: number; startValue: number } | null>(null);
  const [active, setActive] = useState(false);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignored — some browsers throw on capture failure */
      }
      dragRef.current = {
        start: direction === 'horizontal' ? e.clientX : e.clientY,
        startValue: value,
      };
      setActive(true);
    },
    [direction, value],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const ctx = dragRef.current;
      if (ctx === null) return;
      const current = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = current - ctx.start;
      const next = computeDraggedValue(ctx.startValue, delta, growth, min, max);
      if (next !== value) {
        onResize(next);
      }
    },
    [direction, growth, max, min, onResize, value],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current === null) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignored */
      }
      setResizerValue(persistKey, value);
      dragRef.current = null;
      setActive(false);
    },
    [persistKey, setResizerValue, value],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 32 : 8;
      let next = value;
      if (direction === 'horizontal') {
        if (e.key === 'ArrowLeft')
          next = clampResizeValue(value - (growth === 'before' ? step : -step), min, max);
        else if (e.key === 'ArrowRight')
          next = clampResizeValue(value + (growth === 'before' ? step : -step), min, max);
        else return;
      } else {
        if (e.key === 'ArrowUp')
          next = clampResizeValue(value - (growth === 'before' ? step : -step), min, max);
        else if (e.key === 'ArrowDown')
          next = clampResizeValue(value + (growth === 'before' ? step : -step), min, max);
        else return;
      }
      e.preventDefault();
      if (next !== value) {
        onResize(next);
        setResizerValue(persistKey, next);
      }
    },
    [direction, growth, max, min, onResize, persistKey, setResizerValue, value],
  );

  // Restore body cursor on unmount when drag is interrupted.
  useEffect(() => {
    return () => {
      if (active && typeof document !== 'undefined') {
        document.body.style.cursor = '';
      }
    };
  }, [active]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.style.cursor = active
      ? direction === 'horizontal'
        ? 'col-resize'
        : 'row-resize'
      : '';
    return () => {
      document.body.style.cursor = '';
    };
  }, [active, direction]);

  const cls =
    direction === 'horizontal'
      ? `${styles.handle ?? ''} ${styles.horizontal ?? ''}`
      : `${styles.handle ?? ''} ${styles.vertical ?? ''}`;

  return (
    <div
      role="separator"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-label={ariaLabel ?? `Resize ${persistKey}`}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={`resizer-${persistKey}`}
      className={`${cls} ${active ? (styles.active ?? '') : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
