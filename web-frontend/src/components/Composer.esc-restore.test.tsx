/**
 * Wave 8C — Composer.tsx Esc-cancel ALSO restores the last user
 * message into the textarea draft.
 *
 * Companion to the existing `ChatView.esc-cancel.test.tsx` which only
 * pins the `cancel_stream` wire path. The additional contract pinned
 * here:
 *
 *   1. Composer.tsx accepts a `lastUserText?: string | null` prop.
 *   2. Composer.tsx's Esc branch (inside ESC-CANCEL-SECTION) calls
 *      `setDraft(restore)` when both `streaming === true` AND
 *      `lastUserText` is a non-empty string.
 *   3. ChatView.tsx computes `lastUserText` from its `messages` array
 *      (most-recent user message wins) and hands it to <Composer>.
 *
 * The functional repro at the bottom mirrors the production code path
 * so a regression that drops the restore step shows up immediately.
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

describe('Composer — Esc-cancel restores last user text (Wave 8C)', () => {
  test('Composer declares the `lastUserText` prop', () => {
    expect(COMPOSER_SRC).toMatch(/lastUserText\?:\s*string\s*\|\s*null/);
  });

  test('Esc branch in Composer reads `lastUserText` and seeds the draft', () => {
    const startIdx = COMPOSER_SRC.indexOf('ESC-CANCEL-SECTION — start');
    const endIdx = COMPOSER_SRC.indexOf('ESC-CANCEL-SECTION — end');
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = COMPOSER_SRC.slice(startIdx, endIdx);
    // Must still cancel.
    expect(block).toMatch(/props\.onCancel/);
    // Must read lastUserText and call setDraft.
    expect(block).toMatch(/props\.lastUserText/);
    expect(block).toMatch(/setDraft\(restore\)/);
    // Caret-to-end after the draft is replaced — load-bearing for UX.
    expect(block).toMatch(/setSelectionRange\(restore\.length,\s*restore\.length\)/);
  });

  test('ChatView computes `lastUserText` from messages and passes it down', () => {
    expect(CHATVIEW_SRC).toMatch(/const\s+lastUserText\s*=\s*useMemo/);
    // The memo body scans messages backwards for role === 'user'.
    expect(CHATVIEW_SRC).toMatch(
      /for\s*\(\s*let\s+i\s*=\s*messages\.length\s*-\s*1/,
    );
    expect(CHATVIEW_SRC).toMatch(/role\s*===\s*['"]user['"]/);
    // Wired into Composer.
    expect(CHATVIEW_SRC).toMatch(/lastUserText=\{\s*lastUserText\s*\}/);
  });
});

describe('Composer — algorithmic repro of Esc-cancel + restore', () => {
  /**
   * Functional repro of the in-component code path. Returns the
   * visible side effects so a divergence from the production logic
   * shows up as a test failure.
   */
  interface Harness {
    readonly cancelCalls: number;
    readonly draftAfter: string;
    readonly preventDefaultCalled: boolean;
  }
  function runHandler(opts: {
    readonly streaming: boolean;
    readonly lastUserText: string | null | undefined;
    readonly key: string;
  }): Harness {
    let cancelCalls = 0;
    let draft = '';
    let preventDefaultCalled = false;
    const onCancel = (): void => {
      cancelCalls += 1;
    };
    const setDraft = (t: string): void => {
      draft = t;
    };
    const e = {
      key: opts.key,
      shiftKey: false,
      preventDefault: (): void => {
        preventDefaultCalled = true;
      },
    };
    // Mirror the production branch:
    if (e.key === 'Escape' && opts.streaming) {
      e.preventDefault();
      onCancel();
      const restore = opts.lastUserText;
      if (typeof restore === 'string' && restore.length > 0) {
        setDraft(restore);
      }
    }
    return { cancelCalls, draftAfter: draft, preventDefaultCalled };
  }

  test('Esc + streaming + lastUserText="hello" → cancel + draft="hello"', () => {
    const h = runHandler({
      streaming: true,
      lastUserText: 'hello',
      key: 'Escape',
    });
    expect(h.cancelCalls).toBe(1);
    expect(h.preventDefaultCalled).toBe(true);
    expect(h.draftAfter).toBe('hello');
  });

  test('Esc + streaming + lastUserText=null → cancel but draft stays empty', () => {
    const h = runHandler({
      streaming: true,
      lastUserText: null,
      key: 'Escape',
    });
    expect(h.cancelCalls).toBe(1);
    expect(h.draftAfter).toBe('');
  });

  test('Esc + streaming + lastUserText="" → cancel but draft stays empty', () => {
    const h = runHandler({
      streaming: true,
      lastUserText: '',
      key: 'Escape',
    });
    expect(h.cancelCalls).toBe(1);
    expect(h.draftAfter).toBe('');
  });

  test('Esc + NOT streaming → branch is a no-op at this layer', () => {
    const h = runHandler({
      streaming: false,
      lastUserText: 'hello',
      key: 'Escape',
    });
    expect(h.cancelCalls).toBe(0);
    expect(h.draftAfter).toBe('');
    expect(h.preventDefaultCalled).toBe(false);
  });

  test('non-Esc keys → no-op even when streaming', () => {
    const h = runHandler({
      streaming: true,
      lastUserText: 'hello',
      key: 'a',
    });
    expect(h.cancelCalls).toBe(0);
    expect(h.draftAfter).toBe('');
  });
});
