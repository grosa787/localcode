/**
 * Dispatch test (TUI): an assistant message containing a ```mermaid
 * fence is rendered by the ASCII diagram path, not by the generic
 * syntax-highlighting code block.
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
  (stream as unknown as { columns: number }).columns = 80;
  (stream as unknown as { rows: number }).rows = 40;
  (stream as unknown as { isTTY: boolean }).isTTY = true;

  const instance = render(
    React.createElement(MessageBlock, {
      role: 'assistant',
      label: 'test-model',
      content,
    }),
    {
      stdout: stream as unknown as NodeJS.WriteStream,
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

describe('<MessageBlock> — mermaid dispatch', () => {
  test('mermaid fence renders ASCII diagram (not raw code block)', () => {
    const src = 'Here is a diagram:\n\n```mermaid\nflowchart TB\nA[Start] --> B[End]\n```\n\nDone.';
    const out = renderMessage(src);
    const stripped = strip(out.text);
    // ASCII header used by the mermaid renderer:
    expect(stripped).toContain('mermaid');
    // Boxes with node labels:
    expect(stripped).toContain('Start');
    expect(stripped).toContain('End');
    // Surrounding text is preserved:
    expect(stripped).toContain('Here is a diagram:');
    expect(stripped).toContain('Done.');
  });

  test('non-mermaid language still uses the syntax-highlight code block', () => {
    const src = '```js\nconst x = 1;\n```';
    const out = renderMessage(src);
    const stripped = strip(out.text);
    // The plain code path tags blocks with `▸ ` plus the language. The
    // mermaid path uses `▸ mermaid` exclusively.
    expect(stripped).toContain('const x = 1;');
    expect(stripped.includes('▸ mermaid')).toBe(false);
  });
});
