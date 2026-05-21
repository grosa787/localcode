/**
 * R6 — `HarmonyFilter` asymmetric pipe-variant handling.
 *
 * The Harmony / GPT-OSS family of models leak control tokens in four
 * distinct shapes:
 *   1. Canonical paired:        `<|channel|>thought<|message|>body`
 *   2. Asymmetric (close-only): `<|channel>thought` + optional content
 *   3. Asymmetric (open-only):  `<channel|>final` + optional content
 *   4. Both pipes missing:      `<channel>thought` + optional content
 *
 * Agent 2 R6 generalised the filter so all four are stripped, including
 * the immediately-following channel-label keyword (`thought`, `final`,
 * `analysis`, `commentary`, `to=...`).
 *
 * These tests verify the asymmetric variants alongside split-across-chunks
 * resilience, and confirm legitimate `<` characters (e.g. `< 5`) survive
 * untouched.
 */
import { describe, test, expect } from 'bun:test';
import { HarmonyFilter } from '@/llm/streaming';

describe('HarmonyFilter — asymmetric pipe variants (R6)', () => {
  test('strips `<|channel>thought` (close-only pipe)', () => {
    const f = new HarmonyFilter();
    const out = f.push('hello <|channel>thought world_with_extra_padding');
    const tail = f.flush();
    // The opening token + the immediately-following `thought` label must
    // both be stripped. Whitespace before/after is preserved.
    expect(out + tail).toBe('hello  world_with_extra_padding');
  });

  test('strips `<channel|>final` (open-only pipe)', () => {
    const f = new HarmonyFilter();
    const out = f.push('hello <channel|>final world_with_extra_padding');
    const tail = f.flush();
    expect(out + tail).toBe('hello  world_with_extra_padding');
  });

  test('strips `<channel>thought` (both pipes missing)', () => {
    const f = new HarmonyFilter();
    const out = f.push('hello <channel>thought world_with_extra_padding');
    const tail = f.flush();
    expect(out + tail).toBe('hello  world_with_extra_padding');
  });

  test('canonical paired `<|channel|>thought<|message|>` still works', () => {
    const f = new HarmonyFilter();
    const out = f.push(
      'pre<|channel|>thought<|message|>body_text_with_padding_for_length',
    );
    const tail = f.flush();
    expect(out + tail).toBe('prebody_text_with_padding_for_length');
  });

  test('two adjacent asymmetric leakage shapes both stripped', () => {
    // The user-reported pattern from the screenshot — two channel-tag
    // shapes back-to-back with labels.
    const f = new HarmonyFilter();
    const out = f.push(
      'answer is <|channel>thought<channel|>final ready',
    );
    const tail = f.flush();
    // Both tokens + their labels are stripped; surrounding whitespace
    // is preserved.
    expect(out + tail).toBe('answer is  ready');
  });

  test('asymmetric `<|channel>` followed by `to=...` recipient', () => {
    // The `to=<recipient>` form is the Harmony tool-routing syntax.
    const f = new HarmonyFilter();
    const out = f.push('A <|channel>to=tool_name body_continues_here_padding');
    const tail = f.flush();
    expect(out + tail).toBe('A  body_continues_here_padding');
  });

  test('asymmetric `<channel|>` followed by `analysis` label', () => {
    const f = new HarmonyFilter();
    const out = f.push('X <channel|>analysis tail_padding_padding_padding');
    const tail = f.flush();
    expect(out + tail).toBe('X  tail_padding_padding_padding');
  });

  test('asymmetric `<channel>` followed by `commentary` label', () => {
    const f = new HarmonyFilter();
    const out = f.push('Y <channel>commentary tail_padding_padding_padding');
    const tail = f.flush();
    expect(out + tail).toBe('Y  tail_padding_padding_padding');
  });
});

describe('HarmonyFilter — split-across-chunks for asymmetric variants (R6)', () => {
  test('asymmetric `<|channel>` split between two chunks', () => {
    const f = new HarmonyFilter();
    const a = f.push('pre<|chan');
    const b = f.push('nel>thought tail_padding_padding_padding_padding');
    const tail = f.flush();
    expect(a + b + tail).toBe('pre tail_padding_padding_padding_padding');
  });

  test('asymmetric `<channel|>` split mid-keyword', () => {
    const f = new HarmonyFilter();
    const a = f.push('xx<chan');
    const b = f.push('nel|>final tail_padding_padding_padding_padding');
    const tail = f.flush();
    expect(a + b + tail).toBe('xx tail_padding_padding_padding_padding');
  });

  test('asymmetric `<channel>` split at the closing `>`', () => {
    const f = new HarmonyFilter();
    const a = f.push('zz<channel');
    const b = f.push('>thought tail_padding_padding_padding_padding');
    const tail = f.flush();
    expect(a + b + tail).toBe('zz tail_padding_padding_padding_padding');
  });

  test('label split across chunks after asymmetric token', () => {
    // Token arrives complete in chunk 1; label `final` arrives split
    // across chunk 2 + 3.
    const f = new HarmonyFilter();
    const a = f.push('q<|channel>fi');
    const b = f.push('nal padding_padding_padding_padding_padding');
    const tail = f.flush();
    expect(a + b + tail).toBe('q padding_padding_padding_padding_padding');
  });

  test('three-chunk split of asymmetric pipe', () => {
    const f = new HarmonyFilter();
    const a = f.push('p<');
    const b = f.push('chan');
    const c = f.push('nel>thought rest_padding_padding_padding_padding');
    const tail = f.flush();
    expect(a + b + c + tail).toBe('p rest_padding_padding_padding_padding');
  });
});

describe('HarmonyFilter — legitimate `<` preservation (R6)', () => {
  test('plain `<` followed by space and number is kept', () => {
    const f = new HarmonyFilter();
    // The buffer is long enough to escape the prefix-buffering guard.
    const out = f.push('here is < 5 elements_in_total_for_padding');
    const tail = f.flush();
    expect(out + tail).toBe('here is < 5 elements_in_total_for_padding');
  });

  test('plain `<` followed by HTML-like tag is kept (not a Harmony keyword)', () => {
    const f = new HarmonyFilter();
    const out = f.push('inline <div>hello</div> and_more_padding_text');
    const tail = f.flush();
    expect(out + tail).toBe('inline <div>hello</div> and_more_padding_text');
  });

  test('multiple `<` characters mixed with text survive', () => {
    const f = new HarmonyFilter();
    const out = f.push('a < b < c < d_padding_padding_padding_padding');
    const tail = f.flush();
    expect(out + tail).toBe('a < b < c < d_padding_padding_padding_padding');
  });

  test('`<x>` is preserved (not a Harmony keyword)', () => {
    const f = new HarmonyFilter();
    const out = f.push('placeholder <x> stays_intact_padding_padding_padding');
    const tail = f.flush();
    expect(out + tail).toBe('placeholder <x> stays_intact_padding_padding_padding');
  });

  test('`<channels>` (plural — not a Harmony keyword) is preserved', () => {
    // `channels` (with trailing s) is NOT a Harmony keyword. The filter
    // only strips the exact keyword set; `channels` should pass through.
    const f = new HarmonyFilter();
    const out = f.push('see <channels> for_more_info_padding_padding_padding');
    const tail = f.flush();
    expect(out + tail).toBe('see <channels> for_more_info_padding_padding_padding');
  });

  test('mixed legitimate `<` and Harmony token in one chunk', () => {
    const f = new HarmonyFilter();
    const out = f.push('compare a < b then <|start|>after_padding_padding_padding');
    const tail = f.flush();
    expect(out + tail).toBe('compare a < b then after_padding_padding_padding');
  });

  test('trailing `<` is buffered and released by flush', () => {
    const f = new HarmonyFilter();
    const out = f.push('value: ');
    const out2 = f.push('<');
    const tail = f.flush();
    expect(out + out2 + tail).toBe('value: <');
  });
});

describe('HarmonyFilter — asymmetric variants combined with paired (R6)', () => {
  test('paired form followed by asymmetric form', () => {
    const f = new HarmonyFilter();
    const out = f.push(
      'A<|channel|>note<|message|>middle <|channel>thought tail_padding_padding',
    );
    const tail = f.flush();
    expect(out + tail).toBe('Amiddle  tail_padding_padding');
  });

  test('asymmetric form followed by paired form', () => {
    const f = new HarmonyFilter();
    const out = f.push(
      'Z <channel|>final mid<|channel|>n<|message|>end_padding_padding_padding',
    );
    const tail = f.flush();
    // After stripping `<channel|>final` → `Z  ` (preserves both spaces:
    // the one between `Z` and the token, plus the one after `final`).
    // Then `<|channel|>n<|message|>` is removed in full → `Z  midend...`.
    expect(out + tail).toBe('Z  midend_padding_padding_padding');
  });
});
