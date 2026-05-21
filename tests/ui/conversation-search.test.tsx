/**
 * Wave 6B — ConversationSearch contract.
 *
 *   1. `findMatches` returns the correct hit list, with offsets that
 *      point at the ORIGINAL content (not the stripped form). Case-
 *      insensitive matching. Empty query → empty result.
 *
 *   2. `stepCursor` cycles through hits in either direction. The
 *      reducer-shaped helper is reused by the n / p keystroke
 *      handlers in ChatScreen.
 *
 *   3. `stripMarkdownLite` removes formatting tokens without touching
 *      content characters.
 *
 *   4. Render contract — hidden by default, shows match counter and
 *      query body when visible.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import ConversationSearch, {
  __test__,
} from '@/ui/overlays/ConversationSearch';
import type { Message } from '@/types/global';

const { findMatches, stepCursor, stripMarkdownLite } = __test__;

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

interface MountResult {
  readonly read: () => string;
  readonly unmount: () => void;
}

function mountSearch(props: {
  readonly visible: boolean;
  readonly query: string;
  readonly totalMatches: number;
  readonly cursorIndex: number;
}): MountResult {
  const buf: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stdout as unknown as { columns: number }).columns = 200;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  const instance = render(React.createElement(ConversationSearch, props), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
  });
  return {
    read: () => stripAnsi(Buffer.concat(buf).toString('utf8')),
    unmount: () => instance.unmount(),
  };
}

function mkMsg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, createdAt: 0 };
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '0';
});

describe('ConversationSearch — pure helpers', () => {
  test('stripMarkdownLite removes backticks/stars/underscores/tildes', () => {
    expect(stripMarkdownLite('`foo`')).toBe('foo');
    expect(stripMarkdownLite('**bold**')).toBe('bold');
    expect(stripMarkdownLite('_em_ ~strike~')).toBe('em strike');
    expect(stripMarkdownLite('```ts\ncode\n```')).toBe('\ncode\n');
    expect(stripMarkdownLite('plain text')).toBe('plain text');
  });

  test('findMatches — case-insensitive plain substring', () => {
    const messages: readonly Message[] = [
      mkMsg('m1', 'user', 'Find FOO in here'),
      mkMsg('m2', 'assistant', 'foo and FOO and Foo'),
      mkMsg('m3', 'user', 'no match'),
    ];
    const hits = findMatches(messages, 'foo');
    expect(hits.length).toBe(4);
    expect(hits[0]?.messageId).toBe('m1');
    expect(hits[1]?.messageId).toBe('m2');
    expect(hits[2]?.messageId).toBe('m2');
    expect(hits[3]?.messageId).toBe('m2');
    // First hit in m1 — original index where "FOO" starts.
    expect(messages[0]?.content.slice(hits[0]?.start ?? 0, hits[0]?.end ?? 0)).toBe(
      'FOO',
    );
  });

  test('findMatches — empty/whitespace query yields no hits', () => {
    const messages: readonly Message[] = [mkMsg('m1', 'user', 'something')];
    expect(findMatches(messages, '')).toEqual([]);
    expect(findMatches(messages, '   ')).toEqual([]);
  });

  test('findMatches — matches through markdown formatting', () => {
    const messages: readonly Message[] = [
      mkMsg('m1', 'assistant', 'use `writeFile` to save it'),
    ];
    const hits = findMatches(messages, 'writeFile');
    expect(hits.length).toBe(1);
    // The original offsets land BETWEEN the backticks, so we should
    // see `writeFile` when sliced from the original content.
    const h = hits[0];
    expect(h).toBeDefined();
    expect(messages[0]?.content.slice(h?.start ?? 0, h?.end ?? 0)).toBe(
      'writeFile',
    );
  });

  test('stepCursor — next cycles forward, prev cycles backward', () => {
    // Empty list — cursor stays at -1.
    expect(stepCursor(-1, 0, 'next')).toBe(-1);
    expect(stepCursor(0, 0, 'prev')).toBe(-1);
    // First step from -1 lands at 0 for next, last index for prev.
    expect(stepCursor(-1, 3, 'next')).toBe(0);
    expect(stepCursor(-1, 3, 'prev')).toBe(2);
    // Cycling.
    expect(stepCursor(0, 3, 'next')).toBe(1);
    expect(stepCursor(2, 3, 'next')).toBe(0);
    expect(stepCursor(0, 3, 'prev')).toBe(2);
    expect(stepCursor(2, 3, 'prev')).toBe(1);
  });
});

describe('ConversationSearch — render contract', () => {
  test('hidden by default — visible=false renders zero bytes', () => {
    const m = mountSearch({
      visible: false,
      query: 'foo',
      totalMatches: 3,
      cursorIndex: 0,
    });
    expect(m.read().trim().length).toBe(0);
    m.unmount();
  });

  test('visible — shows query + counter + hotkey hint', () => {
    const m = mountSearch({
      visible: true,
      query: 'foo',
      totalMatches: 12,
      cursorIndex: 2,
    });
    const out = m.read();
    expect(out).toContain('search:');
    expect(out).toContain('foo');
    // Cursor 2 displays as `3 of 12 matches` (1-based).
    expect(out).toContain('3 of 12 matches');
    expect(out).toContain('n/p');
    expect(out).toContain('Esc');
    m.unmount();
  });

  test('zero matches — counter reads "no matches"', () => {
    const m = mountSearch({
      visible: true,
      query: 'nothing',
      totalMatches: 0,
      cursorIndex: -1,
    });
    const out = m.read();
    expect(out).toContain('no matches');
    m.unmount();
  });
});

describe('ConversationSearch — full n/p cycle', () => {
  // Integration-style: build hits, walk the cursor through n/n/n/p
  // using the helper exactly the way ChatScreen wires it.
  const messages: readonly Message[] = [
    mkMsg('m1', 'user', 'find foo here'),
    mkMsg('m2', 'assistant', 'and another foo, plus a third FOO'),
  ];

  test('next/prev cycle visits every hit and wraps', () => {
    const hits = findMatches(messages, 'foo');
    expect(hits.length).toBe(3);
    let cursor = -1;
    cursor = stepCursor(cursor, hits.length, 'next');
    expect(cursor).toBe(0);
    cursor = stepCursor(cursor, hits.length, 'next');
    expect(cursor).toBe(1);
    cursor = stepCursor(cursor, hits.length, 'next');
    expect(cursor).toBe(2);
    cursor = stepCursor(cursor, hits.length, 'next');
    // Wraps.
    expect(cursor).toBe(0);
    cursor = stepCursor(cursor, hits.length, 'prev');
    expect(cursor).toBe(2);
  });

  test('escape contract — caller is expected to clear query + cursor', () => {
    // The component does not own the keystroke loop — we just verify
    // that re-rendering with visible=false + query='' produces a
    // clean bar (no leftover counter text).
    const m = mountSearch({
      visible: false,
      query: '',
      totalMatches: 0,
      cursorIndex: -1,
    });
    expect(m.read().trim().length).toBe(0);
    m.unmount();
  });
});
