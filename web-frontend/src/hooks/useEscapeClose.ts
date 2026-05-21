/**
 * useEscapeClose — register a window-level Escape key handler that
 * invokes `onClose` while the hook is mounted. Used by every modal /
 * overlay primitive so the keyboard contract is uniform.
 *
 * Notes:
 *   - Listens on `document` (capture: false) so the most-recently-mounted
 *     overlay reacts first when stacked.
 *   - Skips when `enabled === false` so callers can disable while
 *     submitting / in confirmation states.
 *   - `e.stopPropagation()` keeps a single ESC from closing multiple
 *     stacked overlays.
 */
import { useEffect } from 'react';

export function useEscapeClose(
  onClose: () => void,
  enabled: boolean = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [onClose, enabled]);
}
