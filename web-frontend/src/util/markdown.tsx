/**
 * Markdown renderer for chat messages.
 *
 * Hand-rolled, dependency-free, XSS-safe by construction (we never set
 * `dangerouslySetInnerHTML`; we build a React tree). Supports the markdown
 * features that actually appear in LocalCode chat output:
 *
 *   - paragraphs separated by blank lines
 *   - ATX headings `#`–`######`
 *   - fenced code blocks ```lang ... ``` (rendered via `SyntaxBlock`)
 *   - blockquotes `> …`
 *   - unordered lists `-`, `*`, `+` (incl. nested via indentation)
 *   - ordered lists `1.` `2.` … (incl. nested via indentation)
 *   - horizontal rule `---`
 *   - inline: **bold**, *italic*, `code`, [text](url), autolinks
 *
 * The grammar is intentionally simple. The TUI ships with the same
 * subset, and the design system limits us to a minimal, beautiful
 * surface — fancy markdown features (tables, footnotes, definition
 * lists) can be added later if required.
 *
 * Why hand-rolled rather than `markdown-it`?
 *   1. Zero deps keeps the SPA bundle lean (~3KB extra here vs ~80KB for
 *      `markdown-it` + types).
 *   2. The TUI already uses a custom renderer; same visual contract.
 *   3. Trivially auditable for XSS — the only escape surface is the
 *      autolink href, which we whitelist to http/https/mailto.
 *
 * Streaming perf:
 *   Re-parsing a 2000-line document on every SSE chunk dominates render
 *   time. The `Markdown` component caches the rendered React tree for
 *   the longest *parser-stable* prefix of the source (see
 *   `incremental-markdown.ts` for the boundary algorithm). On subsequent
 *   renders we only re-parse `source.slice(boundary)` and concatenate
 *   the cached prefix with the freshly-parsed tail.
 */

import { useRef, type JSX, type ReactNode } from 'react';

import { SyntaxBlock } from '../components/SyntaxBlock';
// MERMAID-DISPATCH-SECTION (web): ```mermaid blocks render via the
// dedicated <MermaidBlock> component (lazy-loads the mermaid library)
// instead of the syntax-highlighted pre.
import { MermaidBlock } from '../components/MermaidBlock';
import {
  parseTables,
  type Alignment,
  type ParsedTable,
} from '../../../src/ui/markdown/table-detector';
import {
  findStableBoundary,
  fnv1a,
  isCacheValid,
  type IncrementalCacheKey,
} from './incremental-markdown';

interface BlockBase {
  key: string;
}

// List items can themselves contain nested lists, so we model items as
// either inline text OR a nested list. A flat string carries inline
// markdown which downstream renders through `renderInline`.
type ListItem = {
  text: string;
  nested?: ListBlock;
};

type ListBlock = BlockBase & {
  kind: 'list';
  ordered: boolean;
  items: ListItem[];
};

type Block =
  | (BlockBase & { kind: 'paragraph'; text: string })
  | (BlockBase & { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string })
  | (BlockBase & { kind: 'code'; lang: string | null; content: string })
  | (BlockBase & { kind: 'blockquote'; text: string })
  | ListBlock
  | (BlockBase & { kind: 'hr' });

const FENCE_RE = /^```(\S*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^(?:---|\*\*\*|___)\s*$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;

/**
 * Indent width — every 2 spaces (or one tab) bumps the nesting level
 * by one. Mirrors GFM's "each level of nesting requires 2 additional
 * spaces of indentation" behaviour. We use floor so an item indented
 * 3 spaces still counts as depth 1 (lenient toward LLM output).
 */
function indentDepth(prefix: string): number {
  // Tabs count as 4 spaces.
  let spaces = 0;
  for (const c of prefix) {
    if (c === '\t') spaces += 4;
    else if (c === ' ') spaces += 1;
    else break;
  }
  return Math.floor(spaces / 2);
}

interface ListLineMatch {
  ordered: boolean;
  depth: number;
  text: string;
}

function matchListLine(line: string): ListLineMatch | null {
  const ul = UL_RE.exec(line);
  if (ul !== null) {
    return {
      ordered: false,
      depth: indentDepth(ul[1] ?? ''),
      text: ul[3] ?? '',
    };
  }
  const ol = OL_RE.exec(line);
  if (ol !== null) {
    return {
      ordered: true,
      depth: indentDepth(ol[1] ?? ''),
      text: ol[3] ?? '',
    };
  }
  return null;
}

/**
 * Parse a contiguous run of list-shaped lines starting at `start` into
 * a possibly-nested `ListBlock`. Returns the next line index after the
 * list ends.
 */
function parseList(
  lines: string[],
  start: number,
  k: () => string,
): { block: ListBlock; next: number } {
  const first = matchListLine(lines[start] ?? '');
  // Caller already verified `first` is non-null.
  if (first === null) {
    throw new Error('parseList: precondition violated');
  }
  const baseDepth = first.depth;
  const root: ListBlock = {
    kind: 'list',
    key: k(),
    ordered: first.ordered,
    items: [],
  };
  let i = start;
  while (i < lines.length) {
    const m = matchListLine(lines[i] ?? '');
    if (m === null) break;
    if (m.depth < baseDepth) break;
    if (m.depth > baseDepth) {
      // Nested list — recurse from this line. Attach to the LAST item
      // of the current root (the parent list-item owns the nested list).
      const last = root.items[root.items.length - 1];
      if (last === undefined) {
        // Lone deeper line with no preceding item at base depth — treat
        // it as if it were at base depth (lenient fallback).
        root.items.push({ text: m.text });
        i++;
        continue;
      }
      // If the deeper-depth ordered/unordered shape differs from prior
      // sibling nested list, replace; otherwise extend. We always
      // recurse and let `parseList` consume the full nested run.
      const sub = parseList(lines, i, k);
      last.nested = sub.block;
      i = sub.next;
      continue;
    }
    // Same depth — but if `ordered` flips, the list ends and the caller
    // will start a fresh list with the new ordering.
    if (m.ordered !== root.ordered) break;
    root.items.push({ text: m.text });
    i++;
  }
  return { block: root, next: i };
}

/** Parse a full document into a flat list of block tokens. */
function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  let counter = 0;
  const k = (): string => `b${counter++}`;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Blank line — skip.
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    // Fenced code block.
    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const lang = (fence[1] ?? '').length > 0 ? (fence[1] ?? null) : null;
      i++;
      const buf: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (FENCE_RE.test(l)) {
          i++;
          break;
        }
        buf.push(l);
        i++;
      }
      out.push({ kind: 'code', key: k(), lang, content: buf.join('\n') });
      continue;
    }

    // Heading.
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      const hashes = heading[1] ?? '#';
      const text = heading[2] ?? '';
      const level = Math.min(6, Math.max(1, hashes.length)) as 1 | 2 | 3 | 4 | 5 | 6;
      out.push({ kind: 'heading', key: k(), level, text });
      i++;
      continue;
    }

    // Horizontal rule.
    if (HR_RE.test(line)) {
      out.push({ kind: 'hr', key: k() });
      i++;
      continue;
    }

    // Blockquote — fold consecutive `>` lines.
    const bq = BLOCKQUOTE_RE.exec(line);
    if (bq !== null) {
      const buf: string[] = [bq[1] ?? ''];
      i++;
      while (i < lines.length) {
        const inner = BLOCKQUOTE_RE.exec(lines[i] ?? '');
        if (inner === null) break;
        buf.push(inner[1] ?? '');
        i++;
      }
      out.push({ kind: 'blockquote', key: k(), text: buf.join('\n') });
      continue;
    }

    // List (nested-aware).
    if (matchListLine(line) !== null) {
      const { block, next } = parseList(lines, i, k);
      out.push(block);
      i = next;
      continue;
    }

    // Paragraph — fold consecutive non-special lines.
    const buf: string[] = [line];
    i++;
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (
        l.trim().length === 0 ||
        FENCE_RE.test(l) ||
        HEADING_RE.test(l) ||
        HR_RE.test(l) ||
        BLOCKQUOTE_RE.test(l) ||
        UL_RE.test(l) ||
        OL_RE.test(l)
      ) {
        break;
      }
      buf.push(l);
      i++;
    }
    out.push({ kind: 'paragraph', key: k(), text: buf.join('\n') });
  }

  return out;
}

// ---------- Inline parsing ----------

/**
 * Inline tokens recognised inside paragraph / heading / list-item / quote
 * text. Order in the regex below sets precedence: code > bold > italic >
 * link > autolink.
 */
type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold'; value: InlineToken[] }
  | { kind: 'italic'; value: InlineToken[] }
  | { kind: 'link'; href: string; children: InlineToken[] };

const INLINE_RE =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\(([^)\s]+)\)|<((?:https?|mailto):[^>\s]+)>|(https?:\/\/[^\s<>()]+)/;

function parseInline(src: string): InlineToken[] {
  const out: InlineToken[] = [];
  let cursor = 0;
  let working = src;

  while (working.length > 0) {
    const m = INLINE_RE.exec(working);
    if (m === null) {
      out.push({ kind: 'text', value: working });
      break;
    }
    const before = working.slice(0, m.index);
    if (before.length > 0) {
      out.push({ kind: 'text', value: before });
    }

    if (m[1] !== undefined) {
      out.push({ kind: 'code', value: m[1] });
    } else if (m[2] !== undefined) {
      out.push({ kind: 'bold', value: parseInline(m[2]) });
    } else if (m[3] !== undefined) {
      out.push({ kind: 'bold', value: parseInline(m[3]) });
    } else if (m[4] !== undefined) {
      out.push({ kind: 'italic', value: parseInline(m[4]) });
    } else if (m[5] !== undefined) {
      out.push({ kind: 'italic', value: parseInline(m[5]) });
    } else if (m[6] !== undefined && m[7] !== undefined) {
      const href = sanitiseHref(m[7]);
      if (href === null) {
        out.push({ kind: 'text', value: m[0] });
      } else {
        out.push({ kind: 'link', href, children: parseInline(m[6]) });
      }
    } else if (m[8] !== undefined) {
      const href = sanitiseHref(m[8]);
      if (href === null) {
        out.push({ kind: 'text', value: m[0] });
      } else {
        out.push({ kind: 'link', href, children: [{ kind: 'text', value: m[8] }] });
      }
    } else if (m[9] !== undefined) {
      const href = sanitiseHref(m[9]);
      if (href === null) {
        out.push({ kind: 'text', value: m[0] });
      } else {
        out.push({ kind: 'link', href, children: [{ kind: 'text', value: m[9] }] });
      }
    } else {
      // Should be unreachable; defensive.
      out.push({ kind: 'text', value: m[0] });
    }

    working = working.slice(m.index + m[0].length);
    cursor += m.index + m[0].length;
  }

  return out;
}

/** Allow only http(s)/mailto schemes; everything else becomes plain text. */
function sanitiseHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  return null;
}

function renderInline(tokens: InlineToken[], keyPrefix: string): ReactNode[] {
  return tokens.map((tok, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (tok.kind) {
      case 'text':
        return tok.value;
      case 'code':
        return (
          <code key={key} className="md-inline-code">
            {tok.value}
          </code>
        );
      case 'bold':
        return <strong key={key}>{renderInline(tok.value, key)}</strong>;
      case 'italic':
        return <em key={key}>{renderInline(tok.value, key)}</em>;
      case 'link':
        return (
          <a
            key={key}
            href={tok.href}
            target="_blank"
            rel="noopener noreferrer"
            className="md-link"
          >
            {renderInline(tok.children, key)}
          </a>
        );
    }
  });
}

// ---------- Component ----------

export interface MarkdownProps {
  source: string;
}

/**
 * Render the document. Internally this:
 *   1. Splits `source` into table-blocks via `parseTables`.
 *   2. For each text-block, runs `parseBlocks` and renders blocks.
 *
 * `startIndex` lets the caller continue numbering blocks when the
 * document was rendered in two passes (cached prefix + live tail) —
 * critical for keeping React keys position-stable so the prefix DOM
 * nodes are preserved as the tail grows.
 */
function renderDocument(source: string, startIndex: number): ReactNode[] {
  const tableResult = parseTables(source);
  const children: ReactNode[] = [];
  let segIdx = startIndex;
  for (const block of tableResult.blocks) {
    const seg = `s${segIdx}`;
    if (block.kind === 'text') {
      const sub = parseBlocks(block.content);
      for (const b of sub) {
        const rekeyed = { ...b, key: `${seg}-${b.key}` } as typeof b;
        children.push(renderBlock(rekeyed));
      }
    } else {
      children.push(renderTable(block.table, `t${segIdx}`));
    }
    segIdx++;
  }
  return children;
}

/** Count how many top-level table-detector segments are in `source`. */
function countSegments(source: string): number {
  return parseTables(source).blocks.length;
}

interface IncrementalCacheValue {
  readonly key: IncrementalCacheKey;
  readonly nodes: ReactNode[];
}

interface IncrementalCacheValueExt extends IncrementalCacheValue {
  /** Number of top-level table-detector segments contained in the prefix. */
  readonly segmentCount: number;
}

export function Markdown({ source }: MarkdownProps): JSX.Element {
  // Keep cached prefix nodes across renders. The cache key is a hash +
  // length of the parsed prefix; on every render we verify the cache is
  // still a prefix of `source`, and rebuild from scratch if not.
  //
  // Key-stability strategy: every block carries a positional key
  // `s<N>-b<M>` derived from its top-level segment index. The same
  // (N, M) pair is produced whether a block is rendered as part of the
  // cached prefix or as part of the live tail (we pass the segment
  // count of the prefix as `startIndex` for the tail render). That way,
  // React reuses the SAME DOM node for the prefix paragraphs the moment
  // they're first emitted — and on every subsequent re-render that
  // hits the cache.
  const cacheRef = useRef<IncrementalCacheValueExt | null>(null);
  const cached = cacheRef.current;

  // Boundary for the *current* source — the high-water mark for cache
  // promotion. The component renders [prefix | tail], on EVERY render,
  // so key positions are deterministic per offset.
  const stableLen = findStableBoundary(source);

  let prefixNodes: ReactNode[];
  let prefixLen: number;
  let prefixSegments: number;

  if (
    cached !== null &&
    isCacheValid(cached.key, source) &&
    cached.key.prefixLength === stableLen
  ) {
    // Cache hit AND the boundary hasn't moved — reuse cached nodes.
    prefixNodes = cached.nodes;
    prefixLen = cached.key.prefixLength;
    prefixSegments = cached.segmentCount;
  } else if (stableLen > 0 && stableLen < source.length) {
    // Boundary has a meaningful value (and a tail to live behind it).
    // Parse the prefix once and cache it. Segment indices start at 0.
    const prefix = source.slice(0, stableLen);
    prefixNodes = renderDocument(prefix, 0);
    prefixLen = stableLen;
    prefixSegments = countSegments(prefix);
    cacheRef.current = {
      key: { prefixLength: stableLen, prefixHash: fnv1a(prefix) },
      nodes: prefixNodes,
      segmentCount: prefixSegments,
    };
  } else {
    // No stable boundary (or source too short) — drop cache, render the
    // whole thing as a single tail block.
    cacheRef.current = null;
    prefixNodes = [];
    prefixLen = 0;
    prefixSegments = 0;
  }

  const tail = source.slice(prefixLen);
  const tailNodes = tail.length > 0 ? renderDocument(tail, prefixSegments) : [];
  const children = prefixNodes.concat(tailNodes);

  return <div className="md-root">{children}</div>;
}

function alignClass(a: Alignment): string {
  return a === 'left' ? 'left' : a === 'right' ? 'right' : 'center';
}

function renderTable(table: ParsedTable, keyPrefix: string): JSX.Element {
  return (
    <div key={`${keyPrefix}-wrap`} className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {table.headers.map((cell, i) => {
              const align = table.alignments[i] ?? 'left';
              return (
                <th
                  key={`${keyPrefix}-th-${i}`}
                  data-align={alignClass(align)}
                >
                  {renderInline(parseInline(cell), `${keyPrefix}-th-${i}`)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={`${keyPrefix}-tr-${ri}`}>
              {row.map((cell, ci) => {
                const align = table.alignments[ci] ?? 'left';
                return (
                  <td
                    key={`${keyPrefix}-td-${ri}-${ci}`}
                    data-align={alignClass(align)}
                  >
                    {renderInline(parseInline(cell), `${keyPrefix}-td-${ri}-${ci}`)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderListItems(items: ListItem[], keyPrefix: string): JSX.Element[] {
  return items.map((it, idx) => {
    const key = `${keyPrefix}-${idx}`;
    return (
      <li key={key} className="md-list-item">
        {renderInline(parseInline(it.text), key)}
        {it.nested !== undefined ? renderList(it.nested, `${key}-n`) : null}
      </li>
    );
  });
}

function renderList(block: ListBlock, keyPrefixOverride?: string): JSX.Element {
  const keyPrefix = keyPrefixOverride ?? block.key;
  const items = renderListItems(block.items, keyPrefix);
  return block.ordered ? (
    <ol key={keyPrefix} className="md-list md-list-ordered">
      {items}
    </ol>
  ) : (
    <ul key={keyPrefix} className="md-list md-list-unordered">
      {items}
    </ul>
  );
}

function renderBlock(b: Block): JSX.Element {
  switch (b.kind) {
    case 'paragraph':
      return (
        <p key={b.key} className="md-paragraph">
          {renderInline(parseInline(b.text), b.key)}
        </p>
      );
    case 'heading': {
      const inner = renderInline(parseInline(b.text), b.key);
      const cls = `md-heading md-heading-${b.level}`;
      switch (b.level) {
        case 1: return <h1 key={b.key} className={cls}>{inner}</h1>;
        case 2: return <h2 key={b.key} className={cls}>{inner}</h2>;
        case 3: return <h3 key={b.key} className={cls}>{inner}</h3>;
        case 4: return <h4 key={b.key} className={cls}>{inner}</h4>;
        case 5: return <h5 key={b.key} className={cls}>{inner}</h5>;
        case 6: return <h6 key={b.key} className={cls}>{inner}</h6>;
      }
      // Unreachable but TS needs the return.
      return <p key={b.key}>{inner}</p>;
    }
    case 'code': {
      // MERMAID-DISPATCH-SECTION (web): route mermaid fences to the SVG renderer.
      if (b.lang !== null && b.lang.toLowerCase().trim() === 'mermaid') {
        return <MermaidBlock key={b.key} code={b.content} />;
      }
      return (
        <SyntaxBlock
          key={b.key}
          language={b.lang}
          code={b.content}
        />
      );
    }
    case 'blockquote':
      return (
        <blockquote key={b.key} className="md-blockquote">
          {renderInline(parseInline(b.text), b.key)}
        </blockquote>
      );
    case 'list':
      return renderList(b);
    case 'hr':
      return <hr key={b.key} className="md-hr" />;
  }
}
