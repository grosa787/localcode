/**
 * TOOL-RENDERERS-SECTION — tests for the Ctrl+O ref-pick overlay.
 *
 * We mount the overlay inside a `<RefRegistryProvider>` along with a
 * couple of `<FileRef>` instances so the registry is populated. Then we
 * verify:
 *   - the overlay does NOT render by default (Ctrl+O must open it),
 *   - rendering with `forceOpen` shows every registered entry,
 *   - the numbered jump list reflects registration order,
 *   - the registry hands out stable ids (re-registering the same triple
 *     returns the same id).
 *
 * NOTE: we deliberately do NOT drive the InputDispatcher in these
 * tests — the dispatcher integration is covered by the broader
 * ChatScreen tests. Here we focus on the overlay's own render
 * contract.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import RefPickOverlay from '@/ui/components/RefPickOverlay';
import FileRef from '@/ui/components/FileRef';
import {
  RefRegistryProvider,
  createRefRegistry,
} from '@/ui/hooks/useRefRegistry';

function renderToText(element: React.ReactElement): string {
  const buf: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stream as unknown as { columns: number }).columns = 120;
  (stream as unknown as { rows: number }).rows = 40;
  (stream as unknown as { isTTY: boolean }).isTTY = true;
  const instance = render(element, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout: stream as any,
    debug: true,
    exitOnCtrlC: false,
  });
  instance.unmount();
  return Buffer.concat(buf).toString('utf8');
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '3';
});

describe('createRefRegistry — pure unit', () => {
  test('hands out 1-based ids in registration order', () => {
    const reg = createRefRegistry();
    expect(reg.register('a.ts', 1)).toBe(1);
    expect(reg.register('b.ts', 2)).toBe(2);
    expect(reg.register('c.ts', 3)).toBe(3);
    expect(reg.size()).toBe(3);
  });

  test('returns the same id when called twice with the same triple', () => {
    const reg = createRefRegistry();
    const a = reg.register('x.ts', 10);
    const b = reg.register('x.ts', 10);
    expect(a).toBe(b);
    expect(reg.size()).toBe(1);
  });

  test('treats different lines/columns as different entries', () => {
    const reg = createRefRegistry();
    reg.register('x.ts', 10);
    reg.register('x.ts', 11);
    reg.register('x.ts', 10, 5);
    expect(reg.size()).toBe(3);
  });

  test('snapshot returns entries in registration order', () => {
    const reg = createRefRegistry();
    reg.register('a.ts', 1);
    reg.register('b.ts', 2);
    const snap = reg.snapshot();
    expect(snap[0]?.path).toBe('a.ts');
    expect(snap[1]?.path).toBe('b.ts');
  });
});

describe('RefPickOverlay render', () => {
  test('does not render when closed and registry empty', () => {
    const txt = renderToText(
      <RefRegistryProvider>
        <RefPickOverlay onJump={() => undefined} />
      </RefRegistryProvider>,
    );
    expect(strip(txt)).not.toContain('Pick a file reference');
  });

  test('forceOpen renders entries from the surrounding registry', () => {
    const txt = renderToText(
      <RefRegistryProvider>
        <FileRef path="src/a.ts" line={1} />
        <FileRef path="src/b.ts" line={20} column={3} />
        <RefPickOverlay onJump={() => undefined} forceOpen />
      </RefRegistryProvider>,
    );
    const stripped = strip(txt);
    expect(stripped).toContain('Pick a file reference');
    expect(stripped).toContain('1. src/a.ts:1');
    expect(stripped).toContain('2. src/b.ts:20:3');
  });

  test('helper hint shows Esc affordance when open', () => {
    const txt = renderToText(
      <RefRegistryProvider>
        <FileRef path="src/a.ts" line={1} />
        <RefPickOverlay onJump={() => undefined} forceOpen />
      </RefRegistryProvider>,
    );
    const stripped = strip(txt);
    expect(stripped).toContain('Esc to cancel');
  });
});

describe('FileRef render', () => {
  test('renders the path:line as text with a numeric badge when inside a registry', () => {
    const txt = renderToText(
      <RefRegistryProvider>
        <FileRef path="src/foo.ts" line={42} />
      </RefRegistryProvider>,
    );
    const stripped = strip(txt);
    expect(stripped).toContain('[1] src/foo.ts:42');
  });

  test('renders without a badge when no registry is in scope', () => {
    const txt = renderToText(<FileRef path="bar.ts" line={9} />);
    const stripped = strip(txt);
    expect(stripped).toContain('bar.ts:9');
    expect(stripped).not.toContain('[1]');
  });

  test('omits line/column when only a path is supplied', () => {
    const txt = renderToText(<FileRef path="README.md" />);
    const stripped = strip(txt);
    expect(stripped).toContain('README.md');
    expect(stripped).not.toMatch(/README\.md:\d/);
  });
});
