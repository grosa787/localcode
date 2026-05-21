/**
 * Sidebar — main left rail.
 *
 * Layout:
 *   - Brand row (◆ + LocalCode + collapse toggle)
 *   - Top toolbar: "+ New session" + filter (group-by) button
 *   - Project tree — every visible project rendered as a collapsible
 *     <ProjectRow>; each project's sessions nested inside.
 *     Alternate group-by modes ('recent', 'active') flatten to a single
 *     list of sessions across all projects.
 *   - ProjectSwitcher
 *   - Settings + version footer
 *
 * Collapsed state (56px): brand row keeps the toggle, compact "+"
 * button, settings gear, and a mini version label. The session tree is
 * hidden in collapsed mode.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { SessionSummaryWire } from '../../../src/web/protocol/rest-types.js';
import { useT } from '../i18n';
// RESPONSIVE-SECTION
import type { ViewportBreakpoint } from '../util/use-viewport';
// /RESPONSIVE-SECTION
import {
  MessageSquare,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
} from '../icons';
import { useStore, type SidebarGroupBy } from '../state/store';
import { ConfirmDeleteProjectDialog } from './ConfirmDeleteProjectDialog';
import { EmptyState } from './EmptyState';
import { ProjectRow } from './ProjectRow';
import { ProjectSwitcher } from './ProjectSwitcher';
import { SessionRow } from './SessionRow';
import { SubAgentRow } from './SubAgentRow';
import { SidebarFilterMenu } from './SidebarFilterMenu';
import { SkeletonRow } from './SkeletonRow';
import { VersionFooter } from './VersionFooter';
import styles from './Sidebar.module.css';

export interface SidebarProps {
  /** True while initial sessions list is being fetched. */
  loadingSessions?: boolean;
  /** Non-null when the last fetch failed. */
  sessionsError?: string | null;
  onNewChat?: () => void;
  onOpenSettings?: () => void;
  onAddProject?: () => void;
  /**
   * Cascade-delete a project + its sessions on the server. Sidebar
   * surfaces the confirmation modal; the parent owns the network call.
   */
  onDeleteProject?: (projectId: string) => void;
  // RESPONSIVE-SECTION
  /**
   * Current viewport breakpoint (passed down from App). When omitted
   * the sidebar behaves like the previous desktop-only build — this
   * keeps existing tests that mount Sidebar in isolation working.
   */
  viewport?: ViewportBreakpoint;
  // /RESPONSIVE-SECTION
}

interface ProjectGroup {
  projectId: string;
  /** Display label — falls back to projectId when project record missing. */
  label: string;
  /** Absolute path (used for tooltip). */
  path: string;
  sessions: SessionSummaryWire[];
}

interface PendingDelete {
  projectId: string;
  label: string;
  sessionCount: number;
}

/** basename of a posix-or-windows path. */
function basename(p: string): string {
  if (p.length === 0) return p;
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx === -1 ? cleaned : cleaned.slice(idx + 1);
}

export function Sidebar({
  loadingSessions = false,
  sessionsError = null,
  onNewChat,
  onOpenSettings,
  onAddProject,
  onDeleteProject,
  viewport,
}: SidebarProps): JSX.Element {
  const userCollapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  // RESPONSIVE-SECTION
  // Viewport-driven layout mode. Falls back to 'desktop' so tests that
  // mount Sidebar in isolation continue to render the full sidebar.
  const mode: ViewportBreakpoint = viewport ?? 'desktop';
  // Mobile/tablet: the static collapse state in the store is ignored —
  // tablet always shows an icon strip, mobile always hides until the
  // user opens the drawer.
  const collapsed: boolean = (() => {
    if (mode === 'mobile') return false; // drawer is full-width when open
    if (mode === 'tablet') return true; // forced icon strip
    return userCollapsed;
  })();
  const [mobileOpen, setMobileOpen] = useState(false);
  // Reset the mobile drawer whenever the breakpoint changes away from
  // mobile (so resizing the window doesn't leave a phantom overlay).
  useEffect(() => {
    if (mode !== 'mobile') setMobileOpen(false);
  }, [mode]);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const openMobile = useCallback(() => setMobileOpen(true), []);
  // Swipe-to-dismiss: track horizontal drag and close when the user
  // swipes left more than a third of the drawer width. Vertical drag
  // is treated as a scroll and ignored.
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragDxRef = useRef<number>(0);
  const dragLockRef = useRef<'pending' | 'horizontal' | 'vertical'>('pending');
  const onMobilePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (mode !== 'mobile') return;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      dragDxRef.current = 0;
      dragLockRef.current = 'pending';
    },
    [mode],
  );
  const onMobilePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const start = dragStartRef.current;
      if (start === null) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (dragLockRef.current === 'pending') {
        // Need a couple of pixels of movement to commit to a direction.
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          dragLockRef.current = 'horizontal';
        } else if (Math.abs(dy) > 8) {
          dragLockRef.current = 'vertical';
        }
      }
      if (dragLockRef.current === 'horizontal') dragDxRef.current = dx;
    },
    [],
  );
  const onMobilePointerUp = useCallback((): void => {
    if (dragLockRef.current === 'horizontal' && dragDxRef.current < -80) {
      setMobileOpen(false);
    }
    dragStartRef.current = null;
    dragDxRef.current = 0;
    dragLockRef.current = 'pending';
  }, []);
  // /RESPONSIVE-SECTION
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActiveSession = useStore((s) => s.setActiveSession);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  const sidebarExpanded = useStore((s) => s.sidebarExpanded);
  const toggleProjectExpanded = useStore((s) => s.toggleProjectExpanded);
  const sidebarHidden = useStore((s) => s.sidebarHidden);
  const hideProject = useStore((s) => s.hideProject);
  const sidebarGroupBy = useStore((s) => s.sidebarGroupBy);
  const sidebarFilterOpen = useStore((s) => s.sidebarFilterOpen);
  const openSidebarFilter = useStore((s) => s.openSidebarFilter);
  const closeSidebarFilter = useStore((s) => s.closeSidebarFilter);
  const openSessionSearch = useStore((s) => s.openSessionSearch);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const agentTree = useStore((s) => s.agentTree);
  const pushToast = useStore((s) => s.pushToast);
  // SUBAGENT-CLICK-SECTION
  // Clicking a sub-agent row in the sidebar enters agent-reply mode
  // (running agents) or opens the team panel pinned to the agent's
  // expanded card (terminated agents — no live chat to send to).
  const enterAgentReply = useStore((s) => s.enterAgentReply);
  const openAgentTeamPanel = useStore((s) => s.openAgentTeamPanel);
  // /SUBAGENT-CLICK-SECTION
  const t = useT();

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );

  const noProject = activeProjectId === null;

  const hiddenSet = useMemo(
    () => new Set(sidebarHidden),
    [sidebarHidden],
  );

  // Group sessions by projectId. SessionSummaryWire only carries
  // projectId, so the project root/label comes from the workspace
  // records. Hidden projects are excluded; orphan sessions (project
  // record missing) still surface under a synthetic group so users can
  // recover them.
  const groups = useMemo<ProjectGroup[]>(() => {
    const byId = new Map<string, ProjectGroup>();
    for (const proj of projects) {
      if (hiddenSet.has(proj.id)) continue;
      byId.set(proj.id, {
        projectId: proj.id,
        label: proj.label.length > 0 ? proj.label : basename(proj.root),
        path: proj.root,
        sessions: [],
      });
    }
    for (const s of sessions) {
      if (hiddenSet.has(s.projectId)) continue;
      let g = byId.get(s.projectId);
      if (g === undefined) {
        g = {
          projectId: s.projectId,
          label: s.projectId,
          path: s.projectId,
          sessions: [],
        };
        byId.set(s.projectId, g);
      }
      g.sessions.push(s);
    }
    const out = [...byId.values()];
    // Active project first, then by label.
    out.sort((a, b) => {
      if (a.projectId === activeProjectId) return -1;
      if (b.projectId === activeProjectId) return 1;
      return a.label.localeCompare(b.label);
    });
    // Sort sessions inside each group most-recent first.
    for (const g of out) {
      g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return out;
  }, [projects, sessions, activeProjectId, hiddenSet]);

  const projectLookup = useMemo(() => {
    const m = new Map<string, ProjectGroup>();
    for (const g of groups) m.set(g.projectId, g);
    return m;
  }, [groups]);

  const flatSessions = useMemo<SessionSummaryWire[]>(() => {
    const all: SessionSummaryWire[] = [];
    for (const g of groups) all.push(...g.sessions);
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return all;
  }, [groups]);

  const activeSessions = useMemo<SessionSummaryWire[]>(() => {
    return flatSessions.filter((s) => {
      const status = sessionStatus[s.id]?.status;
      return status === 'streaming' || status === 'recently-finished';
    });
  }, [flatSessions, sessionStatus]);

  const isExpanded = (projectId: string): boolean =>
    sidebarExpanded[projectId] ?? true;

  const projectIsStreaming = useCallback(
    (g: ProjectGroup): boolean => {
      for (const s of g.sessions) {
        if (sessionStatus[s.id]?.status === 'streaming') return true;
      }
      return false;
    },
    [sessionStatus],
  );

  /**
   * When the user clicks a session anywhere in the sidebar — including
   * the recent/active flat lists or a session under a non-active
   * project — bump `activeProjectId` to that session's project. This
   * keeps "the project the user is browsing" in sync with their actual
   * focus, so "+ New session" later creates the chat under the correct
   * project (was: stuck on whichever project was active at boot).
   */
  const handleSelectSession = useCallback(
    (sessionId: string): void => {
      const target = sessions.find((s) => s.id === sessionId);
      if (target !== undefined && target.projectId !== activeProjectId) {
        setActiveProject(target.projectId);
      }
      setActiveSession(sessionId);
    },
    [sessions, activeProjectId, setActiveProject, setActiveSession],
  );

  const handleHide = (projectId: string, label: string): void => {
    hideProject(projectId);
    pushToast({
      level: 'info',
      message: t('toast.hidden', { label }),
    });
  };

  const handleAskDelete = (g: ProjectGroup): void => {
    setPendingDelete({
      projectId: g.projectId,
      label: g.label,
      sessionCount: g.sessions.length,
    });
  };

  const handleConfirmDelete = (): void => {
    if (pendingDelete === null) return;
    const id = pendingDelete.projectId;
    setPendingDelete(null);
    onDeleteProject?.(id);
  };

  const renderTree = (): JSX.Element => {
    if (groups.length === 0) {
      return (
        <EmptyState
          icon={MessageSquare}
          title={
            noProject
              ? t('sidebar.empty.noProject')
              : t('sidebar.empty.noProjects')
          }
          description={
            noProject
              ? t('sidebar.empty.addProject')
              : t('sidebar.empty.addOrRestore')
          }
        />
      );
    }
    return (
      <>
        {groups.map((g) => {
          const expanded = isExpanded(g.projectId);
          return (
            <div key={g.projectId} className={styles.projectBlock}>
              <ProjectRow
                projectId={g.projectId}
                label={g.label}
                path={g.path}
                sessionCount={g.sessions.length}
                expanded={expanded}
                active={g.projectId === activeProjectId}
                streaming={projectIsStreaming(g)}
                onToggle={() => toggleProjectExpanded(g.projectId)}
                onHide={() => handleHide(g.projectId, g.label)}
                onDelete={() => handleAskDelete(g)}
              />
              {expanded ? (
                <div className={styles.projectChildren}>
                  {g.sessions.length === 0 ? (
                    <p className={styles.folderEmpty}>{t('sidebar.folder.empty')}</p>
                  ) : (
                    g.sessions.map((s) => {
                      const subAgents = agentTree[s.id] ?? [];
                      return (
                        <div key={s.id} className={styles.sessionWithAgents}>
                          <SessionRow
                            session={s}
                            active={s.id === activeSessionId}
                            nested
                            onSelect={handleSelectSession}
                          />
                          {subAgents.length > 0 ? (
                            <div
                              className={styles.subAgentList}
                              role="group"
                              aria-label={t('sidebar.subAgents')}
                            >
                              {subAgents.map((agent) => {
                                const subSessionId = `${s.id}.agent.${agent.agentId}`;
                                return (
                                  <SubAgentRow
                                    key={agent.agentId}
                                    agent={agent}
                                    active={activeSessionId === subSessionId}
                                    // SUBAGENT-CLICK-SECTION
                                    onSelect={() => {
                                      if (agent.status === 'running') {
                                        // Live agent — open the panel + enter
                                        // reply-mode so the Composer routes
                                        // typed text through TeamBus.
                                        openAgentTeamPanel();
                                        enterAgentReply({
                                          parentSessionId: s.id,
                                          agentId: agent.agentId,
                                          label: agent.agentId.slice(0, 8),
                                        });
                                      } else {
                                        // Terminated — surface the historical
                                        // transcript via the panel; reply mode
                                        // is disabled for non-running agents.
                                        openAgentTeamPanel();
                                      }
                                    }}
                                    // /SUBAGENT-CLICK-SECTION
                                  />
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </>
    );
  };

  const renderFlat = (
    list: SessionSummaryWire[],
    emptyTitle: string,
    emptyDescription: string,
  ): JSX.Element => {
    if (list.length === 0) {
      return (
        <EmptyState
          icon={MessageSquare}
          title={emptyTitle}
          description={emptyDescription}
        />
      );
    }
    return (
      <>
        {list.map((s) => {
          const proj = projectLookup.get(s.projectId);
          const projLabel = proj?.label ?? s.projectId;
          return (
            <div key={s.id} className={styles.flatRow}>
              <SessionRow
                session={s}
                active={s.id === activeSessionId}
                onSelect={handleSelectSession}
              />
              <span className={styles.flatProjectTag} title={proj?.path ?? ''}>
                {projLabel}
              </span>
            </div>
          );
        })}
      </>
    );
  };

  const renderListBody = (): JSX.Element => {
    if (loadingSessions) {
      return (
        <>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </>
      );
    }
    if (sessionsError !== null) {
      return (
        <p className={styles.listError} role="alert">
          {sessionsError}
        </p>
      );
    }
    const mode: SidebarGroupBy = sidebarGroupBy;
    if (mode === 'project') return renderTree();
    if (mode === 'recent') {
      return renderFlat(
        flatSessions,
        t('sidebar.empty.noRecent'),
        t('sidebar.empty.noRecent.desc'),
      );
    }
    return renderFlat(
      activeSessions,
      t('sidebar.empty.noActive'),
      t('sidebar.empty.noActive.desc'),
    );
  };

  // RESPONSIVE-SECTION
  // The collapse-toggle action depends on the viewport: on mobile it
  // opens/closes the drawer overlay, on tablet it is hidden (the icon
  // strip is the only sidebar state available), on desktop it flips
  // the persistent collapsed boolean in the store.
  const onCollapseToggle = useCallback((): void => {
    if (mode === 'mobile') {
      if (mobileOpen) closeMobile();
      else openMobile();
      return;
    }
    toggleSidebar();
  }, [mode, mobileOpen, closeMobile, openMobile, toggleSidebar]);
  const collapseAriaLabel =
    mode === 'mobile'
      ? mobileOpen
        ? t('sidebar.collapse')
        : t('sidebar.expand')
      : collapsed
        ? t('sidebar.expand')
        : t('sidebar.collapse');
  // /RESPONSIVE-SECTION
  return (
    <>
      {/* RESPONSIVE-SECTION — mobile hamburger handle. Lives outside
          the aside so it's visible even when the drawer is closed. */}
      {mode === 'mobile' && !mobileOpen ? (
        <button
          type="button"
          className={styles.mobileHandle}
          data-viewport={mode}
          data-testid="sidebar-mobile-handle"
          aria-label={t('sidebar.expand')}
          onClick={openMobile}
        >
          <PanelLeft size={18} strokeWidth={1.5} />
        </button>
      ) : null}
      {mode === 'mobile' && mobileOpen ? (
        <div
          className={styles.mobileBackdrop}
          data-testid="sidebar-mobile-backdrop"
          aria-hidden="true"
          onClick={closeMobile}
        />
      ) : null}
      {/* /RESPONSIVE-SECTION */}
    <aside
      className={`${styles.root} ${collapsed ? styles.collapsed : ''}`}
      data-viewport={mode}
      data-mobile-open={mode === 'mobile' ? (mobileOpen ? 'true' : 'false') : undefined}
      onPointerDown={mode === 'mobile' ? onMobilePointerDown : undefined}
      onPointerMove={mode === 'mobile' ? onMobilePointerMove : undefined}
      onPointerUp={mode === 'mobile' ? onMobilePointerUp : undefined}
      onPointerCancel={mode === 'mobile' ? onMobilePointerUp : undefined}
    >
      <div className={styles.brand}>
        {collapsed ? null : (
          <>
            <span className={styles.brandMark} aria-hidden="true">
              ◆
            </span>
            <span className={styles.brandWord}>{t('brand.name')}</span>
          </>
        )}
        <button
          type="button"
          className={styles.collapseBtn}
          aria-label={collapseAriaLabel}
          onClick={onCollapseToggle}
        >
          {collapsed ? (
            <PanelLeft size={16} strokeWidth={1.5} />
          ) : (
            <PanelLeftClose size={16} strokeWidth={1.5} />
          )}
        </button>
      </div>

      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.cta}
          onClick={onNewChat}
          disabled={noProject}
          aria-label={t('sidebar.newSession')}
          title={t('sidebar.newSession')}
        >
          <Plus size={14} strokeWidth={1.75} />
          {collapsed ? null : <span>{t('sidebar.newSession')}</span>}
        </button>
        <button
          type="button"
          className={styles.filterBtn}
          onClick={openSessionSearch}
          aria-label={t('sessionSearch.openAria')}
          title={t('sessionSearch.open')}
        >
          <Search size={14} strokeWidth={1.75} />
        </button>
        {collapsed ? null : (
          <div className={styles.filterAnchor}>
            <button
              type="button"
              className={styles.filterBtn}
              onClick={() =>
                sidebarFilterOpen ? closeSidebarFilter() : openSidebarFilter()
              }
              aria-label={t('sidebar.groupSessions')}
              aria-haspopup="menu"
              aria-expanded={sidebarFilterOpen}
              title={t('sidebar.groupSessions')}
            >
              <SlidersHorizontal size={14} strokeWidth={1.75} />
            </button>
            {sidebarFilterOpen ? (
              <SidebarFilterMenu onClose={closeSidebarFilter} />
            ) : null}
          </div>
        )}
      </div>

      {collapsed ? (
        <div className={styles.collapsedSpacer} aria-hidden="true" />
      ) : (
        <div className={styles.list}>{renderListBody()}</div>
      )}

      {collapsed ? null : <ProjectSwitcher onAddProject={onAddProject} />}

      <div className={styles.footerActions}>
        <button
          type="button"
          className={styles.footerBtn}
          aria-label={t('sidebar.settings.open')}
          title={t('sidebar.settings')}
          onClick={onOpenSettings}
        >
          <Settings size={16} strokeWidth={1.5} />
          {collapsed ? null : <span>{t('sidebar.settings')}</span>}
        </button>
      </div>

      <VersionFooter collapsed={collapsed} />

      {pendingDelete !== null ? (
        <ConfirmDeleteProjectDialog
          label={pendingDelete.label}
          sessionCount={pendingDelete.sessionCount}
          onCancel={() => setPendingDelete(null)}
          onConfirm={handleConfirmDelete}
        />
      ) : null}
    </aside>
    </>
  );
}
