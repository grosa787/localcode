/**
 * TasksPanel — floating right-side panel that shows the model's current
 * todo list. Auto-opens when the model first writes todos in a session;
 * can be collapsed by the user. Mirrors the AgentTeamPanel pattern.
 *
 * Status icons:
 *   pending     — empty circle  ○
 *   in_progress — clock         ◷
 *   completed   — check         ✓
 */

import { type JSX } from 'react';
import { useStore } from '../state/store';
import type { Todo } from '../state/store';
import { useT } from '../i18n';
import { X } from '../icons';

import styles from './TasksPanel.module.css';

function statusIcon(status: Todo['status']): string {
  switch (status) {
    case 'pending':
      return '○';
    case 'in_progress':
      return '◷';
    case 'completed':
      return '✓';
  }
}

function statusClass(status: Todo['status']): string {
  switch (status) {
    case 'pending':
      return styles.statusPending ?? '';
    case 'in_progress':
      return styles.statusInProgress ?? '';
    case 'completed':
      return styles.statusCompleted ?? '';
  }
}

interface TodoRowProps {
  todo: Todo;
  index: number;
}

function TodoRow({ todo, index }: TodoRowProps): JSX.Element {
  return (
    <div className={`${styles.todoRow} ${statusClass(todo.status)}`}>
      <span className={styles.statusIcon} aria-hidden="true">
        {statusIcon(todo.status)}
      </span>
      <span className={styles.todoIndex}>{index + 1}.</span>
      <span
        className={`${styles.todoContent} ${
          todo.status === 'completed' ? (styles.completed ?? '') : ''
        }`}
      >
        {todo.status === 'in_progress' ? todo.activeForm : todo.content}
      </span>
    </div>
  );
}

interface TasksPanelProps {
  sessionId: string | null;
  /**
   * When `false`, the panel omits its own "Tasks" header label so the
   * parent container (e.g. a modal/dock header) can supply the title.
   * Defaults to `true` for legacy floating-panel mode.
   */
  showTitle?: boolean;
}

export function TasksPanel({ sessionId, showTitle = true }: TasksPanelProps): JSX.Element | null {
  const t = useT();
  const tasksPanelOpen = useStore((s) => s.tasksPanelOpen);
  const closeTasksPanel = useStore((s) => s.closeTasksPanel);
  const sessionTodos = useStore((s) => s.sessionTodos);

  if (!tasksPanelOpen) return null;

  const todos: readonly Todo[] =
    sessionId !== null && sessionId !== undefined
      ? (sessionTodos[sessionId] ?? [])
      : [];

  const pending = todos.filter((t) => t.status === 'pending').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const completed = todos.filter((t) => t.status === 'completed').length;

  return (
    <aside className={styles.panel} aria-label={t('tasksPanel.label')}>
      <div className={styles.header}>
        {showTitle ? (
          <span className={styles.title}>{t('tasksPanel.title')}</span>
        ) : null}
        <div className={styles.summary}>
          {completed > 0 && (
            <span className={styles.summaryDone}>{completed} {t('tasksPanel.done')}</span>
          )}
          {inProgress > 0 && (
            <span className={styles.summaryActive}>{inProgress} {t('tasksPanel.active')}</span>
          )}
          {pending > 0 && (
            <span className={styles.summaryPending}>{pending} {t('tasksPanel.pending')}</span>
          )}
        </div>
        <button
          className={styles.closeBtn}
          onClick={closeTasksPanel}
          aria-label="Close tasks panel"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      <div className={styles.body}>
        {todos.length === 0 ? (
          <p className={styles.empty}>{t('tasksPanel.empty')}</p>
        ) : (
          <ol className={styles.list} aria-label={t('tasksPanel.listLabel')}>
            {todos.map((todo, i) => (
              <li key={i} className={styles.listItem}>
                <TodoRow todo={todo} index={i} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

export default TasksPanel;
