/**
 * BranchBreadcrumb — renders the root→current chain at the top of the
 * chat, auto-hides when there's only an unnamed root.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import BranchBreadcrumb, {
  __test__,
  type BranchCrumb,
} from '@/ui/components/BranchBreadcrumb';
import type { BranchInfo } from '@/sessions/session-manager';

const { buildBreadcrumbChain, shouldShowBreadcrumb, ARROW_GLYPH } = __test__;

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

interface MountResult {
  readonly read: () => string;
  readonly unmount: () => void;
}

function mountBreadcrumb(props: {
  readonly chain: readonly BranchCrumb[];
  readonly visible?: boolean;
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
    React.createElement(BranchBreadcrumb, {
      chain: props.chain,
      ...(props.visible !== undefined ? { visible: props.visible } : {}),
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

function rootInfo(extra: Partial<BranchInfo> = {}): BranchInfo {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    branchName: null,
    title: null,
    parentSessionId: null,
    divergedAt: null,
    messageCount: 5,
    branchArchived: false,
    ...extra,
  };
}

function namedBranch(id: string, name: string): BranchInfo {
  return {
    id,
    branchName: name,
    title: null,
    parentSessionId: '11111111-1111-1111-1111-111111111111',
    divergedAt: null,
    messageCount: 3,
    branchArchived: false,
  };
}

describe('buildBreadcrumbChain', () => {
  test('flattens a root-only chain', () => {
    const chain = buildBreadcrumbChain([rootInfo()], '11111111-1111-1111-1111-111111111111');
    expect(chain.length).toBe(1);
    expect(chain[0]?.active).toBe(true);
    expect(chain[0]?.label.startsWith('(root ')).toBe(true);
  });

  test('flattens root → child → grandchild', () => {
    const root = rootInfo({ branchName: 'main' });
    const child = namedBranch('2', 'experiment-A');
    const grand = namedBranch('3', 'fix-edge-case');
    const chain = buildBreadcrumbChain([root, child, grand], '3');
    expect(chain.map((c) => c.label)).toEqual([
      'main',
      'experiment-A',
      'fix-edge-case',
    ]);
    expect(chain[2]?.active).toBe(true);
    expect(chain[0]?.active).toBe(false);
  });

  test('skips archived ancestors but keeps the active session', () => {
    const root = rootInfo({ branchName: 'main' });
    const archivedChild = { ...namedBranch('2', 'gone'), branchArchived: true };
    const grand = namedBranch('3', 'fresh');
    const chain = buildBreadcrumbChain(
      [root, archivedChild, grand],
      '3',
    );
    expect(chain.map((c) => c.label)).toEqual(['main', 'fresh']);
  });
});

describe('shouldShowBreadcrumb', () => {
  test('hides for a single unnamed root', () => {
    const chain = buildBreadcrumbChain([rootInfo()], rootInfo().id);
    expect(shouldShowBreadcrumb(chain)).toBe(false);
  });

  test('shows when the single root has a title or branch name', () => {
    const chain = buildBreadcrumbChain(
      [rootInfo({ title: 'Project planning' })],
      rootInfo().id,
    );
    expect(shouldShowBreadcrumb(chain)).toBe(true);
  });

  test('shows whenever there is more than one crumb', () => {
    const chain = buildBreadcrumbChain(
      [rootInfo(), namedBranch('2', 'A')],
      '2',
    );
    expect(shouldShowBreadcrumb(chain)).toBe(true);
  });

  test('hides for empty chain', () => {
    expect(shouldShowBreadcrumb([])).toBe(false);
  });
});

describe('BranchBreadcrumb — render', () => {
  test('renders the chain with separators', () => {
    const m = mountBreadcrumb({
      chain: [
        { id: 'a', label: 'main', active: false },
        { id: 'b', label: 'experiment-A', active: false },
        { id: 'c', label: 'fix-edge-case', active: true },
      ],
    });
    const out = m.read();
    expect(out).toContain('main');
    expect(out).toContain('experiment-A');
    expect(out).toContain('fix-edge-case');
    expect(out).toContain(ARROW_GLYPH);
    m.unmount();
  });

  test('hides when chain is empty', () => {
    const m = mountBreadcrumb({ chain: [] });
    expect(m.read().trim().length).toBe(0);
    m.unmount();
  });

  test('respects visible=false', () => {
    const m = mountBreadcrumb({
      chain: [
        { id: 'a', label: 'main', active: true },
        { id: 'b', label: 'A', active: false },
      ],
      visible: false,
    });
    expect(m.read().trim().length).toBe(0);
    m.unmount();
  });

  test('auto-hides for a single unnamed-root crumb', () => {
    const m = mountBreadcrumb({
      chain: [{ id: 'r', label: '(root 12345678)', active: true }],
    });
    expect(m.read().trim().length).toBe(0);
    m.unmount();
  });
});
