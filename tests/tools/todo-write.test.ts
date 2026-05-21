/**
 * Tests for the `todo_write` tool handler.
 *
 * Covers:
 *   - Full list replacement
 *   - Zod validation rejects bad shape
 *   - Empty array clears the list
 *   - Persists via sessionManager when context is wired
 *   - Skips persistence when context fields are absent
 */

import { test, expect } from 'bun:test';
import { todoWrite } from '../../src/tools/todo-write';
import type { ToolContext } from '../../src/tools/types';

// ---------- Minimal fake SessionManager ----------

interface StoredTodos {
  todos: unknown[];
}

function makeCtx(store: StoredTodos, sessionId = 'sess-1'): ToolContext {
  return {
    projectRoot: '/tmp',
    dangerouslyAllowAll: false,
    sessionId,
    sessionManager: {
      setTodos(_sid: string, todos: unknown[]) {
        store.todos = [...todos];
      },
    },
  };
}

// ---------- Tests ----------

test('returns success with count for a valid list', async () => {
  const store: StoredTodos = { todos: [] };
  const result = await todoWrite(
    {
      todos: [
        { content: 'Fix bug', status: 'pending', activeForm: 'Fixing bug' },
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      ],
    },
    makeCtx(store),
  );
  expect(result.success).toBe(true);
  expect(result.output).toBe('2 todos updated');
});

test('persists todos to sessionManager', async () => {
  const store: StoredTodos = { todos: [] };
  await todoWrite(
    {
      todos: [
        { content: 'Task A', status: 'completed', activeForm: 'Completing Task A' },
      ],
    },
    makeCtx(store),
  );
  expect(store.todos).toHaveLength(1);
  const first = store.todos[0] as { content: string };
  expect(first.content).toBe('Task A');
});

test('empty array clears the list and returns "0 todos updated"', async () => {
  const store: StoredTodos = { todos: [{ content: 'old', status: 'pending', activeForm: 'Doing old' }] };
  const result = await todoWrite({ todos: [] }, makeCtx(store));
  expect(result.success).toBe(true);
  expect(result.output).toBe('0 todos updated');
  expect(store.todos).toHaveLength(0);
});

test('replaces the full list, not appends', async () => {
  const store: StoredTodos = { todos: [] };
  const ctx = makeCtx(store);

  await todoWrite(
    { todos: [{ content: 'First', status: 'pending', activeForm: 'Doing First' }] },
    ctx,
  );
  await todoWrite(
    { todos: [{ content: 'Second', status: 'in_progress', activeForm: 'Doing Second' }] },
    ctx,
  );

  expect(store.todos).toHaveLength(1);
  const first = store.todos[0] as { content: string };
  expect(first.content).toBe('Second');
});

test('Zod rejects missing content field', async () => {
  const store: StoredTodos = { todos: [] };
  const result = await todoWrite(
    {
      todos: [
        // content is missing
        { status: 'pending', activeForm: 'Doing something' },
      ],
    },
    makeCtx(store),
  );
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/Invalid todo_write/);
});

test('Zod rejects unknown status value', async () => {
  const store: StoredTodos = { todos: [] };
  const result = await todoWrite(
    {
      todos: [
        { content: 'Task', status: 'done', activeForm: 'Doing Task' }, // 'done' is invalid
      ],
    },
    makeCtx(store),
  );
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/Invalid todo_write/);
});

test('Zod rejects non-array todos', async () => {
  const store: StoredTodos = { todos: [] };
  const result = await todoWrite(
    { todos: 'not an array' },
    makeCtx(store),
  );
  expect(result.success).toBe(false);
});

test('succeeds without persistence when sessionId is absent', async () => {
  const ctx: ToolContext = { projectRoot: '/tmp', dangerouslyAllowAll: false };
  const result = await todoWrite(
    { todos: [{ content: 'T', status: 'pending', activeForm: 'Doing T' }] },
    ctx,
  );
  expect(result.success).toBe(true);
});
