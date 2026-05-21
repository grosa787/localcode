/**
 * TOOL-RENDERERS-SECTION — tests for the `list_dir` rich renderer.
 *
 * Asserts:
 *   - folder lines render with the 📁 glyph and a trailing slash,
 *   - file lines render with the 📄 glyph,
 *   - meta lines (max-depth marker) render verbatim.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import { render as renderListDir } from '@/ui/tool-renderers/list-dir';

function renderToText(element: React.ReactElement | null): string {
  if (element === null) return '';
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

describe('list_dir renderer', () => {
  test('renders folder and file icons', () => {
    const tree = ['root/', '  src/', '    main.ts', '    util.ts', '  README.md'].join('\n');
    const element = renderListDir(
      { path: '.' },
      { status: 'done', output: tree },
      { projectRoot: '/p' },
    );
    expect(element).not.toBeNull();
    const stripped = strip(renderToText(element));
    expect(stripped).toContain('📁');
    expect(stripped).toContain('📄');
    expect(stripped).toContain('root/');
    expect(stripped).toContain('main.ts');
  });

  test('passes through meta lines verbatim', () => {
    const tree = 'root/\n  [... max depth 5 reached ...]';
    const element = renderListDir(
      { path: '.' },
      { status: 'done', output: tree },
      { projectRoot: '/p' },
    );
    const stripped = strip(renderToText(element));
    expect(stripped).toContain('max depth 5 reached');
  });

  test('returns null when status is not done', () => {
    const out = renderListDir(
      { path: '.' },
      { status: 'running' },
      { projectRoot: '/p' },
    );
    expect(out).toBeNull();
  });

  test('returns null when output is empty', () => {
    const out = renderListDir(
      { path: '.' },
      { status: 'done', output: '' },
      { projectRoot: '/p' },
    );
    expect(out).toBeNull();
  });
});
