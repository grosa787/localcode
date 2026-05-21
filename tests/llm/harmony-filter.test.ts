/**
 * Tests for `HarmonyFilter` — the stateful stripper that removes
 * `<|channel|>…<|message|>` control tokens and standalone Harmony tokens
 * from the LLM's text stream across arbitrary chunk boundaries.
 */
import { describe, test, expect } from 'bun:test';
import { HarmonyFilter } from '@/llm/streaming';

describe('HarmonyFilter — plain text passthrough', () => {
  test('empty push returns empty output', () => {
    const f = new HarmonyFilter();
    expect(f.push('')).toBe('');
  });

  test('emits plain text unchanged in one go', () => {
    const f = new HarmonyFilter();
    // Text must be long enough to escape the prefix-buffering guard.
    const out = f.push('hello world, this is ordinary streamed text');
    expect(out).toBe('hello world, this is ordinary streamed text');
    expect(f.flush()).toBe('');
  });

  test('flush releases any held tail at stream end', () => {
    const f = new HarmonyFilter();
    // A trailing `<` could still become a control token prefix so the
    // filter holds it back. `flush()` must release it.
    const emitted = f.push('trailing <');
    const tail = f.flush();
    expect(emitted + tail).toBe('trailing <');
  });
});

describe('HarmonyFilter — standalone token removal', () => {
  test('drops `<|start|>` in the middle of text', () => {
    const f = new HarmonyFilter();
    const out = f.push('before<|start|>after_text_with_more_length');
    const final = f.flush();
    expect(out + final).toBe('beforeafter_text_with_more_length');
  });

  test('drops `<|end|>` token', () => {
    const f = new HarmonyFilter();
    const out = f.push('done<|end|>now_padding_padding_padding');
    const final = f.flush();
    expect(out + final).toBe('donenow_padding_padding_padding');
  });

  test('drops `<|return|>` token', () => {
    const f = new HarmonyFilter();
    const out = f.push('A<|return|>B_plus_lots_of_filler_ABC');
    const final = f.flush();
    expect(out + final).toBe('AB_plus_lots_of_filler_ABC');
  });

  test('drops multiple standalone tokens in one chunk', () => {
    const f = new HarmonyFilter();
    const out = f.push('a<|start|>b<|end|>c_plus_more_tail_text_filler');
    const final = f.flush();
    expect(out + final).toBe('abc_plus_more_tail_text_filler');
  });
});

describe('HarmonyFilter — `<|channel|>…<|message|>` block removal', () => {
  test('drops the entire channel-block including tokens', () => {
    const f = new HarmonyFilter();
    const input =
      'pre<|channel|>analysis<|message|>actual_body_and_more_text_here';
    const out = f.push(input);
    const final = f.flush();
    expect(out + final).toBe('preactual_body_and_more_text_here');
  });

  test('supports multiple channel blocks in a single chunk', () => {
    const f = new HarmonyFilter();
    const input =
      'a<|channel|>c1<|message|>b<|channel|>c2<|message|>tail_padding_padding';
    const out = f.push(input);
    const final = f.flush();
    expect(out + final).toBe('abtail_padding_padding');
  });
});

describe('HarmonyFilter — split-across-chunks resilience', () => {
  test('token split across two pushes is still stripped', () => {
    const f = new HarmonyFilter();
    const out1 = f.push('prefix<|sta');
    const out2 = f.push('rt|>suffix_with_extra_padding_here');
    const final = f.flush();
    expect(out1 + out2 + final).toBe('prefixsuffix_with_extra_padding_here');
  });

  test('channel open split across chunks', () => {
    const f = new HarmonyFilter();
    const out1 = f.push('aa<|chan');
    const out2 = f.push('nel|>nm<|message|>bb_plus_more_padding_text_here');
    const final = f.flush();
    expect(out1 + out2 + final).toBe('aabb_plus_more_padding_text_here');
  });

  test('message-close split across chunks', () => {
    const f = new HarmonyFilter();
    const out1 = f.push('x<|channel|>nm<|mess');
    const out2 = f.push('age|>y_with_extra_padding_for_length');
    const final = f.flush();
    expect(out1 + out2 + final).toBe('xy_with_extra_padding_for_length');
  });

  test('token split into three tiny chunks still stripped', () => {
    const f = new HarmonyFilter();
    const a = f.push('head<|');
    const b = f.push('sta');
    const c = f.push('rt|>tail_padding_padding_padding_padding');
    const final = f.flush();
    expect(a + b + c + final).toBe('headtail_padding_padding_padding_padding');
  });
});

describe('HarmonyFilter — flush semantics', () => {
  test('flush with unmatched channel open emits buffered text (bail out)', () => {
    const f = new HarmonyFilter();
    const out1 = f.push('pre<|channel|>something_without_message_close');
    const final = f.flush();
    // Stream ended inside an unmatched channel block — bail out and
    // surface what was buffered so we never silently lose real output.
    expect((out1 + final)).toContain('pre');
    // The raw `something_without_message_close` text should survive
    // (the close marker never came).
    expect(out1 + final).toContain('something_without_message_close');
  });

  test('flush on empty filter returns empty string', () => {
    const f = new HarmonyFilter();
    expect(f.flush()).toBe('');
  });

  test('reset() restores to clean state', () => {
    const f = new HarmonyFilter();
    f.push('midway<|');
    f.reset();
    const out = f.push('fresh_run_with_enough_padding_to_pass_the_guard');
    expect(out).toBe('fresh_run_with_enough_padding_to_pass_the_guard');
  });
});
