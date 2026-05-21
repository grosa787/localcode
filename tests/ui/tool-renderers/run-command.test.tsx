/**
 * TOOL-RENDERERS-SECTION — tests for the `run_command` rich renderer.
 *
 * Asserts the structural elements expected by the visual contract:
 *   - command line is rendered with `$ ` prefix,
 *   - tail body is at most 10 lines with `▎ ` prefix,
 *   - exit-code badge renders `✓ exit 0` on success and `✗ exit N` on failure.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import { render as renderRunCommand } from '@/ui/tool-renderers/run-command';

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

describe('run_command renderer', () => {
  test('renders the command prefix and exit 0 badge on success', () => {
    const element = renderRunCommand(
      { command: 'echo hi' },
      { status: 'done', output: 'hi' },
      { projectRoot: '/p' },
    );
    expect(element).not.toBeNull();
    const stripped = strip(renderToText(element));
    expect(stripped).toContain('$ echo hi');
    expect(stripped).toContain('▎ hi');
    expect(stripped).toContain('exit 0');
  });

  test('renders non-zero exit code from error message', () => {
    const element = renderRunCommand(
      { command: 'false' },
      {
        status: 'error',
        output: '',
        error: 'Exit 1: command failed',
      },
      { projectRoot: '/p' },
    );
    expect(element).not.toBeNull();
    const stripped = strip(renderToText(element));
    expect(stripped).toContain('$ false');
    expect(stripped).toContain('exit 1');
  });

  test('tail is capped at 10 lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const element = renderRunCommand(
      { command: 'seq 30' },
      { status: 'done', output: lines.join('\n') },
      { projectRoot: '/p' },
    );
    const stripped = strip(renderToText(element));
    // First few lines should be ABSENT (they fell off the tail).
    expect(stripped).not.toContain('▎ line1\n');
    expect(stripped).not.toContain('▎ line10\n');
    // Last lines are present.
    expect(stripped).toContain('▎ line30');
    expect(stripped).toContain('▎ line21');
  });

  test('flags stderr presence when output has [stderr] block', () => {
    const element = renderRunCommand(
      { command: 'bad' },
      { status: 'done', output: 'mixed\n[stderr]\nwarning' },
      { projectRoot: '/p' },
    );
    const stripped = strip(renderToText(element));
    expect(stripped).toContain('[stderr]');
  });

  test('renders cwd when provided in args', () => {
    const element = renderRunCommand(
      { command: 'ls', cwd: '/tmp/sub' },
      { status: 'done', output: 'a\nb' },
      { projectRoot: '/p' },
    );
    const stripped = strip(renderToText(element));
    expect(stripped).toContain('(in /tmp/sub)');
  });
});
