/**
 * BranchPicker — branch tree overlay (Ctrl+B).
 *
 * Covers:
 *   1. `flattenBranchTree` pure helper — depth + active marker + DFS
 *      order.
 *   2. Render contract — header, rows, footer hint.
 *   3. Empty state ("no branches yet").
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import BranchPicker, {
  __test__,
  type BranchPickerRow,
} from '@/ui/overlays/BranchPicker';
import type { BranchTreeNode } from '@/sessions/session-manager';

const { flattenBranchTree, indentFor, stripControlChars } = __test__;

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

interface MountResult {
  readonly read: () => string;
  readonly unmount: () => void;
}

function mountPicker(props: {
  readonly rows: readonly BranchPickerRow[];
  readonly activeSessionId: string | null;
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
    React.createElement(BranchPicker, {
      rows: props.rows,
      activeSessionId: props.activeSessionId,
      onSwitch: () => {
        /* no-op */
      },
      onCreate: () => {
        /* no-op */
      },
      onDelete: () => {
        /* no-op */
      },
      onClose: () => {
        /* no-op */
      },
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

beforeAll(() => {
  process.env['FORCE_COLOR'] = '0';
});

function node(
  id: string,
  branchName: string | null,
  archived: boolean,
  children: BranchTreeNode[] = [],
): BranchTreeNode {
  return {
    id,
    branchName,
    title: null,
    divergedAt: null,
    branchArchived: archived,
    messageCount: 5,
    children,
  };
}

describe('flattenBranchTree', () => {
  test('null → empty array', () => {
    expect(flattenBranchTree(null, null)).toEqual([]);
  });

  test('DFS — root first, then children in declared order', () => {
    const root = node('r', 'main', false, [
      node('a', 'experiment-A', false, [node('a1', 'deep', false)]),
      node('b', 'experiment-B', false),
    ]);
    const rows = flattenBranchTree(root, 'a1');
    expect(rows.map((r) => r.id)).toEqual(['r', 'a', 'a1', 'b']);
    // active marker is on 'a1'
    expect(rows.find((r) => r.id === 'a1')?.active).toBe(true);
    // depths
    expect(rows.find((r) => r.id === 'r')?.depth).toBe(0);
    expect(rows.find((r) => r.id === 'a')?.depth).toBe(1);
    expect(rows.find((r) => r.id === 'a1')?.depth).toBe(2);
    expect(rows.find((r) => r.id === 'b')?.depth).toBe(1);
  });

  test('isRoot is true only for the top node', () => {
    const root = node('r', 'main', false, [node('a', 'A', false)]);
    const rows = flattenBranchTree(root, 'a');
    expect(rows.find((r) => r.id === 'r')?.isRoot).toBe(true);
    expect(rows.find((r) => r.id === 'a')?.isRoot).toBe(false);
  });

  test('archived flag propagated', () => {
    const root = node('r', 'main', false, [node('a', 'A', true)]);
    const rows = flattenBranchTree(root, 'r');
    expect(rows.find((r) => r.id === 'a')?.archived).toBe(true);
  });
});

describe('indentFor', () => {
  test('depth 0 produces empty string', () => {
    expect(indentFor(0)).toBe('');
  });
  test('depth >= 1 produces 3*depth characters', () => {
    expect(indentFor(1).length).toBe(3);
    expect(indentFor(3).length).toBe(9);
  });
});

describe('stripControlChars', () => {
  test('passes printable characters through', () => {
    expect(stripControlChars('hello world')).toBe('hello world');
    expect(stripControlChars('experiment-A')).toBe('experiment-A');
  });
  test('drops control codepoints', () => {
    const dirty = 'foo\x00bar\x1fbaz\x7f';
    expect(stripControlChars(dirty)).toBe('foobarbaz');
  });
});

describe('BranchPicker render', () => {
  test('renders header + footer + every row', () => {
    const root = node('root', 'main', false, [
      node('a', 'experiment-A', false),
      node('b', 'experiment-B', false),
    ]);
    const rows = flattenBranchTree(root, 'a');
    const m = mountPicker({ rows, activeSessionId: 'a' });
    const out = m.read();
    expect(out).toContain('Branch picker');
    expect(out).toContain('main');
    expect(out).toContain('experiment-A');
    expect(out).toContain('experiment-B');
    expect(out).toContain('switch');
    expect(out).toContain('new');
    expect(out).toContain('delete');
    expect(out).toContain('close');
    m.unmount();
  });

  test('marks the active row with `*`', () => {
    const root = node('root', 'main', false, [node('a', 'experiment-A', false)]);
    const rows = flattenBranchTree(root, 'a');
    const m = mountPicker({ rows, activeSessionId: 'a' });
    const out = m.read();
    // Active marker appears
    expect(out).toContain('*');
    m.unmount();
  });

  test('archived rows are labelled', () => {
    const root = node('root', 'main', false, [node('a', 'old', true)]);
    const rows = flattenBranchTree(root, 'root');
    const m = mountPicker({ rows, activeSessionId: 'root' });
    const out = m.read();
    expect(out).toContain('(archived)');
    m.unmount();
  });

  test('empty rows → no-branches placeholder', () => {
    const m = mountPicker({ rows: [], activeSessionId: null });
    const out = m.read();
    expect(out).toContain('No branches yet');
    m.unmount();
  });
});
