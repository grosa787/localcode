/**
 * WatchPanel — verifies the 1-row strip rendering contract, the
 * hide-on-empty behaviour, label truncation, and the state-colour
 * mapping. Tests construct `WatchedProcess` fixtures directly so we
 * never spawn real children.
 */

import { describe, expect, test, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';

import WatchPanel, {
  WATCH_PANEL_COLORS,
  classifyState,
  formatDuration,
  planEntries,
  stateLabel,
  truncateLabel,
} from '@/ui/components/WatchPanel';
import type { WatchedProcess } from '@/process-monitor/types';

interface CapturedOutput {
  readonly text: string;
}

function makeProcess(overrides: Partial<WatchedProcess> = {}): WatchedProcess {
  return {
    id: 'pm_test01',
    command: 'bun test --watch',
    cwd: '/tmp/proj',
    label: 'bun test --watch',
    pid: 1234,
    health: 'alive',
    startedAt: 1_000_000,
    exitedAt: null,
    exitCode: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    recentStdout: [],
    recentStderr: [],
    ...overrides,
  };
}

function renderPanel(props: {
  readonly processes: readonly WatchedProcess[];
  readonly columns: number;
  readonly now?: number;
}): CapturedOutput {
  const buf: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stream as unknown as { columns: number }).columns = props.columns;
  (stream as unknown as { rows: number }).rows = 10;
  (stream as unknown as { isTTY: boolean }).isTTY = true;
  const instance = render(React.createElement(WatchPanel, props), {
    stdout: stream as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
  });
  instance.unmount();
  return { text: Buffer.concat(buf).toString('utf8') };
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '3';
});

describe('formatDuration', () => {
  test('milliseconds for sub-second values', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(50)).toBe('50ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  test('seconds for sub-minute values', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(59_999)).toBe('59s');
  });

  test('minutes and hours roll over correctly', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(7_200_000)).toBe('2h');
  });

  test('negative / non-finite inputs clamp to 0s', () => {
    expect(formatDuration(-1)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0s');
  });
});

describe('truncateLabel', () => {
  test('returns the input unchanged when it fits', () => {
    expect(truncateLabel('bun test', 80)).toBe('bun test');
  });

  test('adds an ellipsis when over budget', () => {
    expect(truncateLabel('bun test --watch --verbose', 10)).toBe('bun test …');
    expect(truncateLabel('bun test --watch --verbose', 10).length).toBe(10);
  });

  test('returns the prefix when budget is too small for ellipsis', () => {
    expect(truncateLabel('abcdef', 1)).toBe('a');
    expect(truncateLabel('abcdef', 0)).toBe('');
  });
});

describe('classifyState', () => {
  test('alive → running', () => {
    expect(classifyState(makeProcess({ health: 'alive' }))).toBe('running');
  });

  test('killed → exiting (regardless of exit code)', () => {
    expect(
      classifyState(
        makeProcess({ health: 'killed', exitedAt: 1, exitCode: 0 }),
      ),
    ).toBe('exiting');
  });

  test('exited with non-zero code → exitedError', () => {
    expect(
      classifyState(
        makeProcess({ health: 'exited', exitedAt: 1, exitCode: 1 }),
      ),
    ).toBe('exitedError');
  });

  test('exited with code=0 → exitedClean', () => {
    expect(
      classifyState(
        makeProcess({ health: 'exited', exitedAt: 1, exitCode: 0 }),
      ),
    ).toBe('exitedClean');
  });
});

describe('stateLabel', () => {
  test('emits canonical labels for every state', () => {
    expect(stateLabel('running')).toBe('running');
    expect(stateLabel('exiting')).toBe('exiting');
    expect(stateLabel('exitedError')).toBe('exited');
    expect(stateLabel('exitedClean')).toBe('done');
  });
});

describe('planEntries', () => {
  test('returns no entries when only the header fits', () => {
    const plan = planEntries(
      [makeProcess()],
      // header is `📡 watched(1)` (≥12 cols incl emoji); budget=10 cuts it off.
      10,
      2_000_000,
    );
    expect(plan.entries.length).toBe(0);
  });

  test('renders entries when there is room', () => {
    const plan = planEntries(
      [makeProcess({ id: 'a', label: 'bun test' })],
      120,
      2_000_000,
    );
    expect(plan.entries.length).toBe(1);
    expect(plan.entries[0]?.label).toBe('bun test');
    expect(plan.entries[0]?.state).toBe('running');
  });

  test('truncates long labels to honour the column budget', () => {
    const plan = planEntries(
      [
        makeProcess({
          id: 'a',
          label: 'a-very-long-label-that-cannot-possibly-fit-in-a-narrow-strip',
        }),
      ],
      40,
      2_000_000,
    );
    expect(plan.entries.length).toBe(1);
    const lbl = plan.entries[0]?.label ?? '';
    expect(lbl.endsWith('…')).toBe(true);
  });

  test('limits visible entries when too many processes are watched', () => {
    const procs: WatchedProcess[] = [];
    for (let i = 0; i < 10; i += 1) {
      procs.push(
        makeProcess({ id: `id_${i}`, label: `cmd-${i}` }),
      );
    }
    const plan = planEntries(procs, 50, 2_000_000);
    expect(plan.entries.length).toBeGreaterThan(0);
    expect(plan.entries.length).toBeLessThanOrEqual(procs.length);
  });
});

describe('WatchPanel rendering', () => {
  test('renders nothing when no processes are watched', () => {
    const out = renderPanel({ processes: [], columns: 120 });
    const stripped = strip(out.text).trim();
    // Empty render still emits an ink frame; the visible text should
    // not contain the panel header.
    expect(stripped).not.toContain('watched(');
  });

  test('renders the panel header + label when at least one process is alive', () => {
    const out = renderPanel({
      processes: [
        makeProcess({ id: 'pm_a', label: 'bun test', startedAt: 1_000_000 }),
      ],
      columns: 120,
      now: 1_005_000,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('watched(1)');
    expect(stripped).toContain('bun test');
    // Duration should land in the `(running 5s)` range.
    expect(stripped).toContain('running');
    expect(stripped).toContain('5s');
  });

  test('truncates label when the terminal is narrow', () => {
    const out = renderPanel({
      processes: [
        makeProcess({
          id: 'pm_b',
          label: 'a-very-long-label-that-cannot-possibly-fit-in-a-narrow-strip',
          startedAt: 1_000_000,
        }),
      ],
      columns: 50,
      now: 1_005_000,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('watched(1)');
    expect(stripped).toContain('…');
  });

  test('exitedError shows the exited label (state colour distinct from running)', () => {
    const out = renderPanel({
      processes: [
        makeProcess({
          id: 'pm_c',
          label: 'failing-watch',
          health: 'exited',
          exitedAt: 1_010_000,
          exitCode: 2,
          startedAt: 1_000_000,
        }),
      ],
      columns: 120,
      now: 1_020_000,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('failing-watch');
    expect(stripped).toContain('exited');
  });
});

describe('WATCH_PANEL_COLORS', () => {
  test('exposes the four state colour roles', () => {
    expect(WATCH_PANEL_COLORS.running).toBeDefined();
    expect(WATCH_PANEL_COLORS.exiting).toBeDefined();
    expect(WATCH_PANEL_COLORS.exitedError).toBeDefined();
    expect(WATCH_PANEL_COLORS.exitedClean).toBeDefined();
  });
});
