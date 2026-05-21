/**
 * RightDock — single right-side container hosting all panels docked to
 * the right as tabs. Each tab corresponds to one DockPanelId.
 *
 * Composition:
 *   ┌───────────────┐
 *   │ Tasks · Agents· Browser· Files· Memory· Usage  [⮜]   │ tab strip
 *   ├───────────────┤
 *   │ ▼ Active tab body fills the remaining space          │
 *   └───────────────┘
 *
 * Behaviour:
 *   - Tabs are reorderable via HTML drag-and-drop (within the strip).
 *   - The collapse button (⮜) reduces the dock to an icon-only strip,
 *     preserving the tab body when re-expanded.
 *   - Visibility is filtered by the store's panelLayout — a panel with
 *     `position !== 'right'` is omitted from the strip.
 *   - The active panel renders via a render-prop map so consumers can
 *     plug existing panels (TasksPanel, AgentTeamPanel, …) without
 *     coupling them to RightDock.
 *
 * Adaptive overflow (computeTabTier):
 *   - tier-1 "comfortable"  : full icon + label, no scroll.
 *   - tier-2 "cramped"      : icon + truncated label, horizontal scroll
 *                             with edge fades when overflowing.
 *   - tier-3 "icon"         : icon only, label revealed via `title=`.
 *   The tier is recomputed from a ResizeObserver on the strip container.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type UIEvent as ReactUIEvent,
} from 'react';

import { useT } from '../i18n';
import {
  BarChart3,
  FolderOpen,
  Globe,
  MessageSquare,
  PanelLeft,
  PanelLeftClose,
  // WHITEBOARD-SECTION — Pencil icon for the whiteboard tab.
  Pencil,
  // /WHITEBOARD-SECTION
  Users,
} from '../icons';
import {
  type DockPanelId,
  useStore,
} from '../state/store';
import { useResizeObserver } from '../util/use-resize-observer';

import { panelsAtPosition } from './DockManager';
import styles from './RightDock.module.css';

export interface RightDockProps {
  /** Per-panel body renderers. Missing panels render a placeholder. */
  panelBodies?: Partial<Record<DockPanelId, ReactNode>>;
}

interface TabIconProps {
  id: DockPanelId;
}

function TabIcon({ id }: TabIconProps): JSX.Element {
  switch (id) {
    case 'tasks':
      return <MessageSquare size={13} strokeWidth={1.6} />;
    case 'agents':
      return <Users size={13} strokeWidth={1.6} />;
    case 'browser':
      return <Globe size={13} strokeWidth={1.6} />;
    case 'files':
      return <FolderOpen size={13} strokeWidth={1.6} />;
    case 'memory':
      return <MessageSquare size={13} strokeWidth={1.6} />;
    case 'usage':
      return <BarChart3 size={13} strokeWidth={1.6} />;
    case 'logs':
      return <MessageSquare size={13} strokeWidth={1.6} />;
    // WHITEBOARD-SECTION
    case 'whiteboard':
      return <Pencil size={13} strokeWidth={1.6} />;
    // /WHITEBOARD-SECTION
  }
}

function panelLabel(id: DockPanelId): string {
  switch (id) {
    case 'tasks':
      return 'Tasks';
    case 'agents':
      return 'Agents';
    case 'browser':
      return 'Browser';
    case 'files':
      return 'Files';
    case 'memory':
      return 'Memory';
    case 'usage':
      return 'Usage';
    case 'logs':
      return 'Logs';
    // WHITEBOARD-SECTION
    case 'whiteboard':
      return 'Whiteboard';
    // /WHITEBOARD-SECTION
  }
}

/**
 * Pure: given the persisted tab order and the panels currently docked
 * right, return the visible (filtered + ordered) sequence of tabs.
 */
export function computeVisibleRightDockTabs(
  order: readonly DockPanelId[],
  rightPanels: readonly DockPanelId[],
): DockPanelId[] {
  const rightSet = new Set(rightPanels);
  const seen = new Set<DockPanelId>();
  const result: DockPanelId[] = [];
  for (const id of order) {
    if (rightSet.has(id) && !seen.has(id)) {
      result.push(id);
      seen.add(id);
    }
  }
  // Append any right-docked panels missing from the saved order — e.g.
  // a freshly added panel id.
  for (const id of rightPanels) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

/**
 * Pure: given the current order + a (drag-source, drop-target) pair,
 * return the next array with the source moved before the target. If
 * source === target or either is missing, returns the input order
 * unchanged.
 */
export function reorderAfterDrop(
  order: readonly DockPanelId[],
  sourceId: DockPanelId,
  targetId: DockPanelId,
): DockPanelId[] {
  if (sourceId === targetId) return order.slice();
  const srcIdx = order.indexOf(sourceId);
  const tgtIdx = order.indexOf(targetId);
  if (srcIdx === -1 || tgtIdx === -1) return order.slice();
  const next = order.filter((id) => id !== sourceId);
  const insertAt = next.indexOf(targetId);
  next.splice(insertAt, 0, sourceId);
  return next;
}

export type TabTier = 'comfortable' | 'cramped' | 'icon';

/** Per-tab pixel budgets used to pick a tier. */
const TIER_THRESHOLDS = {
  /** Width per tab below which we collapse to icon-only. */
  iconPerTab: 48,
  /** Width per tab at which a full label fits without truncation. */
  comfortablePerTab: 110,
  /** Reserve for collapse button + padding on the strip. */
  chromeReserve: 44,
} as const;

/**
 * Pure: classify the strip into a tier from the available width and the
 * number of tabs. Returns 'comfortable' when generous, 'cramped' when
 * tabs fit only with truncation + scroll, 'icon' when even truncated
 * labels would not fit.
 */
export function computeTabTier(
  containerWidth: number,
  tabCount: number,
): TabTier {
  if (tabCount <= 0) return 'comfortable';
  if (containerWidth <= 0) return 'comfortable'; // pre-measurement default
  const usable = Math.max(0, containerWidth - TIER_THRESHOLDS.chromeReserve);
  const perTab = usable / tabCount;
  if (perTab >= TIER_THRESHOLDS.comfortablePerTab) return 'comfortable';
  if (perTab >= TIER_THRESHOLDS.iconPerTab) return 'cramped';
  return 'icon';
}

/**
 * Pure: next index after Arrow/Home/End keyboard navigation. Returns
 * `null` when the key is not one we handle so the caller can let the
 * event bubble.
 */
export function nextTabIndex(
  key: string,
  current: number,
  total: number,
): number | null {
  if (total <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % total;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + total) % total;
    case 'Home':
      return 0;
    case 'End':
      return total - 1;
    default:
      return null;
  }
}

interface ScrollEdgeState {
  showLeft: boolean;
  showRight: boolean;
}

/** Pure: derive fade visibility from scroll geometry. */
function computeEdges(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): ScrollEdgeState {
  const max = scrollWidth - clientWidth;
  // 2px tolerance because layout rounding produces fractional pixels.
  return {
    showLeft: scrollLeft > 2,
    showRight: max > 2 && scrollLeft < max - 2,
  };
}

export function RightDock({ panelBodies }: RightDockProps): JSX.Element | null {
  const t = useT();
  const panelLayout = useStore((s) => s.panelLayout);
  const order = useStore((s) => s.rightDockTabOrder);
  const collapsed = useStore((s) => s.rightDockCollapsed);
  const active = useStore((s) => s.activeRightDockTab);
  const setActive = useStore((s) => s.setActiveRightDockTab);
  const toggleCollapsed = useStore((s) => s.toggleRightDockCollapsed);
  const reorder = useStore((s) => s.setRightDockTabOrder);

  const rightPanels = useMemo(
    () => panelsAtPosition(panelLayout, 'right'),
    [panelLayout],
  );

  const visibleTabs = useMemo(
    () => computeVisibleRightDockTabs(order, rightPanels),
    [order, rightPanels],
  );

  const [dragSource, setDragSource] = useState<DockPanelId | null>(null);

  // Measurement: track the OUTER strip width and derive tier from it.
  const { ref: stripRef, size: stripSize } = useResizeObserver<HTMLDivElement>();
  // Scroll container ref — separate from stripRef so the observer
  // measures total available space, not the post-scroll content box.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<DockPanelId, HTMLButtonElement>>(new Map());

  const tier: TabTier = useMemo(() => {
    if (collapsed) return 'icon';
    return computeTabTier(stripSize?.width ?? 0, visibleTabs.length);
  }, [collapsed, stripSize?.width, visibleTabs.length]);

  const [edges, setEdges] = useState<ScrollEdgeState>({
    showLeft: false,
    showRight: false,
  });

  const recomputeEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    setEdges(computeEdges(el.scrollLeft, el.scrollWidth, el.clientWidth));
  }, []);

  // Re-evaluate edge fades whenever tier or tab count changes (layout
  // shifts can change scrollWidth without firing a scroll event).
  useEffect(() => {
    recomputeEdges();
  }, [tier, visibleTabs.length, recomputeEdges]);

  // Translate vertical wheel into horizontal scroll inside the strip
  // (tier-2 only). We attach the listener manually because React's
  // synthetic onWheel is passive, which forbids preventDefault.
  useEffect(() => {
    if (tier !== 'cramped') return;
    const el = scrollerRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      // Only intercept when there is something to scroll horizontally.
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [tier]);

  const onDragStart = useCallback(
    (id: DockPanelId) => (e: ReactDragEvent<HTMLButtonElement>) => {
      try {
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
      } catch {
        /* ignored — synthetic events in tests may not expose dataTransfer */
      }
      setDragSource(id);
    },
    [],
  );

  const onDragOver = useCallback((e: ReactDragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'move';
    } catch {
      /* ignored */
    }
  }, []);

  const onDrop = useCallback(
    (targetId: DockPanelId) => (e: ReactDragEvent<HTMLButtonElement>) => {
      e.preventDefault();
      let sourceId: DockPanelId | null = dragSource;
      try {
        const raw = e.dataTransfer.getData('text/plain');
        if (
          raw !== '' &&
          (visibleTabs as readonly string[]).includes(raw)
        ) {
          sourceId = raw as DockPanelId;
        }
      } catch {
        /* ignored */
      }
      if (sourceId === null || sourceId === targetId) {
        setDragSource(null);
        return;
      }
      reorder(reorderAfterDrop(order, sourceId, targetId));
      setDragSource(null);
    },
    [dragSource, order, reorder, visibleTabs],
  );

  const focusTabAt = useCallback(
    (idx: number) => {
      const id = visibleTabs[idx];
      if (id === undefined) return;
      const el = tabRefs.current.get(id);
      if (el !== undefined) el.focus();
    },
    [visibleTabs],
  );

  const onTabKeyDown = useCallback(
    (currentId: DockPanelId) =>
      (e: ReactKeyboardEvent<HTMLButtonElement>) => {
        const idx = visibleTabs.indexOf(currentId);
        if (idx === -1) return;
        const next = nextTabIndex(e.key, idx, visibleTabs.length);
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        focusTabAt(next);
        const nextId = visibleTabs[next];
        if (nextId !== undefined) setActive(nextId);
      },
    [focusTabAt, setActive, visibleTabs],
  );

  const onScroll = useCallback(
    (_e: ReactUIEvent<HTMLDivElement>) => {
      recomputeEdges();
    },
    [recomputeEdges],
  );

  // Don't render at all when no panels are docked right (keeps the chat
  // surface full-width).
  if (visibleTabs.length === 0) return null;

  const activeVisible = visibleTabs.includes(active);
  const effectiveActive = activeVisible
    ? active
    : visibleTabs[0] ?? null;

  const showLabels = !collapsed && tier !== 'icon';
  const showEdgeFades = tier === 'cramped' && !collapsed;

  return (
    <aside
      className={`${styles.dock ?? ''} ${collapsed ? styles.collapsed ?? '' : ''}`}
      aria-label={t('projectBar.aria')}
      data-testid="right-dock"
    >
      <div
        ref={stripRef}
        className={`${styles.strip ?? ''} ${styles[`tier-${tier}`] ?? ''}`}
        data-tier={tier}
        data-testid="right-dock-strip"
      >
        <div
          ref={scrollerRef}
          className={`${styles.scroller ?? ''} ${showEdgeFades && edges.showLeft ? styles.fadeLeft ?? '' : ''} ${showEdgeFades && edges.showRight ? styles.fadeRight ?? '' : ''}`}
          role="tablist"
          aria-orientation={collapsed ? 'vertical' : 'horizontal'}
          onScroll={onScroll}
          data-testid="right-dock-scroller"
        >
          {visibleTabs.map((id) => {
            const isActive = id === effectiveActive;
            const label = panelLabel(id);
            return (
              <button
                key={id}
                ref={(el) => {
                  if (el === null) tabRefs.current.delete(id);
                  else tabRefs.current.set(id, el);
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={!showLabels ? label : undefined}
                title={label}
                tabIndex={isActive ? 0 : -1}
                data-testid={`right-dock-tab-${id}`}
                className={`${styles.tab ?? ''} ${isActive ? styles.tabActive ?? '' : ''}`}
                onClick={() => setActive(id)}
                onKeyDown={onTabKeyDown(id)}
                draggable={true}
                onDragStart={onDragStart(id)}
                onDragOver={onDragOver}
                onDrop={onDrop(id)}
              >
                <span className={styles.tabIcon} aria-hidden="true">
                  <TabIcon id={id} />
                </span>
                {showLabels ? (
                  <span className={styles.tabLabel}>{label}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={styles.collapseBtn}
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand right dock' : 'Collapse right dock'}
          title={collapsed ? 'Expand right dock' : 'Collapse right dock'}
        >
          {collapsed ? (
            <PanelLeft size={13} strokeWidth={1.6} />
          ) : (
            <PanelLeftClose size={13} strokeWidth={1.6} />
          )}
        </button>
      </div>
      {!collapsed && effectiveActive !== null ? (
        <div
          className={styles.body}
          role="tabpanel"
          data-testid={`right-dock-body-${effectiveActive}`}
        >
          {panelBodies?.[effectiveActive] ?? (
            <div className={styles.placeholder}>{panelLabel(effectiveActive)}</div>
          )}
        </div>
      ) : null}
    </aside>
  );
}
