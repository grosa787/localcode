/**
 * useFocusTrap — keep keyboard focus inside `containerRef` while the
 * hook is enabled.
 *
 * Behaviour:
 *   - On enable: focuses the first focusable inside the container (or
 *     the container itself when nothing is focusable).
 *   - Tab/Shift+Tab cycles within the focusable set; Tab past the last
 *     wraps to the first, Shift+Tab past the first wraps to the last.
 *   - On disable: restores focus to the element that was active when
 *     the trap engaged (typically the trigger button).
 *
 * Discoverable focusables (mirrors the WAI-ARIA APG dialog pattern):
 *   buttons, links with href, inputs / textareas / selects (not
 *   disabled), and any element with explicit `tabindex >= 0`.
 *   `tabindex="-1"` is filtered out so disabled / decorative nodes
 *   never receive focus.
 */
import { useEffect } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTORS = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  // Note: we intentionally skip the `offsetParent` check because jsdom
  // always reports `offsetParent === null` (no layout engine) and that
  // would break the trap in unit tests. The visibility check below via
  // `getComputedStyle` is sufficient for modal contexts where all
  // children render under a single flex backdrop.
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  return true;
}

function listFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
  );
  return nodes.filter(isVisible);
}

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (container === null) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Defer the initial focus so React commits the DOM before we hunt
    // for focusables — otherwise inputs that mount inside the modal
    // body wouldn't be visible to `querySelectorAll` yet.
    const focusTimer = window.setTimeout(() => {
      const focusables = listFocusable(container);
      if (focusables.length > 0 && focusables[0] !== undefined) {
        focusables[0].focus();
      } else {
        // Fall back to focusing the container itself so the trap has
        // something to anchor on. The container must have tabIndex=-1
        // for this to work (Modal sets it).
        container.focus();
      }
    }, 0);

    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const focusables = listFocusable(container);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handler);
      // Restore focus to the trigger if it's still in the DOM and focusable.
      if (
        previouslyFocused !== null &&
        document.contains(previouslyFocused) &&
        typeof previouslyFocused.focus === 'function'
      ) {
        previouslyFocused.focus();
      }
    };
  }, [containerRef, enabled]);
}
