/**
 * useViewport — single source of truth for browser viewport size and
 * the derived breakpoint. The hook subscribes via `ResizeObserver` on
 * `document.documentElement`, falling back to a window `resize`
 * listener in environments without the observer.
 *
 * Throttled to ~120 ms via a leading-edge + trailing-flush schedule so
 * a fast drag doesn't fan out into a render-per-frame storm.
 *
 * Breakpoints — kept in sync with the CSS rules in
 * `theme/globals.css` (RESPONSIVE-SECTION). Any change here MUST be
 * mirrored there.
 *   - mobile:  < 768
 *   - tablet:  768 – 1023
 *   - desktop: 1024 – 1439
 *   - wide:    >= 1440
 *
 * The hook is SSR-safe — when `typeof window === 'undefined'` it
 * returns a `desktop` default so server-side renders don't crash. The
 * `useEffect` re-measures synchronously on first client render.
 */
import { useEffect, useRef, useState } from 'react';

export type ViewportBreakpoint = 'mobile' | 'tablet' | 'desktop' | 'wide';

export interface ViewportInfo {
  width: number;
  height: number;
  breakpoint: ViewportBreakpoint;
}

export const VIEWPORT_BREAKPOINTS = {
  mobile: 768,
  tablet: 1024,
  desktop: 1440,
} as const;

/** Throttle window for the resize observer (ms). */
export const VIEWPORT_THROTTLE_MS = 120;

/**
 * Pure helper — given a width in CSS pixels, return the active
 * breakpoint. Exported for direct testing without mounting the hook.
 */
export function resolveBreakpoint(width: number): ViewportBreakpoint {
  if (width < VIEWPORT_BREAKPOINTS.mobile) return 'mobile';
  if (width < VIEWPORT_BREAKPOINTS.tablet) return 'tablet';
  if (width < VIEWPORT_BREAKPOINTS.desktop) return 'desktop';
  return 'wide';
}

/**
 * Read the current viewport synchronously. SSR fallback returns a
 * `desktop`-sized default so first paint doesn't flash a mobile
 * layout on server-rendered HTML.
 */
export function readViewport(): ViewportInfo {
  if (typeof window === 'undefined') {
    return { width: 1280, height: 800, breakpoint: 'desktop' };
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  return { width: w, height: h, breakpoint: resolveBreakpoint(w) };
}

/**
 * React hook — subscribes to viewport size changes and returns the
 * current width/height/breakpoint. The returned object identity is
 * stable across renders whenever the breakpoint AND dimensions are
 * unchanged, so dependent effects don't refire spuriously.
 */
export function useViewport(): ViewportInfo {
  const [info, setInfo] = useState<ViewportInfo>(() => readViewport());
  const latestRef = useRef<ViewportInfo>(info);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let pending = false;
    let trailingTimer: number | null = null;

    const apply = (): void => {
      pending = false;
      const next = readViewport();
      const prev = latestRef.current;
      if (
        prev.width === next.width &&
        prev.height === next.height &&
        prev.breakpoint === next.breakpoint
      ) {
        return;
      }
      latestRef.current = next;
      setInfo(next);
    };

    const schedule = (): void => {
      if (pending) return;
      pending = true;
      // Leading-edge apply so the first event in a burst lands
      // immediately; trailing flush picks up the settled value once
      // the user stops dragging.
      apply();
      if (trailingTimer !== null) window.clearTimeout(trailingTimer);
      trailingTimer = window.setTimeout(() => {
        trailingTimer = null;
        apply();
      }, VIEWPORT_THROTTLE_MS);
    };

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => schedule());
      observer.observe(document.documentElement);
    } else {
      window.addEventListener('resize', schedule);
    }

    // Initial pass — in case the SSR fallback differs from the real
    // dimensions on first client render.
    apply();

    return () => {
      if (observer !== null) observer.disconnect();
      else window.removeEventListener('resize', schedule);
      if (trailingTimer !== null) window.clearTimeout(trailingTimer);
    };
  }, []);

  return info;
}

/**
 * Side-effect-only sibling of `useViewport` — applies the active
 * breakpoint to `document.documentElement.dataset.viewport` so CSS
 * selectors like `[data-viewport='mobile']` work without each
 * component having to consume the hook. Intended to be called once at
 * the App root.
 *
 * Returns the live ViewportInfo for callers that also need it.
 */
export function useViewportDataAttribute(): ViewportInfo {
  const info = useViewport();
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.viewport = info.breakpoint;
  }, [info.breakpoint]);
  return info;
}
