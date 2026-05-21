/**
 * /todos — show the current session's task list in the TUI, or open
 * the TasksPanel in the web frontend.
 *
 * TUI: prints the full todos list using `ctx.print`.
 * Web: prints a short summary (the web TasksPanel auto-opens via the
 *   `todos_updated` WS frame; this command surfaces content in chat
 *   for TUI parity).
 *
 * The command does NOT modify the list — it is read-only.
 */

import type { CommandContext, SlashCommand } from '@/types/global';

// Minimal subset of SessionManager the command needs.
interface TodoSessionManager {
  getTodos(sessionId: string): Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
  }>;
}

export interface TodosDeps {
  /**
   * Returns the current session id. May return `null` when no session
   * is active yet (e.g. before the first message is sent).
   */
  getSessionId: () => string | null;
  sessionManager: TodoSessionManager;
}

function statusEmoji(status: 'pending' | 'in_progress' | 'completed'): string {
  switch (status) {
    case 'pending':
      return '○';
    case 'in_progress':
      return '◷';
    case 'completed':
      return '✓';
  }
}

export function createTodosCommand(deps: TodosDeps): SlashCommand {
  return {
    name: 'todos',
    description: 'Show the current session task list.',
    usage: '/todos',
    execute: async (_args: string, ctx: CommandContext): Promise<void> => {
      const sessionId = deps.getSessionId();
      if (sessionId === null) {
        ctx.print('No active session.');
        return;
      }

      const todos = deps.sessionManager.getTodos(sessionId);
      if (todos.length === 0) {
        ctx.print('No tasks recorded for this session.');
        return;
      }

      const done = todos.filter((t) => t.status === 'completed').length;
      const active = todos.filter((t) => t.status === 'in_progress').length;
      const pending = todos.filter((t) => t.status === 'pending').length;

      ctx.print(`Tasks (${done} done · ${active} active · ${pending} pending):`);
      ctx.print('');
      todos.forEach((todo, i) => {
        const icon = statusEmoji(todo.status);
        const label = todo.status === 'in_progress' ? todo.activeForm : todo.content;
        ctx.print(`  ${icon} ${i + 1}. ${label}`);
      });
    },
  };
}
