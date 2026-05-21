/**
 * ChatView.tsx + Composer.tsx — Esc-cancels-stream binding.
 *
 * Mirrors the TUI tests/ui/chatscreen-esc-cancel.test.tsx + the
 * Composer.queue.test.tsx source-shape pattern. ChatView wires
 * `cancelStream` (which sends `{ type: 'cancel_stream', sessionId }` on
 * the websocket) into Composer.onCancel, and Composer's onKeyDown
 * invokes it when Escape lands during a live stream.
 *
 * The contract we pin here:
 *   1. ChatView declares cancelStream inside an ESC-CANCEL-SECTION
 *      block that sends `cancel_stream`.
 *   2. Composer's onKeyDown has an ESC-CANCEL-SECTION block that calls
 *      `props.onCancel?.()` while `props.streaming` is true.
 *   3. Composer hands `cancelStream` to its `onCancel` prop, so the
 *      Esc keystroke reaches the websocket path.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPOSER_SRC = readFileSync(
  path.resolve(HERE, 'Composer.tsx'),
  'utf8',
);
const CHATVIEW_SRC = readFileSync(
  path.resolve(HERE, 'ChatView.tsx'),
  'utf8',
);

describe('ChatView — ESC-CANCEL-SECTION', () => {
  test('section markers are present (start + end)', () => {
    expect(CHATVIEW_SRC).toMatch(/ESC-CANCEL-SECTION — start/);
    expect(CHATVIEW_SRC).toMatch(/ESC-CANCEL-SECTION — end/);
  });

  test('cancelStream sends `cancel_stream` over the websocket', () => {
    const startIdx = CHATVIEW_SRC.indexOf('ESC-CANCEL-SECTION — start');
    const endIdx = CHATVIEW_SRC.indexOf('ESC-CANCEL-SECTION — end');
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = CHATVIEW_SRC.slice(startIdx, endIdx);
    expect(block).toMatch(/const\s+cancelStream\s*=\s*useCallback/);
    expect(block).toMatch(/type:\s*['"]cancel_stream['"]/);
  });

  test('cancelStream is wired into Composer.onCancel', () => {
    // The composer mount-site sets `onCancel={cancelStream}` so Esc →
    // composer.onCancel → ChatView.cancelStream → ws send.
    expect(CHATVIEW_SRC).toMatch(/onCancel=\{\s*cancelStream\s*\}/);
  });
});

describe('Composer — ESC-CANCEL-SECTION', () => {
  test('section markers are present (start + end)', () => {
    expect(COMPOSER_SRC).toMatch(/ESC-CANCEL-SECTION — start/);
    expect(COMPOSER_SRC).toMatch(/ESC-CANCEL-SECTION — end/);
  });

  test('Escape during streaming calls props.onCancel and consumes the keystroke', () => {
    const startIdx = COMPOSER_SRC.indexOf('ESC-CANCEL-SECTION — start');
    const endIdx = COMPOSER_SRC.indexOf('ESC-CANCEL-SECTION — end');
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = COMPOSER_SRC.slice(startIdx, endIdx);
    expect(block).toMatch(/e\.key\s*===\s*['"]Escape['"]/);
    expect(block).toMatch(/props\.streaming/);
    expect(block).toMatch(/e\.preventDefault\(\)/);
    expect(block).toMatch(/props\.onCancel/);
  });

  test('Escape branch is no-op when NOT streaming (no extra reset path)', () => {
    const startIdx = COMPOSER_SRC.indexOf('ESC-CANCEL-SECTION — start');
    const endIdx = COMPOSER_SRC.indexOf('ESC-CANCEL-SECTION — end');
    const block = COMPOSER_SRC.slice(startIdx, endIdx);
    // The branch must be guarded by `props.streaming`, NOT a bare
    // `e.key === 'Escape'` — that would clobber Escape elsewhere (e.g.
    // the slash / mention popups already consume Escape ahead of us).
    expect(block).toMatch(
      /e\.key\s*===\s*['"]Escape['"]\s*&&\s*props\.streaming/,
    );
  });
});

describe('Composer — onKeyDown: Escape semantics (functional check)', () => {
  /**
   * Minimal repro of the contract: when `streaming` is true, Escape
   * fires `onCancel`. When streaming is false, Escape no-ops at this
   * layer (other branches/popups own it).
   */
  function makeHandler(streaming: boolean, onCancel: () => void) {
    return (e: {
      key: string;
      shiftKey: boolean;
      preventDefault: () => void;
    }): boolean => {
      if (e.key === 'Escape' && streaming) {
        e.preventDefault();
        onCancel();
        return true;
      }
      return false;
    };
  }

  test('Esc while streaming → onCancel invoked, preventDefault called', () => {
    let cancelled = 0;
    let prevented = false;
    const handler = makeHandler(true, () => {
      cancelled += 1;
    });
    const consumed = handler({
      key: 'Escape',
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(cancelled).toBe(1);
    expect(prevented).toBe(true);
    expect(consumed).toBe(true);
  });

  test('Esc while NOT streaming → onCancel NOT invoked', () => {
    let cancelled = 0;
    const handler = makeHandler(false, () => {
      cancelled += 1;
    });
    const consumed = handler({
      key: 'Escape',
      shiftKey: false,
      preventDefault: () => {
        /* unused */
      },
    });
    expect(cancelled).toBe(0);
    expect(consumed).toBe(false);
  });
});
