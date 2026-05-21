/**
 * Render-level tests for `<StreamOutput>` (ROADMAP #3).
 *
 * The streaming variant has THREE distinct rendering modes that must
 * be exercised:
 *
 *   1. Pure prose — no fences in the buffer at all.
 *   2. Completed fence pair — buffer contains ```lang\n…\n```; the
 *      block must be highlighted just like a committed message.
 *   3. Open / "live" fence — buffer contains ```lang\n… (no closing
 *      fence yet). The component must NOT crash, must show a
 *      "streaming…" affordance, and must NOT attempt to highlight the
 *      partial content (we use plain muted text instead).
 *
 * As with `code-block.test.tsx`, we use ink's `render({ debug: true })`
 * with a captured Writable to obtain a deterministic output snapshot
 * and assert on STRUCTURAL features rather than ANSI bytes.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import StreamOutput from '@/ui/components/StreamOutput';

interface CapturedOutput {
  readonly text: string;
}

function renderStream(text: string): CapturedOutput {
  const buf: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stream as unknown as { columns: number }).columns = 100;
  (stream as unknown as { rows: number }).rows = 40;
  (stream as unknown as { isTTY: boolean }).isTTY = true;

  const instance = render(React.createElement(StreamOutput, { text }), {
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

describe('<StreamOutput> — pure prose', () => {
  test('renders plain text without crashing', () => {
    const out = renderStream('hello there');
    const stripped = strip(out.text);
    expect(stripped).toContain('hello there');
  });

  test('empty text renders without throwing', () => {
    expect(() => renderStream('')).not.toThrow();
  });

  test('single newline renders without throwing', () => {
    expect(() => renderStream('\n')).not.toThrow();
  });
});

describe('<StreamOutput> — completed fence pair', () => {
  test('shows highlighted block with full frame', () => {
    const text = [
      'Here is some code:',
      '```typescript',
      'const x: number = 42;',
      '```',
      'Done.',
    ].join('\n');
    const out = renderStream(text);
    const stripped = strip(out.text);
    expect(stripped).toContain('Here is some code:');
    expect(stripped).toContain('▸ typescript');
    expect(stripped).toContain('1 line');
    expect(stripped).toContain('Done.');
    // box border for completed fence
    expect(out.text).toContain('╭');
    expect(out.text).toContain('╰');
  });

  test('multiple completed fences render in order', () => {
    const text = [
      '```ts',
      'const a = 1;',
      '```',
      'between',
      '```python',
      'b = 2',
      '```',
    ].join('\n');
    const out = renderStream(text);
    const stripped = strip(out.text);
    const tsIdx = stripped.indexOf('▸ typescript');
    const betweenIdx = stripped.indexOf('between');
    const pyIdx = stripped.indexOf('▸ python');
    expect(tsIdx).toBeGreaterThanOrEqual(0);
    expect(betweenIdx).toBeGreaterThan(tsIdx);
    expect(pyIdx).toBeGreaterThan(betweenIdx);
  });
});

describe('<StreamOutput> — live (open) fence', () => {
  test('shows streaming indicator while fence is open', () => {
    const text = [
      'Let me write some code:',
      '```typescript',
      'const x = ',
    ].join('\n');
    const out = renderStream(text);
    const stripped = strip(out.text);
    expect(stripped).toContain('Let me write some code:');
    expect(stripped).toContain('▸ typescript');
    expect(stripped).toContain('streaming');
    // No bordered frame for live tail (we use frameless render).
    // The completed prose section still has no border, so we just
    // assert that the streaming affordance text exists.
    expect(stripped).toContain('const x =');
  });

  test('open fence with no language uses default header', () => {
    const text = ['```', 'partial text incoming'].join('\n');
    const out = renderStream(text);
    const stripped = strip(out.text);
    expect(stripped).toContain('▸ code');
    expect(stripped).toContain('streaming');
    expect(stripped).toContain('partial text incoming');
  });

  test('open fence with empty body still renders without throwing', () => {
    expect(() => renderStream('```ts\n')).not.toThrow();
    const out = renderStream('```ts\n');
    const stripped = strip(out.text);
    expect(stripped).toContain('▸ typescript');
  });

  test('transitioning from open → closed yields a framed block', () => {
    const open = renderStream('```ts\nconst x = 1');
    const closed = renderStream('```ts\nconst x = 1\n```');
    const openStripped = strip(open.text);
    const closedStripped = strip(closed.text);
    // open: streaming indicator
    expect(openStripped).toContain('streaming');
    // closed: full bordered block
    expect(closedStripped).not.toContain('streaming');
    expect(closed.text).toContain('╭');
    expect(closed.text).toContain('╰');
  });
});

describe('<StreamOutput> — inline code in prose', () => {
  test('inline code spans render alongside prose', () => {
    const text = 'Use the `console.log` API to print.';
    const out = renderStream(text);
    const stripped = strip(out.text);
    // Backticks are preserved around the styled inner text
    expect(stripped).toContain('`console.log`');
    expect(stripped).toContain('Use the');
    expect(stripped).toContain('to print.');
  });
});

describe('<StreamOutput> — combination scenarios', () => {
  test('completed code block followed by open code block', () => {
    const text = [
      '```ts',
      'const a = 1;',
      '```',
      'Now another:',
      '```python',
      'b = 2',
    ].join('\n');
    const out = renderStream(text);
    const stripped = strip(out.text);
    expect(stripped).toContain('▸ typescript');
    expect(stripped).toContain('Now another:');
    expect(stripped).toContain('▸ python');
    expect(stripped).toContain('streaming');
  });

  test('does not strip the very last visible character of a partial line', () => {
    // Regression target: when the buffer is mid-character ("hell")
    // we MUST render every character. No trimming.
    const out = renderStream('hell');
    const stripped = strip(out.text);
    expect(stripped).toContain('hell');
  });
});
