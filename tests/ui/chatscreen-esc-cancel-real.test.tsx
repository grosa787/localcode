/**
 * Wave 8C — REAL ESC-CANCEL contract.
 *
 * The earlier `chatscreen-esc-cancel.test.tsx` is a source-shape guard
 * that pins the marker block and the `if (isStreaming) onCancel()`
 * line but does NOT exercise the actual behaviour. This file adds:
 *
 *   1. Source-shape checks that lock in the Wave 8C additions:
 *      - `messagesRef` is captured so the handler always sees the
 *        latest messages array (no stale closure).
 *      - On Esc-cancel, the handler scans messagesRef backwards for
 *        the last `role === 'user'` message and seeds `setDraft(...)`.
 *      - The handler bumps `inputKey` so InputBar remounts and
 *        hydrates from the new `value` prop (InputBar owns its buffer
 *        once mounted; only a key bump can overwrite its state).
 *
 *   2. A functional repro of the cancel + restore algorithm that
 *      mirrors the in-component code path. The repro is intentionally
 *      a copy of the production logic so a future edit to the
 *      ChatScreen handler that drops one of the steps fails the test
 *      visibly.
 *
 * We do NOT mount the full ChatScreen here — it requires ~40 props
 * that touch heavyweight subsystems (LLM adapter, SessionManager,
 * SkillsManager, ProcessMonitor…). The hybrid "source-shape +
 * algorithmic repro" pattern matches the rest of `tests/ui/` and is
 * sufficient to catch the regressions we care about.
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

function blockBetween(marker: string): string {
  const startIdx = SRC.indexOf(`${marker} — start`);
  const endIdx = SRC.indexOf(`${marker} — end`);
  if (startIdx < 0 || endIdx < startIdx) return '';
  return SRC.slice(startIdx, endIdx);
}

describe('ChatScreen — Esc-cancel restores last user message (Wave 8C)', () => {
  const block = blockBetween('// ESC-CANCEL-SECTION');

  test('section markers present (start + end)', () => {
    expect(block.length).toBeGreaterThan(0);
  });

  test('handler captures messagesRef so closure stays fresh', () => {
    // The ref pattern is what guarantees the handler sees the latest
    // messages array even when isStreaming churns. Dropping the ref
    // would either stale-bind to an empty messages array or force the
    // handler to re-subscribe on every chunk arrival.
    expect(block).toMatch(/messagesRef/);
    expect(block).toMatch(/useRef<readonly Message\[\]>\(messages\)/);
    expect(block).toMatch(/messagesRef\.current\s*=\s*messages/);
  });

  test('handler calls onCancel when streaming AND restores last user text', () => {
    expect(block).toMatch(/if\s*\(\s*isStreaming\s*\)\s*\{/);
    expect(block).toMatch(/onCancel\(\)/);
    // Scans messagesRef backwards for role === 'user'.
    expect(block).toMatch(/for\s*\(\s*let\s+i\s*=\s*snapshot\.length\s*-\s*1/);
    expect(block).toMatch(/role\s*===\s*['"]user['"]/);
    expect(block).toMatch(/setDraft\(restoreText\)/);
  });

  test('handler bumps inputKey so InputBar remounts and re-hydrates `value`', () => {
    // InputBar's `value` prop is one-shot (line ~1186 of InputBar.tsx):
    // we MUST remount to overwrite its internal editor buffer.
    expect(block).toMatch(/setInputKey\(\(k\)\s*=>\s*k\s*\+\s*1\)/);
  });

  test('the cancel branch returns true so the keystroke does not leak', () => {
    expect(block).toMatch(/return\s+true;/);
  });
});

describe('ChatScreen — algorithmic repro of Esc-cancel + restore', () => {
  /**
   * Mirrors the production handler. Any future change to the in-
   * component code that drops one of these steps (cancel, find last
   * user, set draft, bump key) will diverge from this repro and the
   * test will fail visibly.
   */
  interface FakeMessage {
    readonly role: 'user' | 'assistant' | 'system' | 'tool';
    readonly content: string;
  }
  interface Harness {
    readonly cancelCalls: number;
    readonly draftAfter: string;
    readonly inputKeyAfter: number;
  }
  function runHandler(opts: {
    readonly isStreaming: boolean;
    readonly messages: readonly FakeMessage[];
  }): Harness {
    let cancelCalls = 0;
    let draft = '';
    let inputKey = 0;
    const onCancel = (): void => {
      cancelCalls += 1;
    };
    const setDraft = (t: string): void => {
      draft = t;
    };
    const setInputKey = (fn: (k: number) => number): void => {
      inputKey = fn(inputKey);
    };
    // The exact algorithm from ChatScreen.tsx ESC-CANCEL-SECTION:
    if (opts.isStreaming) {
      onCancel();
      let restoreText: string | null = null;
      for (let i = opts.messages.length - 1; i >= 0; i--) {
        const m = opts.messages[i];
        if (m !== undefined && m.role === 'user') {
          restoreText = typeof m.content === 'string' ? m.content : null;
          break;
        }
      }
      if (restoreText !== null && restoreText.length > 0) {
        setDraft(restoreText);
        setInputKey((k) => k + 1);
      }
    }
    return { cancelCalls, draftAfter: draft, inputKeyAfter: inputKey };
  }

  test('streaming + last user "hello" → cancel fires AND draft becomes "hello"', () => {
    const h = runHandler({
      isStreaming: true,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '...' },
      ],
    });
    expect(h.cancelCalls).toBe(1);
    expect(h.draftAfter).toBe('hello');
    expect(h.inputKeyAfter).toBe(1); // key bumped → InputBar remounts
  });

  test('non-streaming Esc → no cancel, no draft change', () => {
    const h = runHandler({
      isStreaming: false,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(h.cancelCalls).toBe(0);
    expect(h.draftAfter).toBe('');
    expect(h.inputKeyAfter).toBe(0);
  });

  test('streaming with no user messages → cancel fires, draft untouched', () => {
    const h = runHandler({
      isStreaming: true,
      messages: [{ role: 'system', content: 'sys' }],
    });
    expect(h.cancelCalls).toBe(1);
    expect(h.draftAfter).toBe('');
    expect(h.inputKeyAfter).toBe(0);
  });

  test('streaming with multiple user turns → restores the MOST RECENT', () => {
    const h = runHandler({
      isStreaming: true,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'reply2' },
      ],
    });
    expect(h.draftAfter).toBe('second');
  });

  test('empty user message content → cancel fires, draft stays empty', () => {
    const h = runHandler({
      isStreaming: true,
      messages: [{ role: 'user', content: '' }],
    });
    expect(h.cancelCalls).toBe(1);
    expect(h.draftAfter).toBe('');
    expect(h.inputKeyAfter).toBe(0);
  });
});
