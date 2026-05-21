/**
 * Suggested follow-ups — tests the pure `generateFollowUps` heuristic
 * that ChatScreen feeds into <SuggestedFollowUps>. Mounting the full
 * screen for an Alt+1 keystroke would force us to fake ~40 services;
 * the source-shape guard in `chatscreen-wave6b-wireup.test.ts`
 * already pins the hotkey wiring.
 */

import { describe, test, expect } from 'bun:test';
import { generateFollowUps, FOLLOW_UP_HINT_KEYS } from '@/ui/components/SuggestedFollowUps';

describe('generateFollowUps', () => {
  test('returns [] for an empty assistant message', () => {
    expect(generateFollowUps('').length).toBe(0);
    expect(generateFollowUps('   ').length).toBe(0);
  });

  test('caps at three suggestions', () => {
    const message = '```ts\nfunction foo() {}\nfunction bar() {}\nfunction baz() {}\n```';
    const out = generateFollowUps(message);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  test('surfaces an identifier when the model emitted code', () => {
    const out = generateFollowUps('```ts\nfunction parseConfig(s: string) {}\n```');
    expect(out[0]?.label).toContain('parseConfig');
    expect(out[0]?.payload.toLowerCase()).toContain('parseconfig');
  });

  test('always fills slots with the Continue fallback', () => {
    const out = generateFollowUps('plain prose, no code, nothing fancy');
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.some((s) => s.label === 'Continue')).toBe(true);
  });

  test('detects TODO comments in fenced code blocks', () => {
    // No function-call identifiers in the snippet, so the TODO layer
    // gets first dibs on the slots (identifier layer is priority 1
    // but yields slots when it has no candidates).
    const out = generateFollowUps(
      '```ts\n// TODO: handle the empty case\nconst x = 1;\n```',
    );
    const hasTodoSuggestion = out.some((s) =>
      s.label.toLowerCase().startsWith('fix the todo'),
    );
    expect(hasTodoSuggestion).toBe(true);
  });
});

describe('SuggestedFollowUps hotkey contract', () => {
  test('exports the Alt+N hint keys in lockstep with the render', () => {
    // The render label and the hotkey wiring share this constant.
    expect(FOLLOW_UP_HINT_KEYS).toEqual(['Alt+1', 'Alt+2', 'Alt+3']);
  });
});
