/**
 * AgentTeamPanel — floating right-side viewer for active sub-agent
 * teams. Shows the per-session agent roster with live status, plus a
 * "Team chat" log of inter-agent messages.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';

import type { AgentNode, AgentRunStatus, TeamMessage } from '../state/store';
import { useStore } from '../state/store';
import { useT } from '../i18n';
import type { TranslationKey } from '../i18n';
import { Users, X } from '../icons';
import { truncate } from '../util/truncate';

import styles from './AgentTeamPanel.module.css';

function statusPillClass(status: AgentRunStatus): string {
  switch (status) {
    case 'running':
      return `${styles.statusPill} ${styles.statusRunning}`;
    case 'done':
      return `${styles.statusPill} ${styles.statusDone}`;
    case 'failed':
      return `${styles.statusPill} ${styles.statusFailed}`;
    case 'cancelled':
      return `${styles.statusPill} ${styles.statusCancelled}`;
  }
}

function shortAgentId(id: string): string {
  if (id.length <= 8) return id;
  return id.slice(0, 8);
}

function shortModel(model: string): string {
  const idx = model.lastIndexOf('/');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

function formatElapsed(startedAt: number, completedAt: number | undefined, now: number): string {
  const end = completedAt ?? now;
  const ms = Math.max(0, end - startedAt);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

interface AgentRowProps {
  agent: AgentNode;
  expanded: boolean;
  onToggle: () => void;
  now: number;
  // AGENT-LIFECYCLE-SECTION
  /** True when this agent is the active reply target — highlight + show "× exit". */
  replyActive: boolean;
  /** Enter reply-mode for this agent (only valid while status === 'running'). */
  onReply: () => void;
  /** Cancel reply-mode (only fires when this row is the active target). */
  onExitReply: () => void;
  // /AGENT-LIFECYCLE-SECTION
}

function statusKey(status: AgentRunStatus): TranslationKey {
  switch (status) {
    case 'running':
      return 'agentTeam.status.running';
    case 'done':
      return 'agentTeam.status.done';
    case 'failed':
      return 'agentTeam.status.failed';
    case 'cancelled':
      return 'agentTeam.status.cancelled';
  }
}

function AgentRow({
  agent,
  expanded,
  onToggle,
  now,
  // AGENT-LIFECYCLE-SECTION
  replyActive,
  onReply,
  onExitReply,
  // /AGENT-LIFECYCLE-SECTION
}: AgentRowProps): JSX.Element {
  const t = useT();
  const [diffOpen, setDiffOpen] = useState(false);
  const elapsed = formatElapsed(agent.startedAt, agent.completedAt, now);
  // AGENT-LIFECYCLE-SECTION
  // Only running agents can receive new user messages. Completed rows
  // surface the transcript via expand but cannot enter reply-mode.
  const canReply = agent.status === 'running';
  const rowClass = replyActive
    ? `${styles.agentRow} ${styles.agentRowReplyActive}`
    : styles.agentRow;
  // /AGENT-LIFECYCLE-SECTION
  return (
    <div
      className={rowClass}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      aria-expanded={expanded}
      aria-label={`Agent ${shortAgentId(agent.agentId)}`}
      data-reply-active={replyActive ? 'true' : 'false'}
    >
      <div className={styles.agentTopLine}>
        <span className={styles.agentId}>{shortAgentId(agent.agentId)}</span>
        <span className={styles.modelBadge}>{shortModel(agent.model)}</span>
        <span className={statusPillClass(agent.status)}>
          {t(statusKey(agent.status))}
        </span>
        <span className={styles.elapsed}>{elapsed}</span>
        {/* AGENT-LIFECYCLE-SECTION — reply / exit-reply chip */}
        {canReply && !replyActive ? (
          <button
            type="button"
            className={styles.replyBtn}
            onClick={(e) => {
              e.stopPropagation();
              onReply();
            }}
            aria-label={t('agentTeam.replyAria', {
              id: shortAgentId(agent.agentId),
            })}
            title={t('agentTeam.reply')}
            data-testid={`agent-row-reply-${agent.agentId}`}
          >
            {t('agentTeam.reply')}
          </button>
        ) : null}
        {replyActive ? (
          <button
            type="button"
            className={`${styles.replyBtn} ${styles.replyBtnActive}`}
            onClick={(e) => {
              e.stopPropagation();
              onExitReply();
            }}
            aria-label={t('agentTeam.exitReplyAria')}
            title={t('agentTeam.exitReply')}
            data-testid={`agent-row-exit-reply-${agent.agentId}`}
          >
            {`× ${t('agentTeam.exitReply')}`}
          </button>
        ) : null}
        {/* /AGENT-LIFECYCLE-SECTION */}
      </div>
      <div className={styles.task}>{truncate(agent.task, 80)}</div>
      {expanded ? (
        <div className={styles.expanded} onClick={(e) => e.stopPropagation()}>
          {agent.ownedFiles.length > 0 ? (
            <div>
              <div className={styles.label}>{t('agentTeam.ownedFiles')}</div>
              <ul className={styles.fileList}>
                {agent.ownedFiles.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {agent.worktreePath !== undefined && agent.worktreePath.length > 0 ? (
            <div>
              <div className={styles.label}>{t('agentTeam.worktree')}</div>
              <div className={styles.task}>{agent.worktreePath}</div>
            </div>
          ) : null}
          {agent.lastMessage !== undefined && agent.lastMessage.length > 0 ? (
            <div>
              <div className={styles.label}>{t('agentTeam.lastMessage')}</div>
              <div className={styles.lastMessage}>{agent.lastMessage}</div>
            </div>
          ) : null}
          {agent.error !== undefined && agent.error.length > 0 ? (
            <div>
              <div className={styles.label}>{t('agentTeam.error')}</div>
              <div className={styles.errorText}>{agent.error}</div>
            </div>
          ) : null}
          {agent.summary !== undefined && agent.summary.length > 0 ? (
            <div>
              <div className={styles.label}>{t('agentTeam.summary')}</div>
              <div className={styles.summary}>{agent.summary}</div>
            </div>
          ) : null}
          {agent.diff !== undefined && agent.diff.length > 0 ? (
            <div>
              <button
                type="button"
                className={styles.diffToggle}
                onClick={() => setDiffOpen((v) => !v)}
                aria-expanded={diffOpen}
              >
                {diffOpen ? t('agentTeam.hideDiff') : t('agentTeam.showDiff')}
              </button>
              {diffOpen ? <pre className={styles.diff}>{agent.diff}</pre> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface TeamChatProps {
  messages: TeamMessage[];
}

function TeamChat({ messages }: TeamChatProps): JSX.Element {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef<boolean>(true);

  const handleScroll = (): void => {
    const el = bodyRef.current;
    if (el === null) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceFromBottom < 24;
  };

  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = bodyRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className={styles.teamChat}>
      <div className={styles.sectionHeader}>{t('agentTeam.teamChat')}</div>
      <div
        className={styles.teamChatBody}
        ref={bodyRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <div className={styles.teamChatEmpty}>{t('agentTeam.teamChatEmpty')}</div>
        ) : (
          messages.map((m) => {
            const broadcast = m.to === 'all';
            return (
              <div key={m.id} className={styles.teamMsg}>
                <span className={styles.teamMsgFrom}>{shortAgentId(m.from)}</span>
                <span className={styles.teamMsgArrow}>→</span>
                <span
                  className={
                    broadcast
                      ? `${styles.teamMsgTo} ${styles.teamMsgBroadcast}`
                      : styles.teamMsgTo
                  }
                >
                  {broadcast ? `📢 ${t('agentTeam.broadcast')}` : shortAgentId(m.to)}
                </span>
                <span className={styles.teamMsgText}>: {m.message}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export function AgentTeamPanel(): JSX.Element | null {
  const t = useT();
  const open = useStore((s) => s.agentTeamPanelOpen);
  const closePanel = useStore((s) => s.closeAgentTeamPanel);
  const agentTree = useStore((s) => s.agentTree);
  const teamMessages = useStore((s) => s.teamMessages);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  // AGENT-LIFECYCLE-SECTION
  // Reply-mode wiring: clicking an agent row enters reply mode (Composer
  // header + routing live in Composer.tsx). We surface the active target
  // here to highlight the selected row.
  const agentReplyTarget = useStore((s) => s.agentReplyTarget);
  const enterAgentReply = useStore((s) => s.enterAgentReply);
  const exitAgentReply = useStore((s) => s.exitAgentReply);
  // /AGENT-LIFECYCLE-SECTION

  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  // AGENT-LIFECYCLE-SECTION
  // Default: only show currently-running agents — completed/failed/
  // cancelled rows fall out of the "active" view but stay reachable via
  // the toggle (preserved for the historical/audit perspective).
  const [showCompleted, setShowCompleted] = useState<boolean>(false);
  // /AGENT-LIFECYCLE-SECTION

  // Tick once per second so elapsed times stay live for running agents.
  useEffect(() => {
    if (!open) return;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [open]);

  const sessionLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) {
      m.set(
        s.id,
        s.title !== null && s.title.length > 0 ? s.title : t('sessionRow.newChat'),
      );
    }
    return m;
  }, [sessions, t]);

  // AGENT-LIFECYCLE-SECTION
  // Per-session filtering: hide terminal rows by default; surface them
  // again when the user toggles `Show completed`. We also count the
  // hidden rows so the toggle label can show a useful badge.
  const sessionEntries = useMemo<Array<[string, AgentNode[]]>>(() => {
    const entries = Object.entries(agentTree)
      .map<[string, AgentNode[]]>(([sid, list]) => [
        sid,
        showCompleted ? list : list.filter((a) => a.status === 'running'),
      ])
      .filter(([, list]) => list.length > 0);
    entries.sort(([a], [b]) => {
      if (a === activeSessionId) return -1;
      if (b === activeSessionId) return 1;
      return a.localeCompare(b);
    });
    return entries;
  }, [agentTree, activeSessionId, showCompleted]);

  const totalAgents = useMemo(() => {
    let n = 0;
    for (const [, list] of sessionEntries) n += list.length;
    return n;
  }, [sessionEntries]);

  const hiddenCompletedCount = useMemo(() => {
    if (showCompleted) return 0;
    let n = 0;
    for (const list of Object.values(agentTree)) {
      for (const a of list) if (a.status !== 'running') n += 1;
    }
    return n;
  }, [agentTree, showCompleted]);
  // /AGENT-LIFECYCLE-SECTION

  const activeMessages = useMemo<TeamMessage[]>(() => {
    if (activeSessionId === null) return [];
    return teamMessages[activeSessionId] ?? [];
  }, [teamMessages, activeSessionId]);

  if (!open) return null;

  return (
    <aside
      className={styles.panel}
      role="complementary"
      aria-label={t('agentTeam.title')}
    >
      <header className={styles.header}>
        <Users size={14} strokeWidth={1.5} />
        <span className={styles.title}>{t('agentTeam.title')}</span>
        {totalAgents > 0 ? (
          <span className={styles.countBadge} aria-label={`${totalAgents}`}>
            {totalAgents}
          </span>
        ) : null}
        <span className={styles.spacer} />
        {/* AGENT-LIFECYCLE-SECTION */}
        <label
          className={styles.showCompletedLabel}
          title={t('agentTeam.showCompletedTooltip')}
        >
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            data-testid="agent-team-show-completed"
          />
          <span>{t('agentTeam.showCompleted')}</span>
          {hiddenCompletedCount > 0 ? (
            <span className={styles.hiddenBadge}>
              {`+${hiddenCompletedCount}`}
            </span>
          ) : null}
        </label>
        {/* /AGENT-LIFECYCLE-SECTION */}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={closePanel}
          aria-label={t('agentTeam.close')}
          title={t('common.close')}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </header>

      <div className={styles.body}>
        {sessionEntries.length === 0 ? (
          <div className={styles.empty}>
            {t('agentTeam.empty')}
          </div>
        ) : (
          sessionEntries.map(([sid, list]) => (
            <div key={sid} className={styles.section}>
              <div className={styles.sectionHeader}>
                {sessionLookup.get(sid) ?? sid}
              </div>
              {list.map((agent) => {
                // AGENT-LIFECYCLE-SECTION
                const isReplyTarget =
                  agentReplyTarget !== null &&
                  agentReplyTarget.parentSessionId === sid &&
                  agentReplyTarget.agentId === agent.agentId;
                return (
                  <AgentRow
                    key={agent.agentId}
                    agent={agent}
                    expanded={expandedAgent === agent.agentId}
                    onToggle={() =>
                      setExpandedAgent((cur) =>
                        cur === agent.agentId ? null : agent.agentId,
                      )
                    }
                    now={now}
                    replyActive={isReplyTarget}
                    onReply={() =>
                      enterAgentReply({
                        parentSessionId: sid,
                        agentId: agent.agentId,
                        label: shortAgentId(agent.agentId),
                      })
                    }
                    onExitReply={exitAgentReply}
                  />
                );
                // /AGENT-LIFECYCLE-SECTION
              })}
            </div>
          ))
        )}
      </div>

      <TeamChat messages={activeMessages} />
    </aside>
  );
}
