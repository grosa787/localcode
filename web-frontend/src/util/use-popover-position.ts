/**
 * usePopoverPosition — shared positioning hook for chip-anchored
 * popovers (Provider / Model / Profile / Style dropdowns). The chips
 * live in the sticky-bottom composer row, so the default `top: 100%`
 * placement clips below the viewport. This hook measures the anchor
 * and popover against the viewport and returns the side it should
 * actually open on (auto-flip), plus a horizontal alignment that
 * keeps the popover on-screen.
 *
 * Contract:
 *   - `anchorRef`     — the chip button (or wrap div containing it).
 *   - `popoverRef`    — the popover element (mounted while `open`).
 *   - `preferredSide` — caller preference; we honour it when there's
 *                       room, otherwise flip to the opposite side.
 *   - `gap`           — pixel offset between anchor edge and popover.
 *   - `open`          — when false the hook returns the preferred
 *                       side unchanged and skips measurement.
 *
 * Returns a `style` object the caller can spread onto the popover's
 * inline style. The style uses absolute positioning relative to the
 * anchor's offset parent (the `.wrap` container, which is
 * `position: relative`). When the popover would overflow the right
 * edge of the viewport we switch from `left: 0` to `right: 0` (align
 * end); we never both translate and align — only one is active.
 *
 * Re-measurement triggers:
 *   - `open` flips true → measure once on next layout.
 *   - `ResizeObserver` on the popover (content height can change as
 *     options load, filter text narrows results, etc.).
 *   - Window `resize` and `scroll` (capture phase so nested
 *     scrollers also fire).
 *
 * SSR / jsdom safe: when `window` is undefined or the refs aren't
 * attached yet, returns the preferred placement so first paint
 * doesn't flash an empty layout.
 */
import { useEffect, useMemo, useState, type CSSProperties, type RefObject } from 'react';

export type PopoverSide = 'top' | 'bottom';
export type PopoverAlign = 'start' | 'end';

export interface UsePopoverPositionOptions {
  /** The trigger element. Its bounding rect is the reference point. */
  anchorRef: RefObject<HTMLElement | null>;
  /** The popover element. Mounted while `open` is true. */
  popoverRef: RefObject<HTMLElement | null>;
  /** Caller preference; we flip when there's no room on this side. */
  preferredSide: PopoverSide;
  /** Pixel gap between anchor edge and popover. Default 6. */
  gap?: number;
  /** When false we skip measurement and return preferred placement. */
  open: boolean;
}

export interface PopoverPlacement {
  side: PopoverSide;
  align: PopoverAlign;
  /** Inline style to spread onto the popover root. */
  style: CSSProperties;
}

/**
 * Pure resolver — given anchor + popover rectangles and viewport
 * dimensions, decide which side and alignment the popover should
 * use. Exported so tests can verify the geometry without mounting
 * anything.
 *
 * `popover` may be `null` (first frame before measurement); we fall
 * back to a conservative 240px-tall estimate so the first render
 * still respects the preferred side when there's clearly room.
 */
export function resolvePopoverPlacement(args: {
  anchor: { top: number; bottom: number; left: number; right: number };
  popover: { width: number; height: number } | null;
  viewport: { width: number; height: number };
  preferredSide: PopoverSide;
  gap: number;
}): { side: PopoverSide; align: PopoverAlign } {
  const { anchor, popover, viewport, preferredSide, gap } = args;
  const estimatedHeight = popover === null ? 240 : popover.height;
  const estimatedWidth = popover === null ? 240 : popover.width;

  const spaceBelow = viewport.height - anchor.bottom - gap;
  const spaceAbove = anchor.top - gap;

  let side: PopoverSide = preferredSide;
  if (preferredSide === 'bottom') {
    if (spaceBelow < estimatedHeight && spaceAbove > spaceBelow) {
      side = 'top';
    }
  } else {
    if (spaceAbove < estimatedHeight && spaceBelow > spaceAbove) {
      side = 'bottom';
    }
  }

  // Horizontal alignment — when left-aligned the popover extends to
  // `anchor.left + popoverWidth`. If that overflows the viewport's
  // right edge, switch to end-align so the popover hugs the
  // anchor's right edge instead.
  let align: PopoverAlign = 'start';
  const projectedRight = anchor.left + estimatedWidth;
  if (projectedRight > viewport.width - 4) {
    align = 'end';
  }
  // Edge case: a very wide popover anchored near the right edge of
  // a narrow viewport — `end` would push it off the left. Prefer
  // start in that case (clipping the right is still better than the
  // popover disappearing entirely).
  if (align === 'end' && anchor.right - estimatedWidth < 4) {
    align = 'start';
  }

  return { side, align };
}

/**
 * Build the inline style for a popover from the resolved side +
 * alignment. The style is relative to the anchor's offset parent
 * (typically the chip's `.wrap` div), which all four chip
 * components already declare as `position: relative`.
 */
export function buildPopoverStyle(
  side: PopoverSide,
  align: PopoverAlign,
  gap: number,
): CSSProperties {
  const style: CSSProperties = { position: 'absolute' };
  if (side === 'top') {
    style.bottom = `calc(100% + ${gap}px)`;
    style.top = 'auto';
  } else {
    style.top = `calc(100% + ${gap}px)`;
    style.bottom = 'auto';
  }
  if (align === 'end') {
    style.right = 0;
    style.left = 'auto';
  } else {
    style.left = 0;
    style.right = 'auto';
  }
  return style;
}

/**
 * React hook — keep the popover placement live as the viewport,
 * content size, or anchor position changes. Returns the resolved
 * `side` / `align` and a ready-to-spread `style` object.
 */
export function usePopoverPosition(
  options: UsePopoverPositionOptions,
): PopoverPlacement {
  const { anchorRef, popoverRef, preferredSide, gap = 6, open } = options;

  const [placement, setPlacement] = useState<{ side: PopoverSide; align: PopoverAlign }>(
    () => ({ side: preferredSide, align: 'start' }),
  );

  useEffect(() => {
    if (!open) {
      setPlacement({ side: preferredSide, align: 'start' });
      return;
    }
    if (typeof window === 'undefined') return;

    let rafId: number | null = null;

    const measure = (): void => {
      rafId = null;
      const anchorEl = anchorRef.current;
      if (anchorEl === null) return;
      const popoverEl = popoverRef.current;
      const anchorRect = anchorEl.getBoundingClientRect();
      const popoverRect =
        popoverEl !== null ? popoverEl.getBoundingClientRect() : null;
      const next = resolvePopoverPlacement({
        anchor: {
          top: anchorRect.top,
          bottom: anchorRect.bottom,
          left: anchorRect.left,
          right: anchorRect.right,
        },
        popover:
          popoverRect !== null
            ? { width: popoverRect.width, height: popoverRect.height }
            : null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        preferredSide,
        gap,
      });
      setPlacement((cur) => {
        if (cur.side === next.side && cur.align === next.align) return cur;
        return next;
      });
    };

    const schedule = (): void => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(measure);
    };

    // Initial measure on the next frame so the popover has had a
    // chance to render into the DOM.
    schedule();

    let ro: ResizeObserver | null = null;
    const popoverEl = popoverRef.current;
    if (
      typeof ResizeObserver !== 'undefined' &&
      popoverEl !== null
    ) {
      ro = new ResizeObserver(() => schedule());
      ro.observe(popoverEl);
    }

    window.addEventListener('resize', schedule);
    // Capture phase so scrolling in any ancestor scroller (the chat
    // list, the side panels) still updates the placement.
    window.addEventListener('scroll', schedule, true);

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      if (ro !== null) ro.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
    // The refs are stable across renders; only `open` and the
    // caller's preferences should trigger a re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preferredSide, gap]);

  const style = useMemo(
    () => buildPopoverStyle(placement.side, placement.align, gap),
    [placement.side, placement.align, gap],
  );

  return { side: placement.side, align: placement.align, style };
}
