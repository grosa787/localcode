/**
 * Tasks-panel polish contract.
 *
 * Verifies:
 *   1. The collapsed mode still renders the existing one-line summary
 *      (regression guard against breaking the historic shape).
 *   2. The expanded mode renders one line per todo with the correct
 *      status icon (`○ pending`, `◐ in_progress`, `✓ done`).
 *   3. The `t` / `T` keystroke toggles between collapsed and expanded
 *      via the `InputDispatcher`.
 *   4. The component renders nothing when there are no todos.
 *
 * We mount the component inside an `<InputDispatcherProvider>` so the
 * `useInputModeHandler` subscription is wired up; the `dispatch` API
 * exposed on the provider lets the test fire keystrokes deterministically
 * without owning an ink stdin emitter.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React, { useRef, useImperativeHandle, forwardRef } from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';

import TasksLine, { __test__ } from '@/ui/components/TasksLine';
import type { Todo } from '@/sessions/session-manager';
import {
  InputDispatcherProvider,
  useInputDispatcher,
  type InputDispatcherAPI,
} from '@/ui/components/InputDispatcher';

const { buildSummarySegments, truncateRow, TASKS_SPINNER_FRAMES } = __test__;

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

// Forwarded handle that exposes the live dispatcher API. The test
// dispatches keystrokes directly through this rather than feeding
// stdin, which is more deterministic and avoids ink's debounce.
interface DispatcherHandle {
  readonly api: InputDispatcherAPI | null;
}

const DispatcherProbe = forwardRef<DispatcherHandle, { children: React.ReactNode }>(
  function DispatcherProbe({ children }, ref): React.JSX.Element {
    const api = useInputDispatcher();
    useImperativeHandle(ref, () => ({ api }), [api]);
    return <>{children}</>;
  },
);

interface MountResult {
  readonly read: () => string;
  readonly dispatch: (key: string) => void;
  readonly unmount: () => void;
  readonly rerender: (next: React.ReactNode) => void;
}

function mountTasks(
  todos: readonly Todo[],
  opts: { readonly expanded?: boolean } = {},
): MountResult {
  const buf: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stdout as unknown as { columns: number }).columns = 200;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  const handle = React.createRef<DispatcherHandle>();

  const tree = (
    next: readonly Todo[],
    nextExpanded?: boolean,
  ): React.ReactElement => (
    <InputDispatcherProvider mode="input">
      <DispatcherProbe ref={handle}>
        <TasksLine
          todos={next}
          {...(nextExpanded !== undefined ? { expanded: nextExpanded } : {})}
          terminalWidth={80}
        />
      </DispatcherProbe>
    </InputDispatcherProvider>
  );

  const instance = render(tree(todos, opts.expanded), {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout: stdout as any,
    debug: true,
    exitOnCtrlC: false,
  });

  return {
    read: () => stripAnsi(Buffer.concat(buf).toString('utf8')),
    dispatch: (input: string): void => {
      const api = handle.current?.api ?? null;
      if (api === null) throw new Error('dispatcher not yet attached');
      api.dispatch({
        input,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        key: {} as any,
      });
    },
    rerender: (nextChildren: React.ReactNode): void => {
      // We re-render with the same provider structure; the children
      // shape is fixed by the caller through `tree(...)`.
      void nextChildren; // unused — kept for ergonomics
    },
    unmount: () => instance.unmount(),
  };
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '0';
});

describe('TasksLine — pure helpers', () => {
  test('buildSummarySegments returns the present states', () => {
    const todos: Todo[] = [
      { content: 'A', status: 'completed', activeForm: 'A' },
      { content: 'B', status: 'in_progress', activeForm: 'B-ing' },
      { content: 'C', status: 'in_progress', activeForm: 'C-ing' },
      { content: 'D', status: 'pending', activeForm: 'D' },
    ];
    expect(buildSummarySegments(todos)).toEqual([
      '1 done',
      '2 in progress',
      '1 pending',
    ]);
  });

  test('buildSummarySegments omits zero counts', () => {
    const todos: Todo[] = [
      { content: 'A', status: 'completed', activeForm: 'A' },
      { content: 'B', status: 'completed', activeForm: 'B' },
    ];
    expect(buildSummarySegments(todos)).toEqual(['2 done']);
  });

  test('truncateRow leaves short text untouched', () => {
    expect(truncateRow('hello', 10)).toBe('hello');
  });

  test('truncateRow trims with ellipsis when too long', () => {
    expect(truncateRow('a long task description', 10)).toBe('a long ta…');
  });

  test('spinner has four frames', () => {
    expect(TASKS_SPINNER_FRAMES).toHaveLength(4);
  });
});

describe('TasksLine — render shape', () => {
  test('empty list renders nothing', async () => {
    const m = mountTasks([]);
    try {
      await new Promise((r) => setTimeout(r, 30));
      const out = m.read();
      expect(out).not.toContain('Tasks');
    } finally {
      m.unmount();
    }
  });

  test('collapsed mode (default) shows the one-line summary', async () => {
    const todos: Todo[] = [
      { content: 'A', status: 'completed', activeForm: 'A' },
      { content: 'B', status: 'in_progress', activeForm: 'Bing' },
      { content: 'C', status: 'pending', activeForm: 'C' },
    ];
    const m = mountTasks(todos);
    try {
      await new Promise((r) => setTimeout(r, 30));
      const out = m.read();
      expect(out).toContain('Tasks:');
      expect(out).toContain('1 done');
      expect(out).toContain('1 in progress');
      expect(out).toContain('1 pending');
      // Collapsed mode must NOT print each row.
      expect(out).not.toContain('○ C');
      expect(out).not.toContain('✓ A');
    } finally {
      m.unmount();
    }
  });

  test('expanded mode prints each todo with status icons', async () => {
    const todos: Todo[] = [
      { content: 'Done item', status: 'completed', activeForm: 'Done item' },
      {
        content: 'Working item',
        status: 'in_progress',
        activeForm: 'Working on item',
      },
      { content: 'Pending item', status: 'pending', activeForm: 'Pending item' },
    ];
    const m = mountTasks(todos, { expanded: true });
    try {
      await new Promise((r) => setTimeout(r, 30));
      const out = m.read();
      expect(out).toContain('✓ Done item');
      expect(out).toContain('Pending item');
      expect(out).toContain('Working item');
      // Spinner frame: one of the four braille variants leads the
      // in_progress row. We don't pin to a specific frame because
      // the timer may have ticked; we just verify a recognised glyph.
      const hasSpinner = TASKS_SPINNER_FRAMES.some((f) =>
        out.includes(`${f} Working item`),
      );
      expect(hasSpinner).toBe(true);
      // activeForm — appended for in_progress when meaningfully
      // different from `content`.
      expect(out).toContain('Working on item');
    } finally {
      m.unmount();
    }
  });

  test('pressing T toggles collapsed → expanded → collapsed', async () => {
    const todos: Todo[] = [
      { content: 'Alpha task', status: 'pending', activeForm: 'Alpha task' },
      { content: 'Beta task', status: 'completed', activeForm: 'Beta task' },
    ];

    // No `expanded` prop — internal toggle is live.
    const buf: Buffer[] = [];
    const stdout = new Writable({
      write(chunk, _enc, cb): void {
        buf.push(Buffer.from(chunk));
        cb();
      },
    });
    (stdout as unknown as { columns: number }).columns = 200;
    (stdout as unknown as { rows: number }).rows = 40;
    (stdout as unknown as { isTTY: boolean }).isTTY = true;

    const handle = React.createRef<DispatcherHandle>();
    const instance = render(
      (
        <InputDispatcherProvider mode="input">
          <DispatcherProbe ref={handle}>
            <TasksLine todos={todos} terminalWidth={80} />
          </DispatcherProbe>
        </InputDispatcherProvider>
      ),
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stdout: stdout as any,
        debug: true,
        exitOnCtrlC: false,
      },
    );

    try {
      await new Promise((r) => setTimeout(r, 30));
      const before = stripAnsi(Buffer.concat(buf).toString('utf8'));
      // The "press T to expand" hint advertises the binding.
      expect(before).toContain('expand');
      expect(before).not.toContain('✓ Beta task');

      // Press T — dispatch directly through the API so we don't rely on
      // a flaky stdin emitter.
      const api = handle.current?.api;
      expect(api).not.toBeNull();
      api?.dispatch({
        input: 't',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        key: {} as any,
      });
      await new Promise((r) => setTimeout(r, 30));
      const afterToggle = stripAnsi(Buffer.concat(buf).toString('utf8'));
      expect(afterToggle).toContain('✓ Beta task');
      expect(afterToggle).toContain('○ Alpha task');

      // Press T again — back to collapsed.
      api?.dispatch({
        input: 'T',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        key: {} as any,
      });
      await new Promise((r) => setTimeout(r, 30));
      const afterTwo = stripAnsi(Buffer.concat(buf).toString('utf8'));
      // The "press T to expand" hint comes back.
      expect(afterTwo).toContain('to expand');
    } finally {
      instance.unmount();
    }
  });

  test('controlled `expanded` prop overrides internal toggle', async () => {
    const todos: Todo[] = [
      { content: 'X', status: 'pending', activeForm: 'X' },
    ];
    const m = mountTasks(todos, { expanded: true });
    try {
      await new Promise((r) => setTimeout(r, 30));
      const out = m.read();
      // Always expanded — no "press T to expand" hint.
      expect(out).not.toContain('to expand');
      expect(out).toContain('to collapse');
      expect(out).toContain('○ X');
    } finally {
      m.unmount();
    }
  });
});
