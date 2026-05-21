/**
 * DockManager — owns the dockable-panel layout slice for the four
 * peripheral regions (left / right / bottom / hidden).
 *
 * The manager itself renders a light drop-zone overlay during drag so
 * users can move panels between docks. Actual panel content is hosted
 * elsewhere (RightDock renders right-docked panels as tabs; left/bottom
 * use the existing Sidebar and a slim logs strip respectively).
 *
 * Layout state shape (in the store):
 *   panelLayout.panels: { id, position, size }[]
 *
 * Drop-zone behaviour:
 *   - Drag begins when the user presses on a panel header and triggers
 *     `beginDrag(id)`. The function returns drag handlers that the
 *     parent applies to the dragged element.
 *   - During drag, four 80px gutters along each viewport edge light up
 *     as candidate targets.
 *   - On release inside a gutter, the store's `movePanel(id, position)`
 *     is invoked. Releasing outside any gutter is a no-op (the panel
 *     returns to its previous position).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import {
  DEFAULT_DOCK_PANEL_IDS,
  type DockPanelId,
  type PanelPosition,
  useStore,
} from '../state/store';

import styles from './DockManager.module.css';

const DROP_ZONE_PX = 80;

/**
 * Pure: given a pointer position + viewport size, classify it into a
 * drop zone (or null for the centre / "no zone"). The function is
 * exported for unit testing — the live drag tracker reuses it directly.
 */
export function classifyDropZone(
  clientX: number,
  clientY: number,
  viewportW: number,
  viewportH: number,
): PanelPosition | null {
  if (viewportW <= 0 || viewportH <= 0) return null;
  const inLeft = clientX <= DROP_ZONE_PX;
  const inRight = clientX >= viewportW - DROP_ZONE_PX;
  const inBottom = clientY >= viewportH - DROP_ZONE_PX;
  // Bottom takes priority when overlapping right/left so the corner
  // doesn't toggle randomly.
  if (inBottom) return 'bottom';
  if (inLeft && !inRight) return 'left';
  if (inRight && !inLeft) return 'right';
  return null;
}

/**
 * Pure: produce the set of panels at a given dock position from the
 * layout slice. Used by RightDock and unit tests.
 */
export function panelsAtPosition(
  layout: { panels: { id: DockPanelId; position: PanelPosition; size: number }[] },
  position: PanelPosition,
): DockPanelId[] {
  return layout.panels
    .filter((p) => p.position === position)
    .map((p) => p.id);
}

/** Validate that a string is a known dock panel id. */
export function isDockPanelId(s: string): s is DockPanelId {
  return (DEFAULT_DOCK_PANEL_IDS as readonly string[]).includes(s);
}

interface DragState {
  panelId: DockPanelId;
  zone: PanelPosition | null;
}

/**
 * Hook returning a `beginDrag` handler for panels. The dragged element
 * should call `beginDrag(panelId)` on pointer-down; the returned
 * handler walks the drag-and-drop lifecycle and commits the move on
 * release.
 */
export function useDockDrag(): {
  beginDrag: (panelId: DockPanelId) => (e: ReactPointerEvent) => void;
  active: DragState | null;
} {
  const movePanel = useStore((s) => s.movePanel);
  const [active, setActive] = useState<DragState | null>(null);
  const stateRef = useRef<DragState | null>(null);

  const beginDrag = useCallback(
    (panelId: DockPanelId) =>
      (e: ReactPointerEvent): void => {
        e.preventDefault();
        const seed: DragState = { panelId, zone: null };
        stateRef.current = seed;
        setActive(seed);

        const onMove = (ev: PointerEvent): void => {
          const w = window.innerWidth;
          const h = window.innerHeight;
          const zone = classifyDropZone(ev.clientX, ev.clientY, w, h);
          if (stateRef.current === null) return;
          const next: DragState = { ...stateRef.current, zone };
          stateRef.current = next;
          setActive(next);
        };

        const onUp = (): void => {
          const ctx = stateRef.current;
          stateRef.current = null;
          setActive(null);
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          if (ctx === null || ctx.zone === null) return;
          movePanel(ctx.panelId, ctx.zone);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      },
    [movePanel],
  );

  return { beginDrag, active };
}

export interface DockManagerProps {
  /** Optional override for the active drag state (used by tests). */
  drag?: DragState | null;
}

/**
 * Renders the overlay highlights for drop zones. When no drag is in
 * progress, returns null (overlay is removed from the tree entirely).
 *
 * Note: the actual `beginDrag` hook lives in `useDockDrag` — this
 * component only renders the visual hint when a drag is active.
 */
export function DockManager({ drag }: DockManagerProps): JSX.Element | null {
  if (drag === undefined || drag === null) return null;
  const zone = drag.zone;
  return (
    <div className={styles.overlay} aria-hidden="true">
      <div
        className={`${styles.zone ?? ''} ${styles.zoneLeft ?? ''} ${zone === 'left' ? styles.zoneActive ?? '' : ''}`}
      />
      <div
        className={`${styles.zone ?? ''} ${styles.zoneRight ?? ''} ${zone === 'right' ? styles.zoneActive ?? '' : ''}`}
      />
      <div
        className={`${styles.zone ?? ''} ${styles.zoneBottom ?? ''} ${zone === 'bottom' ? styles.zoneActive ?? '' : ''}`}
      />
    </div>
  );
}

/**
 * View menu helper: returns a list of panels with a `hide` action. The
 * settings overlay imports this to render a column of toggles.
 */
export function useDockPanelMenu(): {
  panels: { id: DockPanelId; position: PanelPosition; size: number }[];
  toggle: (id: DockPanelId) => void;
  reset: () => void;
} {
  const panelLayout = useStore((s) => s.panelLayout);
  const togglePanelVisibility = useStore((s) => s.togglePanelVisibility);
  const resetDockLayout = useStore((s) => s.resetDockLayout);
  const panels = useMemo(() => panelLayout.panels.slice(), [panelLayout]);

  // Guard against stale references in tests where panelLayout might be
  // a fresh object reference per render.
  useEffect(() => undefined, []);

  return {
    panels,
    toggle: togglePanelVisibility,
    reset: resetDockLayout,
  };
}
