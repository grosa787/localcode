/**
 * Wave 6B — SessionTimeline contract.
 *
 *   1. `buildTimelineEvents` projects user / assistant / tool events
 *      in chat order, with assistant tool calls expanded inline.
 *
 *   2. `computeDownsample` picks the right factor for a given column
 *      budget. When the event count fits we get factor=1 and no
 *      `(Nx)` label.
 *
 *   3. `projectTicks` places the cursor at the right bucket and
 *      emits the matching glyph per kind.
 *
 *   4. Render contract — hidden by default; visible variant prints
 *      the cursor glyph and the downsample label.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import SessionTimeline, {
  __test__,
  type TimelineEvent,
} from '@/ui/components/SessionTimeline';
import type { Message, ToolCall } from '@/types/global';

const {
  buildTimelineEvents,
  computeDownsample,
  projectTicks,
  TIMELINE_GLYPHS,
  TIMELINE_CURSOR,
} = __test__;

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

interface MountResult {
  readonly read: () => string;
  readonly unmount: () => void;
}

function mountTimeline(props: {
  readonly visible: boolean;
  readonly events: readonly TimelineEvent[];
  readonly cursorIndex: number;
  readonly columns?: number;
}): MountResult {
  const buf: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  const cols = props.columns ?? 120;
  (stdout as unknown as { columns: number }).columns = cols;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  const instance = render(
    React.createElement(SessionTimeline, {
      visible: props.visible,
      events: props.events,
      cursorIndex: props.cursorIndex,
      columns: cols,
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  return {
    read: () => stripAnsi(Buffer.concat(buf).toString('utf8')),
    unmount: () => instance.unmount(),
  };
}

function userMsg(id: string): Message {
  return { id, role: 'user', content: 'u', createdAt: 0 };
}
function asstMsg(id: string, toolCalls?: readonly ToolCall[]): Message {
  return {
    id,
    role: 'assistant',
    content: 'a',
    createdAt: 0,
    ...(toolCalls !== undefined ? { toolCalls: toolCalls as ToolCall[] } : {}),
  };
}
function tc(id: string): ToolCall {
  return { id, name: 'read_file', arguments: {} };
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '0';
});

describe('SessionTimeline — buildTimelineEvents', () => {
  test('user / assistant / tool ordering', () => {
    const msgs: readonly Message[] = [
      userMsg('u1'),
      asstMsg('a1', [tc('t1'), tc('t2')]),
      userMsg('u2'),
      asstMsg('a2'),
    ];
    const events = buildTimelineEvents(msgs);
    expect(events.map((e) => e.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'assistant',
    ]);
    expect(events.map((e) => e.messageIndex)).toEqual([0, 1, 1, 1, 2, 3]);
  });

  test('drops system + tool-role messages (they are double-counted)', () => {
    const msgs: readonly Message[] = [
      { id: 's1', role: 'system', content: 'sys', createdAt: 0 },
      userMsg('u1'),
      { id: 't1', role: 'tool', content: 'tool out', createdAt: 0 },
      asstMsg('a1'),
    ];
    const events = buildTimelineEvents(msgs);
    expect(events.map((e) => e.kind)).toEqual(['user', 'assistant']);
  });
});

describe('SessionTimeline — computeDownsample', () => {
  test('no downsample when events fit', () => {
    const { factor } = computeDownsample(10, 80);
    expect(factor).toBe(1);
  });

  test('integer downsample factor scales with overflow', () => {
    const { factor } = computeDownsample(400, 80);
    expect(factor).toBeGreaterThan(1);
    // Downsampled length must fit the reserved budget.
    expect(Math.ceil(400 / factor)).toBeLessThanOrEqual(80);
  });

  test('extreme overflow still picks a finite factor', () => {
    const { factor } = computeDownsample(5000, 40);
    expect(factor).toBeGreaterThan(1);
    expect(Number.isFinite(factor)).toBe(true);
    expect(Math.ceil(5000 / factor)).toBeLessThanOrEqual(40);
  });
});

describe('SessionTimeline — projectTicks cursor placement', () => {
  const events: readonly TimelineEvent[] = [
    { id: 'u1', messageIndex: 0, kind: 'user' },
    { id: 'a1', messageIndex: 1, kind: 'assistant' },
    { id: 't1', messageIndex: 1, kind: 'tool' },
    { id: 'u2', messageIndex: 2, kind: 'user' },
    { id: 'a2', messageIndex: 3, kind: 'assistant' },
  ];

  test('factor=1, cursor on last → last tick rendered as ▼', () => {
    const ticks = projectTicks(events, 4, 1);
    expect(ticks.length).toBe(5);
    expect(ticks[4]?.glyph).toBe(TIMELINE_CURSOR);
    expect(ticks[0]?.glyph).toBe(TIMELINE_GLYPHS.user);
    expect(ticks[1]?.glyph).toBe(TIMELINE_GLYPHS.assistant);
    expect(ticks[2]?.glyph).toBe(TIMELINE_GLYPHS.tool);
  });

  test('factor=2 — cursor stays inside its bucket', () => {
    const ticks = projectTicks(events, 3, 2);
    // 5 events → ceil(5/2) = 3 buckets.
    expect(ticks.length).toBe(3);
    // Cursor at 3 lands in bucket [2, 4) which is index 1.
    expect(ticks[1]?.glyph).toBe(TIMELINE_CURSOR);
  });

  test('empty events → empty ticks (no crash)', () => {
    expect(projectTicks([], -1, 1)).toEqual([]);
  });

  test('out-of-range cursor clamps to the last event', () => {
    const ticks = projectTicks(events, 999, 1);
    expect(ticks[4]?.glyph).toBe(TIMELINE_CURSOR);
  });
});

describe('SessionTimeline — render contract', () => {
  const events: readonly TimelineEvent[] = [
    { id: 'u1', messageIndex: 0, kind: 'user' },
    { id: 'a1', messageIndex: 1, kind: 'assistant' },
    { id: 't1', messageIndex: 1, kind: 'tool' },
    { id: 'u2', messageIndex: 2, kind: 'user' },
  ];

  test('hidden by default — visible=false renders zero bytes', () => {
    const m = mountTimeline({ visible: false, events, cursorIndex: 0 });
    expect(m.read().trim().length).toBe(0);
    m.unmount();
  });

  test('visible — shows cursor glyph and tick glyphs', () => {
    const m = mountTimeline({
      visible: true,
      events,
      cursorIndex: 3,
      columns: 120,
    });
    const out = m.read();
    expect(out).toContain(TIMELINE_CURSOR);
    // Should contain at least one of the kind glyphs from the other
    // events.
    expect(
      out.includes(TIMELINE_GLYPHS.user) ||
        out.includes(TIMELINE_GLYPHS.assistant) ||
        out.includes(TIMELINE_GLYPHS.tool),
    ).toBe(true);
    m.unmount();
  });

  test('high density — downsample label appears', () => {
    const many: TimelineEvent[] = [];
    for (let i = 0; i < 600; i += 1) {
      many.push({ id: `u${i}`, messageIndex: i, kind: 'user' });
    }
    const m = mountTimeline({
      visible: true,
      events: many,
      cursorIndex: 0,
      columns: 80,
    });
    const out = m.read();
    // Label format: ` (Nx)` with N >= 2.
    expect(out).toMatch(/\(\d+x\)/);
    m.unmount();
  });

  test('empty events → friendly placeholder', () => {
    const m = mountTimeline({ visible: true, events: [], cursorIndex: -1 });
    const out = m.read();
    expect(out).toContain('Timeline');
    expect(out).toContain('no events yet');
    m.unmount();
  });
});
