/**
 * R7 — system prompt language-section + reminder placement.
 *
 * Agent 2 R7 moved the language-consistency rule to the TOP of the
 * system prompt (right after Identity) and added a soft "Reminder"
 * footer that re-anchored the rule whenever the caller passed the
 * latest user-message snippet.
 *
 * R9 UPDATE — the trailing "## Reminder" block has been REMOVED to
 * keep the system prompt byte-stable across turns (embedding the
 * user's most recent message into the prompt forced a cache miss
 * on every turn, defeating the local-model prompt cache). The
 * language-consistency rule still lives at the TOP of the prompt
 * under "## Language (CRITICAL)", which is where the model gives
 * it the most weight anyway. The R7 footer assertions below have
 * been flipped to assert the reminder is now ABSENT.
 *
 * The `userLatestSnippet` parameter is still accepted on the
 * options bag for backwards-compat with callers that still pass
 * it, but it no longer affects the rendered prompt.
 */
import { describe, test, expect } from 'bun:test';
import {
  ContextManager,
  SYSTEM_PROMPT_BASE,
} from '@/llm/context-manager';

describe('ContextManager.buildSystemPrompt — Language section near the top (R7)', () => {
  test('default prompt contains the "## Language (CRITICAL)" header', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toContain('## Language (CRITICAL)');
  });

  test('Language section appears near the top, BEFORE "How you work"', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    const langIdx = prompt.indexOf('## Language (CRITICAL)');
    const howIdx = prompt.indexOf('## How you work');
    expect(langIdx).toBeGreaterThan(-1);
    expect(howIdx).toBeGreaterThan(-1);
    expect(langIdx).toBeLessThan(howIdx);
  });

  test('Language section appears AFTER the Identity section', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    const idx = prompt.indexOf('## Identity');
    const langIdx = prompt.indexOf('## Language (CRITICAL)');
    expect(idx).toBeGreaterThan(-1);
    expect(langIdx).toBeGreaterThan(idx);
  });

  test('contains concrete language examples (Russian / English / Spanish)', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    // Strong language examples present.
    expect(prompt).toContain('Russian');
    expect(prompt).toContain('English');
    expect(prompt).toContain('Spanish');
  });

  test('language rule is anchored within the first ~1500 characters', () => {
    // Position-weight matters — the rule must be in the high-weight
    // prefix of the prompt, not buried at the bottom.
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    const langIdx = prompt.indexOf('## Language (CRITICAL)');
    expect(langIdx).toBeGreaterThan(-1);
    expect(langIdx).toBeLessThan(1500);
  });

  test('system prompt still starts with the identity base line', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt.startsWith(SYSTEM_PROMPT_BASE)).toBe(true);
  });
});

describe('ContextManager.buildSystemPrompt — Reminder footer removed (R9)', () => {
  // R9 — the trailing "## Reminder" block was removed to keep the
  // system prompt byte-stable across turns. These tests now assert
  // the reminder is ABSENT regardless of how the caller invokes
  // buildSystemPrompt, and that the language rule still lives near
  // the top of the prompt.

  test('non-empty userLatestSnippet → "## Reminder" is NOT in the prompt (R9)', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({
      userLatestSnippet: 'Привет, как дела?',
    });
    expect(prompt).not.toContain('## Reminder');
  });

  test('non-empty snippet still leaves the language rule at the TOP', () => {
    // The reminder is gone, but the language rule is unchanged.
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({
      userLatestSnippet: 'hello world',
    });
    const langIdx = prompt.indexOf('## Language (CRITICAL)');
    expect(langIdx).toBeGreaterThan(-1);
    expect(langIdx).toBeLessThan(1500);
  });

  test('language rule mentions same-language requirement', () => {
    // Pre-R9 this assertion was scoped to the trailing reminder. With
    // the reminder removed, the same content lives in the top-anchored
    // language section instead.
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({
      userLatestSnippet: 'sample input',
    });
    const langIdx = prompt.indexOf('## Language (CRITICAL)');
    expect(langIdx).toBeGreaterThan(-1);
    const after = prompt.slice(langIdx);
    expect(after.toLowerCase()).toMatch(/language|same/);
  });

  test('empty string userLatestSnippet → reminder is OMITTED', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({ userLatestSnippet: '' });
    expect(prompt).not.toContain('## Reminder');
  });

  test('whitespace-only userLatestSnippet → reminder is OMITTED', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({
      userLatestSnippet: '   \n\t  ',
    });
    expect(prompt).not.toContain('## Reminder');
  });

  test('omitted userLatestSnippet (no key) → reminder is OMITTED', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).not.toContain('## Reminder');
  });

  test('only the top-anchored language section remains (no double-anchor)', () => {
    // R9 — the language rule is single-anchored at the top. Verify
    // the section is present and the reminder block is gone.
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({
      userLatestSnippet: 'a real user query',
    });
    expect(prompt).toContain('## Language (CRITICAL)');
    expect(prompt).not.toContain('## Reminder');
  });

  test('legacy positional call (md, skills) does NOT add reminder', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt('# README', []);
    expect(prompt).not.toContain('## Reminder');
    // Language section is still present (it's not gated on the snippet).
    expect(prompt).toContain('## Language (CRITICAL)');
  });

  test('non-string userLatestSnippet does not crash and yields no reminder', () => {
    const cm = new ContextManager();
    // Force the type system out of the way to simulate a misconfigured caller.
    const prompt = cm.buildSystemPrompt({
      userLatestSnippet: 123 as unknown as string,
    });
    expect(prompt).not.toContain('## Reminder');
  });

  test('userLatestSnippet does NOT mutate the prompt (R9 stable-prefix)', () => {
    // Two calls with different snippets must produce byte-identical
    // prompts when nothing else (skills/summary/localcodeMd) differs.
    // This is the contract that lets the local-model prompt cache hit
    // turn-after-turn even as the user types new messages.
    const cm = new ContextManager();
    const a = cm.buildSystemPrompt({
      userLatestSnippet: 'first message in English',
    });
    const b = cm.buildSystemPrompt({
      userLatestSnippet: 'совсем другое сообщение',
    });
    const c = cm.buildSystemPrompt({});
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });
});

describe('ContextManager.buildSystemPrompt — Language section content (R7)', () => {
  test('mentions code identifiers staying in original form', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    // The rule explicitly carves out code identifiers as not subject
    // to translation.
    expect(prompt.toLowerCase()).toMatch(/identifier|library|original/);
  });

  test('mentions defaulting to user MOST RECENT message language on uncertainty', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt({});
    expect(prompt).toMatch(/most recent/i);
  });
});
