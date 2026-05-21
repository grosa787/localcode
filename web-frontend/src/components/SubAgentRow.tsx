/**
 * SubAgentRow — single sub-agent entry inside a parent session group in
 * the sidebar. Indented further than SessionRow with a tree connector.
 */

import type { JSX } from 'react';

import { useT } from '../i18n';
import type { TranslationKey } from '../i18n';
import type { AgentNode, AgentRunStatus } from '../state/store';
import { truncate } from '../util/truncate';
import styles from './SubAgentRow.module.css';

export interface SubAgentRowProps {
  agent: AgentNode;
  active: boolean;
  /**
   * Optional click handler. When omitted the row is rendered as a
   * static (non-interactive) UI element — used while sub-agent session
   * selection is not yet wired up.
   */
  onSelect?: (subSessionId: string) => void;
}

function dotClass(status: AgentRunStatus): string {
  switch (status) {
    case 'running':
      return `${styles.dot} ${styles.dotRunning}`;
    case 'done':
      return `${styles.dot} ${styles.dotDone}`;
    case 'failed':
      return `${styles.dot} ${styles.dotFailed}`;
    case 'cancelled':
      return `${styles.dot} ${styles.dotCancelled}`;
  }
}

function statusKey(status: AgentRunStatus): TranslationKey {
  switch (status) {
    case 'running':
      return 'subAgent.status.running';
    case 'done':
      return 'subAgent.status.done';
    case 'failed':
      return 'subAgent.status.failed';
    case 'cancelled':
      return 'subAgent.status.cancelled';
  }
}

function shortModel(model: string): string {
  // Strip provider prefixes ("anthropic/", "openrouter/").
  const idx = model.lastIndexOf('/');
  const tail = idx >= 0 ? model.slice(idx + 1) : model;
  return truncate(tail, 14);
}

export function SubAgentRow({
  agent,
  active,
  onSelect,
}: SubAgentRowProps): JSX.Element {
  const t = useT();
  const taskLabel = truncate(agent.task, 30);
  const subSessionId = `${agent.parentSessionId}.agent.${agent.agentId}`;
  const interactive = onSelect !== undefined;

  const className = `${styles.root} ${active ? styles.active : ''} ${
    interactive ? '' : styles.staticRow
  }`.trim();

  const handleClick = (): void => {
    if (onSelect !== undefined) onSelect(subSessionId);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect?.(subSessionId);
    }
  };

  const statusText = t(statusKey(agent.status));
  const tooltip = interactive
    ? `${agent.task} — ${statusText}`
    : `${agent.task} — ${statusText} ${t('subAgent.tooltip.suffix')}`;

  return (
    <div
      className={className}
      role={interactive ? 'button' : 'group'}
      tabIndex={interactive ? 0 : -1}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={handleKey}
      aria-current={active ? 'true' : undefined}
      aria-label={t('subAgent.aria', { id: agent.agentId, status: statusText })}
      title={tooltip}
    >
      <span
        className={dotClass(agent.status)}
        role="status"
        aria-label={statusText}
      />
      <span className={styles.modelBadge}>{shortModel(agent.model)}</span>
      <span className={styles.task}>{taskLabel}</span>
    </div>
  );
}
