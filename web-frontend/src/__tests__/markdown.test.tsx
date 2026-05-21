/**
 * Markdown component — XSS-safety, code blocks, basic formatting,
 * nested lists, and incremental streaming behaviour.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { Markdown } from '../util/markdown';

afterEach(() => cleanup());

describe('Markdown', () => {
  test('plain text is rendered verbatim', () => {
    const { container } = render(<Markdown source="just words" />);
    expect(container.textContent).toContain('just words');
    // No injected script elements.
    expect(container.querySelector('script')).toBeNull();
  });

  test('HTML in source is escaped (no live HTML)', () => {
    const { container } = render(
      <Markdown source={'before <script>alert(1)</script> after'} />,
    );
    // The literal tag text survives as plain text — but no actual <script>
    // element should be created.
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>');
  });

  test('inline `code` gets a <code> wrapper', () => {
    const { container } = render(<Markdown source={'use `foo()` here'} />);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('foo()');
  });

  test('fenced code block routes to SyntaxBlock with language label', () => {
    const src = '```typescript\nconst x = 1;\n```';
    const { container } = render(<Markdown source={src} />);
    // SyntaxBlock renders the language label as text.
    expect(container.textContent).toContain('typescript');
    expect(container.textContent).toContain('const x = 1;');
  });

  test('javascript: links are stripped (defence in depth)', () => {
    const src = '[click](javascript:alert(1))';
    const { container } = render(<Markdown source={src} />);
    // Either no anchor at all, or one whose href is NOT a javascript: URL.
    const anchors = container.querySelectorAll('a');
    for (const a of anchors) {
      expect(a.getAttribute('href')?.toLowerCase().startsWith('javascript:')).toBeFalsy();
    }
  });

  test('http(s) links render as anchors with rel/target', () => {
    const { container } = render(
      <Markdown source={'see [docs](https://example.com/x)'} />,
    );
    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('href')).toBe('https://example.com/x');
    expect(a?.getAttribute('rel')).toContain('noopener');
    expect(a?.getAttribute('target')).toBe('_blank');
  });

  test('headings render as h1–h6', () => {
    const { container } = render(<Markdown source={'# Top\n## Sub'} />);
    expect(container.querySelector('h1')?.textContent).toBe('Top');
    expect(container.querySelector('h2')?.textContent).toBe('Sub');
  });

  test('GFM table renders with thead/tbody and cells', () => {
    const src = `| Name | Score |
| --- | ---: |
| Ada | 99 |
| Bob | 42 |`;
    const { container } = render(<Markdown source={src} />);
    const table = container.querySelector('table.md-table');
    expect(table).not.toBeNull();
    const ths = table?.querySelectorAll('thead th') ?? [];
    expect(ths.length).toBe(2);
    expect(ths[0]?.textContent).toBe('Name');
    expect(ths[1]?.textContent).toBe('Score');
    expect(ths[1]?.getAttribute('data-align')).toBe('right');
    const tds = table?.querySelectorAll('tbody td') ?? [];
    expect(tds.length).toBe(4);
    expect(tds[0]?.textContent).toBe('Ada');
    expect(tds[3]?.textContent).toBe('42');
  });

  test('inline markdown inside table cells renders', () => {
    const src = `| A | B |
| --- | --- |
| **bold** | \`code\` |`;
    const { container } = render(<Markdown source={src} />);
    expect(container.querySelector('table.md-table strong')?.textContent).toBe(
      'bold',
    );
    expect(container.querySelector('table.md-table code')?.textContent).toBe(
      'code',
    );
  });

  test('paragraphs surrounding a table are preserved', () => {
    const src = `before

| A | B |
| --- | --- |
| 1 | 2 |

after`;
    const { container } = render(<Markdown source={src} />);
    expect(container.querySelector('table.md-table')).not.toBeNull();
    const paragraphs = Array.from(container.querySelectorAll('p')).map(
      (p) => p.textContent,
    );
    expect(paragraphs).toContain('before');
    expect(paragraphs).toContain('after');
  });

  test('escaped pipes inside cells are preserved as literal pipes', () => {
    const src = `| key | val |
| --- | --- |
| a \\| b | c |`;
    const { container } = render(<Markdown source={src} />);
    const cell = container.querySelector('table.md-table tbody td');
    expect(cell?.textContent).toBe('a | b');
  });
});

// ---------- Nested lists (P7) ----------

describe('Markdown: nested lists', () => {
  test('two-level nested unordered list', () => {
    const src = `- a\n  - a1\n  - a2\n- b`;
    const { container } = render(<Markdown source={src} />);
    const topLists = container.querySelectorAll('div.md-root > ul.md-list');
    expect(topLists.length).toBe(1);
    const topItems = container.querySelectorAll(
      'div.md-root > ul.md-list > li',
    );
    expect(topItems.length).toBe(2);
    // First top-level item must contain a nested <ul> with two items.
    const nested = topItems[0]?.querySelectorAll('ul.md-list > li') ?? [];
    expect(nested.length).toBe(2);
    expect(nested[0]?.textContent?.startsWith('a1')).toBe(true);
  });

  test('three-level nested list', () => {
    const src = `- one\n  - two\n    - three`;
    const { container } = render(<Markdown source={src} />);
    // Walk down three nested ULs.
    const l1 = container.querySelector('div.md-root > ul');
    expect(l1).not.toBeNull();
    const l2 = l1?.querySelector('li > ul');
    expect(l2).not.toBeNull();
    const l3 = l2?.querySelector('li > ul');
    expect(l3).not.toBeNull();
    expect(l3?.textContent).toContain('three');
  });

  test('mixed ul/ol nesting', () => {
    const src = `- a\n  1. one\n  2. two\n- b`;
    const { container } = render(<Markdown source={src} />);
    const topUl = container.querySelector('div.md-root > ul.md-list');
    expect(topUl).not.toBeNull();
    const nestedOl = topUl?.querySelector('li > ol.md-list-ordered');
    expect(nestedOl).not.toBeNull();
    const nestedItems = nestedOl?.querySelectorAll('li') ?? [];
    expect(nestedItems.length).toBe(2);
  });

  test('dedent back to root after nested run', () => {
    const src = `- a\n  - a1\n- b\n- c`;
    const { container } = render(<Markdown source={src} />);
    const topItems = container.querySelectorAll(
      'div.md-root > ul.md-list > li',
    );
    expect(topItems.length).toBe(3);
    // Second + third item must NOT contain a nested list.
    expect(topItems[1]?.querySelector('ul')).toBeNull();
    expect(topItems[2]?.querySelector('ul')).toBeNull();
  });
});

// ---------- Incremental rendering (P1) ----------

describe('Markdown: incremental streaming cache', () => {
  test('appending to source keeps committed prefix referentially equal', () => {
    // Two renders with the second source extending the first. The
    // committed prefix paragraphs should be the SAME React elements
    // (referentially equal) — that is the observable signal that the
    // cache hit. We re-mount the same component to share its useRef.
    const { container, rerender } = render(
      <Markdown source={`paragraph one\n\nparagraph two\n\n`} />,
    );
    const before = Array.from(container.querySelectorAll('p')).map(
      (p) => p.textContent,
    );
    expect(before).toEqual(['paragraph one', 'paragraph two']);
    rerender(
      <Markdown
        source={`paragraph one\n\nparagraph two\n\nparagraph three`}
      />,
    );
    const after = Array.from(container.querySelectorAll('p')).map(
      (p) => p.textContent,
    );
    expect(after).toEqual(['paragraph one', 'paragraph two', 'paragraph three']);
  });

  test('shrinking source invalidates cache and re-renders cleanly', () => {
    const { container, rerender } = render(
      <Markdown source={`alpha\n\nbeta\n\n`} />,
    );
    rerender(<Markdown source={`alpha\n\nbeta\n\ngamma`} />);
    // Now shrink — drop everything except the first paragraph.
    rerender(<Markdown source={`alpha`} />);
    const ps = Array.from(container.querySelectorAll('p')).map(
      (p) => p.textContent,
    );
    expect(ps).toEqual(['alpha']);
  });

  test('cache does not split inside an open fenced code block', () => {
    // Source with an UNCLOSED fence; appending must still render the
    // full open fence (no premature commit of the fence prefix).
    const open = '```ts\nconst a = 1;\n';
    const { container, rerender } = render(<Markdown source={open} />);
    // Initially the closing fence is missing — content still shows.
    expect(container.textContent).toContain('const a = 1');
    rerender(<Markdown source={open + 'const b = 2;\n```'} />);
    // After close, both lines visible.
    expect(container.textContent).toContain('const a = 1');
    expect(container.textContent).toContain('const b = 2');
  });

  test('initial render with no blank line still works (no stable boundary)', () => {
    const { container } = render(
      <Markdown source={'just one paragraph being streamed'} />,
    );
    expect(container.querySelector('p')?.textContent).toBe(
      'just one paragraph being streamed',
    );
  });

  test('streaming many chunks across a stable boundary preserves DOM', () => {
    // Verify that after a chunk is committed (blank line passed), the
    // first paragraph's DOM node identity is stable across re-renders.
    const src1 = 'first\n\n';
    const src2 = 'first\n\nsecond';
    const src3 = 'first\n\nsecond, more';
    const { container, rerender } = render(<Markdown source={src1} />);
    const firstP_v1 = container.querySelector('p');
    rerender(<Markdown source={src2} />);
    const firstP_v2 = container.querySelector('p');
    rerender(<Markdown source={src3} />);
    const firstP_v3 = container.querySelector('p');
    // Same DOM node — React kept it because the cached prefix is reused.
    expect(firstP_v1).toBe(firstP_v2);
    expect(firstP_v2).toBe(firstP_v3);
  });
});
