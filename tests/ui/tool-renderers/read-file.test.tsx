/**
 * TOOL-RENDERERS-SECTION — tests for the `read_file` rich renderer.
 *
 * We mount the renderer directly into ink's `render({ debug: true })`
 * harness and assert on structural features of the captured output:
 *   - the path appears in the header (CodeBlock's `▸ <path>` line),
 *   - line numbers appear in the gutter for short bodies,
 *   - long bodies (> 40 lines) fold to head + separator + tail.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import { render as renderReadFile } from '@/ui/tool-renderers/read-file';

interface CapturedOutput {
  readonly text: string;
}

function renderToText(element: React.ReactElement | null): CapturedOutput {
  if (element === null) {
    return { text: '' };
  }
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
  return { text: Buffer.concat(buf).toString('utf8') };
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '3';
});

describe('read_file renderer', () => {
  test('returns null when status is not done', () => {
    const out = renderReadFile(
      { path: 'foo.ts' },
      { status: 'pending' },
      { projectRoot: '/p' },
    );
    expect(out).toBeNull();
  });

  test('returns null when output is empty', () => {
    const out = renderReadFile(
      { path: 'foo.ts' },
      { status: 'done', output: '' },
      { projectRoot: '/p' },
    );
    expect(out).toBeNull();
  });

  test('renders header with path and line numbers for short body', () => {
    const element = renderReadFile(
      { path: 'src/foo.ts' },
      {
        status: 'done',
        output: 'const x: number = 1;\nconst y: string = "two";',
      },
      { projectRoot: '/p' },
    );
    expect(element).not.toBeNull();
    const stripped = strip(renderToText(element).text);
    expect(stripped).toContain('src/foo.ts');
    expect(stripped).toContain('1 │');
    expect(stripped).toContain('2 │');
  });

  test('folds long body into head/tail with hidden-lines separator', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const element = renderReadFile(
      { path: 'big.txt' },
      { status: 'done', output: lines.join('\n') },
      { projectRoot: '/p' },
    );
    const stripped = strip(renderToText(element).text);
    // Head includes first 20 lines.
    expect(stripped).toContain('line 1');
    expect(stripped).toContain('line 20');
    // The middle is hidden.
    expect(stripped).not.toContain('line 40');
    // Tail includes last 5.
    expect(stripped).toContain('line 60');
    // The hidden-lines separator is rendered (count is 60 - 20 - 5 = 35).
    expect(stripped).toContain('35 lines hidden');
  });

  test('summary mode renders the raw summary text without the gutter', () => {
    const element = renderReadFile(
      { path: 'foo.ts', respondWithSummary: true },
      {
        status: 'done',
        output: '--- Summary of foo.ts ---\nLines: 100\nSize: 4.0 KB',
      },
      { projectRoot: '/p' },
    );
    const stripped = strip(renderToText(element).text);
    expect(stripped).toContain('Summary of foo.ts');
    expect(stripped).toContain('Lines: 100');
    // Gutter glyph is absent in summary mode.
    expect(stripped).not.toContain(' │ ');
  });
});
