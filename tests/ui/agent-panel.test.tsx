/**
 * Wave 5A — AgentPanel rendering + navigation invariants.
 *
 * The panel is purely presentational — selection state, focus mode,
 * `currentConversant`, and the workers list all arrive via props.
 * Composition root (`src/app.tsx`) owns the orchestrator subscription
 * and the reducer dispatches. So these tests:
 *
 *   - Render the panel directly with a fixture worker list and the
 *     three navigation prop combinations (focused/unfocused, selected
 *     row, attached row) and assert the rendered text shape.
 *   - Exercise the reducer actions (`AGENT_SELECT_NEXT`,
 *     `AGENT_SELECT_PREV`, `AGENT_ATTACH`, `AGENT_DETACH`) directly so
 *     navigation correctness doesn't depend on the ink mount.
 *
 * Mount harness mirrors `tests/ui/input-bar-layout.test.tsx`.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { settleFrame } from './_settle';
import { AgentPanel, type AgentRow } from '@/ui/components/AgentPanel';
import {
  chatReducer,
  initialChatState,
  type ChatAction,
} from '@/integration/chat-state';

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

interface MountResult {
  readonly read: () => string;
  readonly unmount: () => void;
}

function mountPanel(props: {
  readonly workers: readonly AgentRow[];
  readonly leadModel: string;
  readonly leadStreaming?: boolean;
  readonly selectedIdx?: number;
  readonly focused?: boolean;
  readonly currentConversant?: 'lead' | string;
  readonly columns?: number;
  // AGENT-LIFECYCLE-SECTION
  readonly showHistory?: boolean;
  // /AGENT-LIFECYCLE-SECTION
}): MountResult {
  const stdoutBuf: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      stdoutBuf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stdout as unknown as { columns: number }).columns = props.columns ?? 200;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  const stdin: EventEmitter & {
    isTTY?: boolean;
    setRawMode?: (raw: boolean) => void;
    setEncoding?: (enc: string) => void;
    resume?: () => void;
    pause?: () => void;
    read?: () => null;
    ref?: () => void;
    unref?: () => void;
  } = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.setEncoding = () => undefined;
  stdin.resume = () => undefined;
  stdin.pause = () => undefined;
  stdin.read = () => null;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;

  const instance = render(
    React.createElement(AgentPanel, {
      workers: props.workers,
      leadModel: props.leadModel,
      leadStreaming: props.leadStreaming ?? false,
      selectedIdx: props.selectedIdx ?? 0,
      focused: props.focused ?? false,
      currentConversant: props.currentConversant ?? 'lead',
      ...(props.columns !== undefined ? { columns: props.columns } : {}),
      // AGENT-LIFECYCLE-SECTION
      ...(props.showHistory !== undefined ? { showHistory: props.showHistory } : {}),
      // /AGENT-LIFECYCLE-SECTION
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: false,
      exitOnCtrlC: false,
    },
  );

  return {
    read: () => stripAnsi(Buffer.concat(stdoutBuf).toString('utf8')),
    unmount: () => instance.unmount(),
  };
}

const FIXTURE_3: readonly AgentRow[] = [
  {
    agentId: 'a1',
    label: 'debugger',
    status: 'running',
    lastMessage: 'investigating crash',
  },
  {
    agentId: 'b2',
    label: 'reviewer',
    status: 'done',
    lastMessage: 'lgtm — 2 nits',
  },
  {
    agentId: 'c3',
    label: 'codegen',
    status: 'failed',
    lastMessage: 'context too long',
  },
];

beforeAll(() => {
  process.env['FORCE_COLOR'] = '0';
});

// Helper: give ink a tick to flush stdout before reading. CI runners
// (especially macOS-13) are slow enough that an immediate read can
// catch only the cursor-hide escape (`[?25l`) before the actual
// frame is written. 200 ms is conservative but cheap.
const flushInk = (read: () => string): Promise<string> => settleFrame(read);

describe('AgentPanel — render shape with 3 workers', () => {
  test('renders lead row + 3 worker rows', async () => {
    const m = mountPanel({
      workers: FIXTURE_3,
      leadModel: 'gpt-5',
      // AGENT-LIFECYCLE-SECTION — fixture has done + failed rows; the
      // default filter hides them. Opt into history view so this test
      // continues to assert the full render shape.
      showHistory: true,
      // /AGENT-LIFECYCLE-SECTION
    });
    const out = await flushInk(() => m.read());
    expect(out).toContain('lead');
    expect(out).toContain('gpt-5');
    // Every worker id appears in the rendered output.
    for (const w of FIXTURE_3) {
      expect(out).toContain(w.agentId);
      expect(out).toContain(w.label);
    }
    m.unmount();
  });

  test('focused panel shows the selection arrow on the selected row', async () => {
    const m = mountPanel({
      workers: FIXTURE_3,
      leadModel: 'gpt-5',
      focused: true,
      selectedIdx: 1,
    });
    const out = await flushInk(() => m.read());
    // The selected row's prefix is `▶`; unselected use `▎`.
    expect(out).toContain('▶');
    // Help line only renders when focused.
    expect(out).toContain('select');
    expect(out).toContain('attach');
    m.unmount();
  });

  test('unfocused panel hides the selection chrome', async () => {
    const m = mountPanel({
      workers: FIXTURE_3,
      leadModel: 'gpt-5',
      focused: false,
      selectedIdx: 1,
    });
    const out = await flushInk(() => m.read());
    expect(out).not.toContain('▶');
    m.unmount();
  });

  test('currentConversant = worker id renders the attached marker', async () => {
    const m = mountPanel({
      workers: FIXTURE_3,
      leadModel: 'gpt-5',
      currentConversant: 'b2',
      // AGENT-LIFECYCLE-SECTION — b2 is `done` in the fixture; show
      // history so the attached-marker assertion can find the row.
      showHistory: true,
      // /AGENT-LIFECYCLE-SECTION
    });
    const out = await flushInk(() => m.read());
    expect(out).toContain('→ active');
    m.unmount();
  });

  test('narrow terminal (<60 cols) drops the lastMessage preview', async () => {
    const m = mountPanel({
      workers: FIXTURE_3,
      leadModel: 'gpt-5',
      columns: 50,
    });
    const out = await flushInk(() => m.read());
    expect(out).not.toContain('investigating crash');
    m.unmount();
  });
});

// AGENT-LIFECYCLE-SECTION
describe('AgentPanel — showHistory filter', () => {
  test('default (showHistory undefined) hides terminated workers', async () => {
    const m = mountPanel({
      workers: FIXTURE_3,
      leadModel: 'gpt-5',
    });
    const out = await flushInk(() => m.read());
    // Running row is visible.
    expect(out).toContain('a1');
    // Terminated rows (done b2, failed c3) are hidden.
    expect(out).not.toContain('b2');
    expect(out).not.toContain('c3');
    m.unmount();
  });

  test('showHistory=true surfaces every status', async () => {
    const m = mountPanel({
      workers: FIXTURE_3,
      leadModel: 'gpt-5',
      showHistory: true,
    });
    const out = await flushInk(() => m.read());
    expect(out).toContain('a1');
    expect(out).toContain('b2');
    expect(out).toContain('c3');
    m.unmount();
  });
});
// /AGENT-LIFECYCLE-SECTION

describe('AgentPanel — reducer-driven selection (↑/↓/Enter)', () => {
  const stateWithWorkers = initialChatState;

  function dispatch(
    state: typeof initialChatState,
    action: ChatAction,
  ): typeof initialChatState {
    return chatReducer(state, action);
  }

  test('AGENT_SELECT_NEXT clamps at last index (no wrap)', () => {
    let s = stateWithWorkers;
    s = dispatch(s, { type: 'AGENT_SELECT_NEXT', workerCount: 3 });
    expect(s.agentSelectedIdx).toBe(1);
    s = dispatch(s, { type: 'AGENT_SELECT_NEXT', workerCount: 3 });
    expect(s.agentSelectedIdx).toBe(2);
    // Already at the end — must not wrap.
    s = dispatch(s, { type: 'AGENT_SELECT_NEXT', workerCount: 3 });
    expect(s.agentSelectedIdx).toBe(2);
  });

  test('AGENT_SELECT_PREV clamps at 0 (no wrap)', () => {
    let s = { ...stateWithWorkers, agentSelectedIdx: 1 };
    s = dispatch(s, { type: 'AGENT_SELECT_PREV', workerCount: 3 });
    expect(s.agentSelectedIdx).toBe(0);
    s = dispatch(s, { type: 'AGENT_SELECT_PREV', workerCount: 3 });
    expect(s.agentSelectedIdx).toBe(0);
  });

  test('AGENT_ATTACH sets currentConversant + exits focus', () => {
    const s = dispatch(
      { ...stateWithWorkers, agentFocusMode: true },
      { type: 'AGENT_ATTACH', agentId: 'a1' },
    );
    expect(s.currentConversant).toBe('a1');
    expect(s.agentFocusMode).toBe(false);
  });

  test('AGENT_DETACH returns to lead', () => {
    const s = dispatch(
      { ...stateWithWorkers, currentConversant: 'a1' },
      { type: 'AGENT_DETACH' },
    );
    expect(s.currentConversant).toBe('lead');
  });

  test('AGENT_FOCUS_ENTER / EXIT toggles the focus flag', () => {
    let s = dispatch(stateWithWorkers, { type: 'AGENT_FOCUS_ENTER' });
    expect(s.agentFocusMode).toBe(true);
    s = dispatch(s, { type: 'AGENT_FOCUS_EXIT' });
    expect(s.agentFocusMode).toBe(false);
  });

  test('AGENT_SELECT_NEXT on empty list keeps selection at 0', () => {
    const s = dispatch(stateWithWorkers, {
      type: 'AGENT_SELECT_NEXT',
      workerCount: 0,
    });
    expect(s.agentSelectedIdx).toBe(0);
  });
});
