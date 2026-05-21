/**
 * Wave 6B — ConversationTOC contract.
 *
 * Three areas under test:
 *
 *   1. Pure helpers — `buildTOCEntries`, `buildPreview`,
 *      `formatRelativeTime`. These run on raw Message arrays and
 *      synthetic timestamps so the assertions don't depend on the ink
 *      render lifecycle.
 *
 *   2. Rendered shape — mount the component with a small fixture and
 *      assert the entries appear in the captured stdout, that the
 *      `Outline (N)` count is correct, and that the selected row uses
 *      the `▶` glyph instead of `▎`.
 *
 *   3. Hidden-by-default contract — when `visible={false}` we expect
 *      ZERO bytes in stdout (the component returns `null`).
 *
 * Mount harness mirrors `tests/ui/agent-panel.test.tsx`.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import ConversationTOC, {
  __test__,
  type ConversationTOCEntry,
} from '@/ui/components/ConversationTOC';
import type { Message } from '@/types/global';

const { buildTOCEntries, buildPreview, formatRelativeTime, TOC_PREVIEW_LEN } =
  __test__;

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

interface MountResult {
  readonly read: () => string;
  readonly unmount: () => void;
}

function mountTOC(props: {
  readonly visible: boolean;
  readonly entries: readonly ConversationTOCEntry[];
  readonly selectedIdx?: number;
  readonly nowMs?: number;
}): MountResult {
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
  const instance = render(
    React.createElement(ConversationTOC, {
      visible: props.visible,
      entries: props.entries,
      selectedIdx: props.selectedIdx ?? 0,
      ...(props.nowMs !== undefined ? { nowMs: props.nowMs } : {}),
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

function userMsg(id: string, content: string, createdAt: number): Message {
  return { id, role: 'user', content, createdAt };
}

function asstMsg(id: string, content: string, createdAt: number): Message {
  return { id, role: 'assistant', content, createdAt };
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '0';
});

describe('ConversationTOC — pure helpers', () => {
  test('buildPreview collapses whitespace + truncates at limit', () => {
    expect(buildPreview('hello world')).toBe('hello world');
    expect(buildPreview('  leading   ws    ')).toBe('leading ws');
    expect(buildPreview('line1\n\nline2\nline3')).toBe('line1 line2 line3');
    const long = 'a'.repeat(120);
    const prev = buildPreview(long);
    expect(prev.length).toBeLessThanOrEqual(TOC_PREVIEW_LEN);
    expect(prev.endsWith('…')).toBe(true);
  });

  test('buildTOCEntries filters user turns and preserves order', () => {
    const messages: readonly Message[] = [
      asstMsg('a1', 'hi', 1000),
      userMsg('u1', 'first', 2000),
      asstMsg('a2', 'reply', 3000),
      userMsg('u2', 'second', 4000),
      userMsg('u3', '', 5000), // empty preview gets dropped
      userMsg('u4', 'third', 6000),
    ];
    const entries = buildTOCEntries(messages);
    expect(entries.map((e) => e.id)).toEqual(['u1', 'u2', 'u4']);
    expect(entries.map((e) => e.messageIndex)).toEqual([1, 3, 5]);
    expect(entries.map((e) => e.preview)).toEqual(['first', 'second', 'third']);
  });

  test('formatRelativeTime maps deltas to coarse units', () => {
    expect(formatRelativeTime(0)).toBe('0s');
    expect(formatRelativeTime(-1)).toBe('0s');
    expect(formatRelativeTime(5_000)).toBe('5s');
    expect(formatRelativeTime(60_000)).toBe('1m');
    expect(formatRelativeTime(60 * 60_000)).toBe('1h');
    expect(formatRelativeTime(48 * 60 * 60_000)).toBe('2d');
  });
});

describe('ConversationTOC — render contract', () => {
  const NOW = 100_000;
  const entries: readonly ConversationTOCEntry[] = [
    { id: 'u1', messageIndex: 0, preview: 'first turn', createdAt: NOW - 1_000 },
    { id: 'u2', messageIndex: 2, preview: 'second turn', createdAt: NOW - 60_000 },
    { id: 'u3', messageIndex: 4, preview: 'third turn', createdAt: NOW - 3_600_000 },
  ];

  test('hidden by default — visible=false renders zero bytes', () => {
    const m = mountTOC({ visible: false, entries });
    const out = m.read();
    expect(out.trim().length).toBe(0);
    m.unmount();
  });

  test('visible — renders Outline header + all entries', () => {
    const m = mountTOC({ visible: true, entries, selectedIdx: 0, nowMs: NOW });
    const out = m.read();
    expect(out).toContain('Outline (3)');
    expect(out).toContain('first turn');
    expect(out).toContain('second turn');
    expect(out).toContain('third turn');
    // The selected row uses '▶' instead of '▎'.
    expect(out).toContain('▶');
    m.unmount();
  });

  test('selectedIdx out of range clamps to a valid row (no crash)', () => {
    const m = mountTOC({ visible: true, entries, selectedIdx: 99, nowMs: NOW });
    const out = m.read();
    // The last entry should be highlighted (clamped).
    expect(out).toContain('third turn');
    expect(out).toContain('▶');
    m.unmount();
  });

  test('empty entry list renders an explanatory placeholder', () => {
    const m = mountTOC({ visible: true, entries: [], selectedIdx: 0 });
    const out = m.read();
    expect(out).toContain('Outline (0)');
    expect(out).toContain('No user turns yet');
    m.unmount();
  });

  test('relative-time column appears next to each entry', () => {
    const m = mountTOC({ visible: true, entries, selectedIdx: 0, nowMs: NOW });
    const out = m.read();
    // 1s ago (top entry — delta 1000ms)
    expect(out).toContain('1s');
    // 1m ago (second — delta 60000ms)
    expect(out).toContain('1m');
    // 1h ago (third — delta 3600000ms)
    expect(out).toContain('1h');
    m.unmount();
  });
});
