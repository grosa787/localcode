/**
 * ToolCallCard — collapsed-by-default card representing a tool invocation.
 *
 * Header layout:
 *   [icon] [name 14px 500] [duration 12px faint] [chevron]
 *
 * Body (when expanded):
 *   - For write_file/edit_file with a diff preview → InlineDiff.
 *   - For run_command → command box.
 *   - For fetch_image → "Open URL: …" with a clickable link.
 *   - Otherwise → preview text in a `<pre>` block.
 *
 * The component is purely presentational; the parent feeds it the
 * tool-call args and the optional `result` / `preview` once they
 * arrive.
 */

import { memo, useState, type JSX } from 'react';

import { useT } from '../i18n';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Edit,
  File,
  FolderOpen,
  Loader2,
  Search,
  Terminal,
} from '../icons';

import { InlineDiff } from './InlineDiff';

import styles from './ToolCallCard.module.css';

export type ToolStatus = 'pending' | 'awaiting_approval' | 'running' | 'ok' | 'error';

export interface ToolCallCardProps {
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  /** Duration in ms, when known. */
  durationMs?: number;
  /** Plain-text preview/result body (server-truncated). */
  preview?: string;
  /** Error message — present when status is 'error'. */
  error?: string;
  /**
   * Optional structured diff used when the tool is a writer/editor and
   * the server has supplied old/new content via approval bridge.
   */
  diff?: { path: string; oldContent: string; newContent: string };
  /** Optional command preview (for run_command). */
  command?: { command: string; cwd: string };
}

const TOOL_ICONS: Record<string, typeof File> = {
  read_file: File,
  write_file: Edit,
  edit_file: Edit,
  list_dir: FolderOpen,
  glob_search: Search,
  grep_search: Search,
  run_command: Terminal,
  fetch_image: File,
};

function pickIcon(name: string): typeof File {
  return TOOL_ICONS[name] ?? File;
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ToolCallCardImpl(props: ToolCallCardProps): JSX.Element {
  const t = useT();
  const [expanded, setExpanded] = useState(props.status === 'error');
  const Icon = pickIcon(props.name);
  const duration = formatDuration(props.durationMs);

  const onToggle = (): void => setExpanded((v) => !v);
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onToggle();
    }
  };

  const StatusIcon = (() => {
    if (props.status === 'running' || props.status === 'awaiting_approval' || props.status === 'pending') {
      return <Loader2 className={styles.spin} size={14} strokeWidth={1.5} />;
    }
    if (props.status === 'error') {
      return <AlertTriangle size={14} strokeWidth={1.5} />;
    }
    return null;
  })();

  return (
    <div
      className={styles.root}
      data-status={props.status}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <button
        type="button"
        className={styles.header}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        aria-expanded={expanded}
        aria-controls={`tool-body-${props.name}`}
      >
        <span className={styles.headerIcon}>
          <Icon size={16} strokeWidth={1.5} />
        </span>
        <span className={styles.name}>{props.name}</span>
        <span className={styles.argsSummary}>{summariseArgs(props.name, props.args)}</span>
        <span className={styles.spacer} />
        {StatusIcon !== null ? <span className={styles.statusIcon}>{StatusIcon}</span> : null}
        {duration !== null ? <span className={styles.duration}>{duration}</span> : null}
        <span className={styles.chevron} aria-hidden="true">
          {expanded ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronRight size={16} strokeWidth={1.5} />}
        </span>
      </button>
      {expanded ? (
        <div className={styles.body} id={`tool-body-${props.name}`}>
          {renderBody(props, t)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Memoised: parents (ChatView) re-render on every Composer keystroke;
 * the tool card props are stable across those re-renders so a shallow
 * compare lets React skip the subtree entirely.
 */
export const ToolCallCard = memo(ToolCallCardImpl);

function summariseArgs(toolName: string, args: Record<string, unknown>): string {
  const path = typeof args['path'] === 'string' ? args['path'] : null;
  const command = typeof args['command'] === 'string' ? args['command'] : null;
  const url = typeof args['url'] === 'string' ? args['url'] : null;
  const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : null;

  if (toolName === 'run_command' && command !== null) {
    return command;
  }
  if ((toolName === 'glob_search' || toolName === 'grep_search') && pattern !== null) {
    return pattern;
  }
  if (path !== null) return path;
  if (url !== null) return url;
  return '';
}

function renderBody(
  props: ToolCallCardProps,
  t: (key: import('../i18n').TranslationKey) => string,
): JSX.Element {
  if (props.status === 'error' && props.error !== undefined) {
    return (
      <div className={styles.error}>
        <AlertTriangle size={14} strokeWidth={1.5} />
        <span>{props.error}</span>
      </div>
    );
  }
  if (props.diff !== undefined) {
    return (
      <InlineDiff
        path={props.diff.path}
        oldContent={props.diff.oldContent}
        newContent={props.diff.newContent}
      />
    );
  }
  if (props.command !== undefined) {
    return (
      <div className={styles.commandBox}>
        <div className={styles.cmdLabel}>cwd</div>
        <div className={styles.cwd}>{props.command.cwd}</div>
        <pre className={styles.cmd}>$ {props.command.command}</pre>
      </div>
    );
  }
  if (props.preview !== undefined && props.preview.length > 0) {
    return <pre className={styles.preview}>{props.preview}</pre>;
  }
  return <div className={styles.empty}>{t('tool.empty')}</div>;
}
