/**
 * Wave 6A2 — reading-mode reducer + UI guard regression.
 *
 * We exercise the chat-state reducer's TOGGLE_READING_MODE /
 * SET_READING_MODE actions plus a string-level smoke that the
 * ChatScreen renders the "READING MODE" banner under the corresponding
 * markers. Mounting the full ChatScreen here is unnecessary — the
 * banner test is structural (markers in the JSX) which matches the
 * style of the existing nav-mode tests in this folder.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  chatReducer,
  initialChatState,
} from '@/integration/chat-state';

const SRC = resolve(__dirname, '../../src/ui/screens/ChatScreen.tsx');

describe('reading-mode reducer slice', () => {
  test('defaults to false', () => {
    expect(initialChatState.readingMode).toBe(false);
  });

  test('TOGGLE_READING_MODE flips the slice', () => {
    const s1 = chatReducer(initialChatState, { type: 'TOGGLE_READING_MODE' });
    expect(s1.readingMode).toBe(true);
    const s2 = chatReducer(s1, { type: 'TOGGLE_READING_MODE' });
    expect(s2.readingMode).toBe(false);
  });

  test('SET_READING_MODE writes an explicit value', () => {
    const s1 = chatReducer(initialChatState, {
      type: 'SET_READING_MODE',
      on: true,
    });
    expect(s1.readingMode).toBe(true);
    const s2 = chatReducer(s1, { type: 'SET_READING_MODE', on: false });
    expect(s2.readingMode).toBe(false);
  });
});

describe('ChatScreen reading-mode UI guards', () => {
  const screen = readFileSync(SRC, 'utf8');

  test('READING-MODE-SECTION marker is present', () => {
    expect(screen).toContain('READING-MODE-SECTION');
  });

  test('Banner renders "READING MODE — press F to exit"', () => {
    expect(screen).toContain('READING MODE — press F to exit');
  });

  test('readingMode branch suppresses InputBar', () => {
    // The conditional render shape `{readingMode ? (<banner>) : (...)}`
    // gates the entire composer + agent panel branch.
    expect(screen).toMatch(/\{\s*readingMode\s*\?/);
  });

  test('F (uppercase only) toggles via onToggleReadingMode', () => {
    expect(screen).toContain('onToggleReadingMode');
    // Confirm the explicit F check (we deliberately do NOT bind
    // lowercase 'f' to avoid colliding with the search chord).
    expect(screen).toMatch(/input\s*!==\s*'F'/);
  });
});
