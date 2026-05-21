/**
 * Render-level tests for `<CodeBlock>` (ROADMAP #3).
 *
 * We mount the component into ink's `render()` with `debug: true` and
 * a captured Writable, then assert on STRUCTURAL features of the
 * rendered output:
 *   - the language header is present,
 *   - the line counter ("N lines" / "M/N lines") is present,
 *   - line numbers appear in the gutter,
 *   - bordered frame characters appear when the frame is enabled,
 *   - frameless mode has no border characters,
 *   - the truncation footer appears for over-long input.
 *
 * We deliberately do NOT assert on specific ANSI sequences — chalk's
 * exact output (e.g. `38;2;...` vs `38;5;...`) can drift across
 * terminals and we don't want CI to flake on aesthetic reformatting.
 *
 * Why ink rather than react-test-renderer? `<CodeBlock>` uses ink's
 * `<Box>` and `<Text>` components which expect ink's reconciler. Using
 * ink's own `render()` with debug-mode keeps the assertions honest.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import CodeBlock from '@/ui/components/CodeBlock';

interface CapturedOutput {
  readonly text: string;
}

/**
 * Mount `<CodeBlock>` once with the given props, capture its rendered
 * output, then unmount. Returns the concatenated stdout text.
 */
function renderCodeBlock(props: React.ComponentProps<typeof CodeBlock>): CapturedOutput {
  const buf: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  // ink's render needs a TTY-shaped stream.
  (stream as unknown as { columns: number }).columns = 100;
  (stream as unknown as { rows: number }).rows = 40;
  (stream as unknown as { isTTY: boolean }).isTTY = true;

  const instance = render(React.createElement(CodeBlock, props), {
    // The `as any`s are because ink's typed render() expects
    // process.stdout's full shape; our minimal Writable is fine for
    // our purposes here. We strip ANSI before asserting.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout: stream as any,
    debug: true,
    exitOnCtrlC: false,
  });
  instance.unmount();
  return { text: Buffer.concat(buf).toString('utf8') };
}

/** Strip ANSI escape sequences for content-level assertions. */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

beforeAll(() => {
  // Force chalk into truecolour mode so our captured output is
  // deterministic across CI shells.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // (avoid require — we set it via env so chalk picks it up at import).
  process.env['FORCE_COLOR'] = '3';
});

describe('<CodeBlock> — header & metadata', () => {
  test('renders language header for a TypeScript snippet', () => {
    const out = renderCodeBlock({
      code: 'const x: number = 42;',
      language: 'ts',
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('▸ typescript');
    expect(stripped).toContain('1 line');
  });

  test('renders header for Python snippet', () => {
    const out = renderCodeBlock({
      code: 'def hello():\n    return 1',
      language: 'python',
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('▸ python');
    expect(stripped).toContain('2 lines');
  });

  test('falls back to "code" header when language is unresolvable', () => {
    const out = renderCodeBlock({
      code: 'just some random words here',
      language: 'totally-not-a-real-language',
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('▸ code');
  });

  test('uses headerOverride when provided', () => {
    const out = renderCodeBlock({
      code: 'x = 1',
      language: 'python',
      headerOverride: 'snippet',
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('▸ snippet');
  });
});

describe('<CodeBlock> — gutter & line numbers', () => {
  test('shows line numbers by default', () => {
    const out = renderCodeBlock({
      code: 'a\nb\nc',
      language: 'plaintext',
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('1 │');
    expect(stripped).toContain('2 │');
    expect(stripped).toContain('3 │');
  });

  test('hides gutter when showLineNumbers=false', () => {
    const out = renderCodeBlock({
      code: 'line one\nline two',
      language: 'plaintext',
      showLineNumbers: false,
    });
    const stripped = strip(out.text);
    expect(stripped).not.toContain(' │ ');
  });

  test('right-aligns line numbers based on count width', () => {
    // 12 lines → max width is 2; first 9 lines are pad-left to width 2.
    const code = Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\n');
    const out = renderCodeBlock({ code, language: 'plaintext' });
    const stripped = strip(out.text);
    // Right-aligned " 1 │" (with leading space) and "10 │"
    expect(stripped).toMatch(/(^|\n)\s*│\s+1 │/);
    expect(stripped).toContain('10 │');
  });
});

describe('<CodeBlock> — frame', () => {
  test('round-frame characters appear by default', () => {
    const out = renderCodeBlock({
      code: 'x',
      language: 'plaintext',
    });
    // ink uses Unicode box-drawing for borderStyle="round"
    expect(out.text).toContain('╭');
    expect(out.text).toContain('╰');
    expect(out.text).toContain('│');
  });

  test('frameless mode omits border characters', () => {
    const out = renderCodeBlock({
      code: 'x',
      language: 'plaintext',
      frameless: true,
    });
    expect(out.text).not.toContain('╭');
    expect(out.text).not.toContain('╰');
  });
});

describe('<CodeBlock> — truncation', () => {
  test('shows "more lines" footer when over maxLines', () => {
    const code = Array.from({ length: 15 }, (_, i) => `line${i}`).join('\n');
    const out = renderCodeBlock({
      code,
      language: 'plaintext',
      maxLines: 5,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('5/15 lines');
    expect(stripped).toContain('10 more lines');
    expect(stripped).toContain('truncated');
  });

  test('no truncation footer when content fits', () => {
    const code = 'a\nb\nc';
    const out = renderCodeBlock({
      code,
      language: 'plaintext',
      maxLines: 200,
    });
    const stripped = strip(out.text);
    expect(stripped).not.toContain('truncated');
    expect(stripped).toContain('3 lines');
  });

  test('"more line" (singular) when only one is hidden', () => {
    const code = Array.from({ length: 6 }, (_, i) => `r${i}`).join('\n');
    const out = renderCodeBlock({
      code,
      language: 'plaintext',
      maxLines: 5,
    });
    const stripped = strip(out.text);
    expect(stripped).toContain('1 more line');
    expect(stripped).not.toContain('1 more lines');
  });
});

describe('<CodeBlock> — content rendering', () => {
  test('preserves code text in output (after ANSI strip)', () => {
    const code = 'function foo() { return 42; }';
    const out = renderCodeBlock({ code, language: 'typescript' });
    const stripped = strip(out.text);
    expect(stripped).toContain('function');
    expect(stripped).toContain('foo');
    expect(stripped).toContain('42');
  });

  test('language detection kicks in when no language is provided', () => {
    const code = 'def greet(name):\n    print("hi", name)\n    return self.x';
    const out = renderCodeBlock({ code, language: undefined });
    const stripped = strip(out.text);
    expect(stripped).toContain('▸ python');
  });

  test('blank lines are preserved in line count', () => {
    const code = 'a\n\nb\n\nc';
    const out = renderCodeBlock({ code, language: 'plaintext' });
    const stripped = strip(out.text);
    expect(stripped).toContain('5 lines');
    expect(stripped).toContain('1 │');
    expect(stripped).toContain('5 │');
  });
});
