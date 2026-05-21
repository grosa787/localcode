/**
 * todo_write tool handler — in-session task tracker.
 *
 * Semantics mirror the TodoWrite tool from Claude Code:
 *   - Single argument: `todos` — the COMPLETE replacement list.
 *   - Each call REPLACES the full list (not append).
 *   - Returns `{ success: true, output: '<n> todos updated' }`.
 *
 * Single-phase: no `commit` step, no approval prompt.
 * Persists via `SessionManager.setTodos` when `ctx.sessionId` and
 * `ctx.sessionManager` are wired in (they are in both TUI and web).
 * When the context fields are absent (e.g. unit tests that pass a
 * minimal context) the handler still succeeds but skips persistence.
 */

import { z } from 'zod';
import type { ToolContext, ToolResult } from './types';

// ---------- Zod schemas ----------

/** A single todo item as accepted by the tool. */
const TodoItemSchema = z.object({
  /** Imperative description, e.g. "Add tests for X". */
  content: z.string().min(1, 'content must be non-empty'),
  /** Lifecycle state of this task. */
  status: z.enum(['pending', 'in_progress', 'completed']),
  /** Present-continuous form, e.g. "Adding tests for X". */
  activeForm: z.string().min(1, 'activeForm must be non-empty'),
});

/** The full todo list passed by the model on each invocation. */
const TodoWriteArgsSchema = z.object({
  todos: z.array(TodoItemSchema),
});

export type TodoItem = z.infer<typeof TodoItemSchema>;
export type TodoWriteArgs = z.infer<typeof TodoWriteArgsSchema>;

// ---------- Minimal SessionManager surface needed by this tool ----------

/**
 * Subset of `SessionManager` that `todoWrite` consumes. Typed as a
 * separate interface to avoid importing the concrete class (which would
 * drag in all of bun:sqlite) and to keep this module test-friendly.
 */
interface TodoSessionManager {
  setTodos(sessionId: string, todos: readonly TodoItem[]): void;
}

function isTodoSessionManager(value: unknown): value is TodoSessionManager {
  return (
    value !== null &&
    typeof value === 'object' &&
    'setTodos' in value &&
    typeof (value as Record<string, unknown>)['setTodos'] === 'function'
  );
}

// ---------- Handler ----------

/**
 * Execute the `todo_write` tool.
 *
 * Validates args with Zod, persists the new list to the session row,
 * and returns a success result. Any Zod parse failure surfaces as a
 * tool error (success: false) so the model can correct its output.
 */
export async function todoWrite(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = TodoWriteArgsSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return {
      success: false,
      output: '',
      error: `Invalid todo_write arguments: ${issues}`,
    };
  }

  const { todos } = parsed.data;

  // Persist when the context provides the session plumbing.
  const { sessionId, sessionManager } = ctx;
  if (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    isTodoSessionManager(sessionManager)
  ) {
    try {
      sessionManager.setTodos(sessionId, todos);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return {
        success: false,
        output: '',
        error: `Failed to persist todos: ${msg}`,
      };
    }
  }

  const count = todos.length;
  return {
    success: true,
    output: `${count} todo${count === 1 ? '' : 's'} updated`,
  };
}

export { TodoWriteArgsSchema };
