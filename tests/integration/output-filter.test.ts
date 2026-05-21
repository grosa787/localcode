/**
 * Wave 6A2 — output-filter reducer + render-guard regression.
 *
 * Two responsibility surfaces:
 *   1. The reducer's `CYCLE_OUTPUT_FILTER` rotates through the five
 *      documented presets in order (and wraps back). `SET_OUTPUT_FILTER`
 *      writes a normalised triple.
 *   2. The renderer guards (FILTER-RENDER-SECTION markers in
 *      ChatScreen / MessageBlock equivalents) read the slice — we
 *      assert their presence by string match. Bigger UI integration
 *      sits in `tests/ui/reading-mode.test.tsx` (similar style).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  chatReducer,
  initialChatState,
} from '@/integration/chat-state';

const SCREEN = resolve(__dirname, '../../src/ui/screens/ChatScreen.tsx');

describe('output-filter reducer slice', () => {
  test('initial state has every category visible', () => {
    expect(initialChatState.outputFilters).toEqual({
      thinking: true,
      toolCalls: true,
      systemNotes: true,
    });
  });

  test('CYCLE_OUTPUT_FILTER rotates 0 → 1 → 2 → 3 → 0', () => {
    let s = initialChatState;
    // 0 → 1: hide thinking
    s = chatReducer(s, { type: 'CYCLE_OUTPUT_FILTER' });
    expect(s.outputFilters).toEqual({
      thinking: false,
      toolCalls: true,
      systemNotes: true,
    });
    // 1 → 2: hide thinking + tools
    s = chatReducer(s, { type: 'CYCLE_OUTPUT_FILTER' });
    expect(s.outputFilters).toEqual({
      thinking: false,
      toolCalls: false,
      systemNotes: true,
    });
    // 2 → 3: hide everything visible
    s = chatReducer(s, { type: 'CYCLE_OUTPUT_FILTER' });
    expect(s.outputFilters).toEqual({
      thinking: false,
      toolCalls: false,
      systemNotes: false,
    });
    // 3 → 0: back to all-on
    s = chatReducer(s, { type: 'CYCLE_OUTPUT_FILTER' });
    expect(s.outputFilters).toEqual({
      thinking: true,
      toolCalls: true,
      systemNotes: true,
    });
  });

  test('SET_OUTPUT_FILTER writes the explicit triple', () => {
    const s = chatReducer(initialChatState, {
      type: 'SET_OUTPUT_FILTER',
      filters: { thinking: false, toolCalls: true, systemNotes: false },
    });
    expect(s.outputFilters).toEqual({
      thinking: false,
      toolCalls: true,
      systemNotes: false,
    });
  });

  test('SET_OUTPUT_FILTER normalises non-boolean inputs to false', () => {
    const s = chatReducer(initialChatState, {
      type: 'SET_OUTPUT_FILTER',
      // Cast through unknown to feed a deliberately wrong shape — the
      // reducer must coerce.
      filters: {
        thinking: 1 as unknown as boolean,
        toolCalls: undefined as unknown as boolean,
        systemNotes: 'yes' as unknown as boolean,
      },
    });
    expect(s.outputFilters).toEqual({
      thinking: false,
      toolCalls: false,
      systemNotes: false,
    });
  });
});

describe('ChatScreen output-filter render guards', () => {
  const screen = readFileSync(SCREEN, 'utf8');

  test('OUTPUT-FILTER-SECTION markers present', () => {
    expect(screen).toContain('OUTPUT-FILTER-SECTION');
  });

  test('FILTER-RENDER-SECTION markers present', () => {
    expect(screen).toContain('FILTER-RENDER-SECTION');
  });

  test('Shift+H (capital H) wired to onCycleOutputFilter', () => {
    expect(screen).toContain('onCycleOutputFilter');
    expect(screen).toMatch(/input\s*!==\s*'H'/);
  });

  test('Thinking guard reads resolvedFilters.thinking', () => {
    expect(screen).toMatch(/resolvedFilters\.thinking/);
  });

  test('Tool-call branch gated by hideToolCalls', () => {
    expect(screen).toContain('hideToolCalls');
  });
});
