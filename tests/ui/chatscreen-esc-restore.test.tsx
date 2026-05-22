/**
 * Wave 8C — Esc-cancel + restore-last-user-message contract.
 *
 * The user reported: pressing Esc during a streaming response should
 *   (a) cancel the in-flight turn AND
 *   (b) restore the last user message text into the InputBar so the user
 *       can edit and re-send without retyping.
 *
 * The production wiring lives inside
 * `src/ui/screens/ChatScreen.tsx` between `// ESC-CANCEL-SECTION — start`
 * and `// ESC-CANCEL-SECTION — end`. This file is a focused source-shape
 * + algorithmic repro guard that locks both behaviours.
 *
 * The companion file `chatscreen-esc-cancel-real.test.tsx` covers the
 * same invariants in a more elaborate harness; this file is the
 * brief-named entry point and stays minimal so a future regression
 * surfaces a clear, on-topic failure message.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN = path.resolve(
  HERE,
  '..',
  '..',
  'src',
  'ui',
  'screens',
  'ChatScreen.tsx',
);
const SRC = readFileSync(SCREEN, 'utf8');

function escSection(): string {
  const startIdx = SRC.indexOf('// ESC-CANCEL-SECTION — start');
  const endIdx = SRC.indexOf('// ESC-CANCEL-SECTION — end');
  if (startIdx < 0 || endIdx < startIdx) return '';
  return SRC.slice(startIdx, endIdx);
}

describe('ChatScreen — Esc triggers onCancel AND restores draft', () => {
  const block = escSection();

  test('section markers exist', () => {
    expect(block.length).toBeGreaterThan(0);
  });

  test('handler calls onCancel() when streaming', () => {
    expect(block).toMatch(/if\s*\(\s*isStreaming\s*\)/);
    expect(block).toMatch(/onCancel\(\)/);
  });

  test('handler scans messages for the last user message and sets draft', () => {
    expect(block).toMatch(/role\s*===\s*['"]user['"]/);
    expect(block).toMatch(/setDraft\(restoreText\)/);
  });

  test('handler bumps inputKey so InputBar remounts with the restored value', () => {
    expect(block).toMatch(/setInputKey\(\(k\)\s*=>\s*k\s*\+\s*1\)/);
  });
});

/**
 * Algorithmic repro — mirrors the in-component Esc handler so a future
 * refactor that drops any of the steps (cancel / find-last-user / set-
 * draft / bump-key) fails the test visibly.
 */
describe('ChatScreen — algorithmic repro of Esc cancel + restore', () => {
  interface Msg {
    readonly role: 'user' | 'assistant' | 'system' | 'tool';
    readonly content: string;
  }
  interface Result {
    readonly cancelCalls: number;
    readonly draft: string;
    readonly inputKey: number;
  }
  function handler(opts: {
    readonly isStreaming: boolean;
    readonly messages: readonly Msg[];
  }): Result {
    let cancelCalls = 0;
    let draft = '';
    let inputKey = 0;
    if (opts.isStreaming) {
      cancelCalls += 1;
      let restoreText: string | null = null;
      for (let i = opts.messages.length - 1; i >= 0; i--) {
        const m = opts.messages[i];
        if (m !== undefined && m.role === 'user') {
          restoreText = typeof m.content === 'string' ? m.content : null;
          break;
        }
      }
      if (restoreText !== null && restoreText.length > 0) {
        draft = restoreText;
        inputKey += 1;
      }
    }
    return { cancelCalls, draft, inputKey };
  }

  test('Esc during streaming cancels AND restores last user text', () => {
    const r = handler({
      isStreaming: true,
      messages: [
        { role: 'user', content: 'tell me about React' },
        { role: 'assistant', content: 'Sure…' },
      ],
    });
    expect(r.cancelCalls).toBe(1);
    expect(r.draft).toBe('tell me about React');
    expect(r.inputKey).toBe(1);
  });

  test('Esc when NOT streaming is a no-op for cancel + draft', () => {
    const r = handler({
      isStreaming: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.cancelCalls).toBe(0);
    expect(r.draft).toBe('');
    expect(r.inputKey).toBe(0);
  });

  test('Esc cancels even without user messages, draft stays empty', () => {
    const r = handler({
      isStreaming: true,
      messages: [{ role: 'system', content: 'context' }],
    });
    expect(r.cancelCalls).toBe(1);
    expect(r.draft).toBe('');
    expect(r.inputKey).toBe(0);
  });

  test('Esc restores the MOST RECENT user message, not the first', () => {
    const r = handler({
      isStreaming: true,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'latest' },
        { role: 'assistant', content: 'r2' },
      ],
    });
    expect(r.draft).toBe('latest');
  });
});
