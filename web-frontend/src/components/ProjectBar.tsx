/**
 * ProjectBar — sticky 36px header at top of the main column.
 *
 * Renders breadcrumb `<folder> / <session-title>`. Clicking the folder
 * crumb opens the sidebar's ProjectSwitcher (via the
 * `projectSwitcherOpen` store flag). Right side: file-browser toggle +
 * optional token usage.
 */

import type { JSX } from 'react';

import { useT } from '../i18n';
import {
  BarChart3,
  FileText,
  FolderOpen,
  Globe,
  MessageSquare,
  UserCog,
  Users,
} from '../icons';
import { useStore } from '../state/store';

import { ContextUsageRing } from './ContextUsageRing';
import { WakeupBadge } from './WakeupBadge';
import { LocaleToggle } from './LocaleToggle';
// NOTIFICATION-BELL-MOUNT-SECTION
import { NotificationBell } from './NotificationBell';
// /NOTIFICATION-BELL-MOUNT-SECTION
import styles from './ProjectBar.module.css';
import { ThemeToggle } from './ThemeToggle';

export interface ProjectBarProps {
  /** Optional usage data — when omitted nothing renders on the right. */
  usage?: { used: number; max: number };
}

function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = (n / 1000).toFixed(1);
    return `${k.replace(/\.0$/, '')}K`;
  }
  return String(n);
}

function tokenClass(ratio: number): string {
  if (ratio >= 0.85) return styles.tokensDanger ?? '';
  if (ratio >= 0.6) return styles.tokensWarning ?? '';
  return styles.tokensOk ?? '';
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function ProjectBar({ usage }: ProjectBarProps): JSX.Element {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const openProjectSwitcher = useStore((s) => s.openProjectSwitcher);
  const toggleFileBrowser = useStore((s) => s.toggleFileBrowser);
  const toggleBrowserPanel = useStore((s) => s.toggleBrowserPanel);
  const browserOpen = useStore((s) => s.browser.open);
  const toggleAgentTeamPanel = useStore((s) => s.toggleAgentTeamPanel);
  const agentTeamPanelOpen = useStore((s) => s.agentTeamPanelOpen);
  const toggleTasksPanel = useStore((s) => s.toggleTasksPanel);
  const tasksPanelOpen = useStore((s) => s.tasksPanelOpen);
  const agentTree = useStore((s) => s.agentTree);
  const openAgentsConfig = useStore((s) => s.openAgentsConfig);
  const openUsageDashboard = useStore((s) => s.openUsageDashboard);
  const usageDashboardOpen = useStore((s) => s.usageDashboardOpen);
  const openMemoryOverlay = useStore((s) => s.openMemoryOverlay);
  const closeMemoryOverlay = useStore((s) => s.closeMemoryOverlay);
  const memoryOverlayOpen = useStore((s) => s.memoryOverlayOpen);

  const totalAgents = (() => {
    let n = 0;
    for (const list of Object.values(agentTree)) n += list.length;
    return n;
  })();

  // Context-usage ring inputs — read from the global store so the
  // ProjectBar updates whenever ChatView mirrors a fresh `usage` event
  // into the slice. The session.model takes precedence over
  // currentModel because session-pinned models don't always equal the
  // provider's current default.
  const latestUsage = useStore((s) => s.latestUsage);
  const currentModel = useStore((s) => s.currentModel);
  const currentMaxContextTokens = useStore((s) => s.currentMaxContextTokens);

  const activeWorkspace =
    projects.find((p) => p.id === activeProjectId) ?? null;
  const activeSession =
    sessions.find((s) => s.id === activeSessionId) ?? null;
  const ringModelId = activeSession?.model ?? currentModel ?? null;

  const folder =
    activeWorkspace !== null
      ? activeWorkspace.label !== ''
        ? activeWorkspace.label
        : basename(activeWorkspace.root)
      : null;

  const sessionTitle =
    activeSession !== null && activeSession.title !== null
      ? activeSession.title
      : t('sessionRow.newChat');

  return (
    <header className={styles.root}>
      {folder !== null ? (
        <span className={styles.crumb} aria-label={t('projectBar.aria')}>
          <button
            type="button"
            className={styles.folder}
            onClick={openProjectSwitcher}
            title={t('projectBar.switchProject')}
            aria-label={t('projectBar.switchProject')}
          >
            {folder}
          </button>
          <span className={styles.sep} aria-hidden="true">/</span>
          <span className={styles.session}>{sessionTitle}</span>
        </span>
      ) : null}
      <span className={styles.spacer} />
      <LocaleToggle />
      <ThemeToggle />
      <button
        type="button"
        className={styles.iconBtn}
        onClick={openAgentsConfig}
        aria-label={t('projectBar.configureAgents')}
        title={t('projectBar.configureAgents')}
      >
        <UserCog size={14} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className={`${styles.iconBtn} ${tasksPanelOpen ? styles.iconBtnActive ?? '' : ''}`}
        onClick={toggleTasksPanel}
        aria-label={t('tasksPanel.label')}
        aria-pressed={tasksPanelOpen}
        title={t('tasksPanel.title')}
        data-testid="projectbar-tasks"
      >
        <MessageSquare size={14} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className={`${styles.iconBtn} ${agentTeamPanelOpen ? styles.iconBtnActive ?? '' : ''}`}
        onClick={toggleAgentTeamPanel}
        aria-label={t('projectBar.agentTeam.toggle')}
        aria-pressed={agentTeamPanelOpen}
        title={t('projectBar.agentTeam')}
        data-testid="projectbar-agents"
      >
        <Users size={14} strokeWidth={1.5} />
        {totalAgents > 0 ? (
          <span className={styles.iconBadge} aria-hidden="true">
            {totalAgents}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className={`${styles.iconBtn} ${browserOpen ? styles.iconBtnActive ?? '' : ''}`}
        onClick={toggleBrowserPanel}
        aria-label={t('projectBar.browser.toggle')}
        aria-pressed={browserOpen}
        title={t('projectBar.browser')}
        data-testid="projectbar-browser"
      >
        <Globe size={14} strokeWidth={1.5} />
      </button>
      {latestUsage !== null && ringModelId !== null ? (
        <ContextUsageRing
          tokensIn={latestUsage.tokensIn}
          modelId={ringModelId}
          configMaxTokens={currentMaxContextTokens}
        />
      ) : null}
      <WakeupBadge />
      {/* NOTIFICATION-BELL-MOUNT-SECTION */}
      <NotificationBell />
      {/* /NOTIFICATION-BELL-MOUNT-SECTION */}
      <button
        type="button"
        className={`${styles.iconBtn} ${usageDashboardOpen ? styles.iconBtnActive ?? '' : ''}`}
        onClick={openUsageDashboard}
        aria-label={t('usageDashboard.open')}
        aria-pressed={usageDashboardOpen}
        title={t('usageDashboard.open')}
        data-testid="projectbar-usage"
      >
        <BarChart3 size={14} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className={`${styles.iconBtn} ${memoryOverlayOpen ? styles.iconBtnActive ?? '' : ''}`}
        onClick={memoryOverlayOpen ? closeMemoryOverlay : openMemoryOverlay}
        aria-label={t('memory.manage')}
        aria-pressed={memoryOverlayOpen}
        title={t('memory.title')}
        data-testid="projectbar-memory"
      >
        <FileText size={14} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className={styles.iconBtn}
        onClick={toggleFileBrowser}
        aria-label={t('projectBar.fileBrowser.open')}
        title={t('projectBar.fileBrowser')}
        data-testid="projectbar-files"
      >
        <FolderOpen size={14} strokeWidth={1.5} />
      </button>
      {usage !== undefined && usage.max > 0 ? (
        <span
          className={`${styles.tokens} ${tokenClass(usage.used / usage.max)}`}
          aria-label={t('projectBar.tokenUsage', {
            used: usage.used,
            max: usage.max,
          })}
        >
          {formatTokens(usage.used)} / {formatTokens(usage.max)}
        </span>
      ) : null}
    </header>
  );
}
