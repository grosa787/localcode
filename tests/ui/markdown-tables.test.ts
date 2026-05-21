/**
 * TUI rendering test for GFM tables in `<MessageBlock>`. Renders a
 * known table to a captured stream and asserts header/separator/body
 * structure appears.
 */

import { describe, expect, test, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import MessageBlock from '@/ui/components/MessageBlock';

interface Captured {
  readonly text: string;
}

function renderMessage(content: string): Captured {
  const buf: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stream as unknown as { columns: number }).columns = 120;
  (stream as unknown as { rows: number }).rows = 50;
  (stream as unknown as { isTTY: boolean }).isTTY = true;

  const instance = render(
    React.createElement(MessageBlock, {
      role: 'assistant',
      label: 'test-model',
      content,
    }),
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdout: stream as any,
      debug: true,
      exitOnCtrlC: false,
    },
  );
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

describe('<MessageBlock> — GFM tables', () => {
  test('renders a 2x2 table with header, separator, and body', () => {
    const src = `Here is a table:

| Name | Score |
| ---- | ----- |
| Ada  | 99    |
| Bob  | 42    |

Done.`;
    const out = renderMessage(src);
    const stripped = strip(out.text);
    expect(stripped).toContain('Name');
    expect(stripped).toContain('Score');
    expect(stripped).toContain('Ada');
    expect(stripped).toContain('99');
    expect(stripped).toContain('Bob');
    expect(stripped).toContain('42');
    // Surrounding paragraphs survive.
    expect(stripped).toContain('Here is a table:');
    expect(stripped).toContain('Done.');
    // Table separator characters appear.
    expect(stripped).toContain('─');
    expect(stripped).toContain('│');
  });

  test('right/center alignment pads cells visibly', () => {
    const src = `| L | C | R |
| :--- | :---: | ---: |
| a | b | c |`;
    const out = renderMessage(src);
    const stripped = strip(out.text);
    // All header tokens render and column separators land between them.
    expect(stripped).toMatch(/L\s+/);
    expect(stripped).toMatch(/\s+R/);
    expect(stripped).toContain('│');
  });

  test('plain markdown without a separator line is not parsed as a table', () => {
    const src = 'pipes | here | are | not | a table';
    const out = renderMessage(src);
    const stripped = strip(out.text);
    expect(stripped).toContain('pipes');
    // No box-drawing border on pure text.
    expect(stripped).not.toMatch(/─{5,}/);
  });

  test('header-only table renders just the header', () => {
    const src = `| Col1 | Col2 |
| --- | --- |`;
    const out = renderMessage(src);
    const stripped = strip(out.text);
    expect(stripped).toContain('Col1');
    expect(stripped).toContain('Col2');
    expect(stripped).toContain('─');
  });
});
