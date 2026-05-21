/**
 * `renderStatusline` substitutes recognised `{placeholder}` tokens with
 * their values, leaves unknown tokens untouched, and renders missing
 * values as empty strings.
 */

import { describe, expect, test } from 'bun:test';
import {
  PLACEHOLDER_NAMES,
  renderStatusline,
} from '@/ui/statusline-template';

describe('renderStatusline', () => {
  test('empty template returns empty string', () => {
    expect(renderStatusline('', {})).toBe('');
  });

  test('template with no placeholders is returned verbatim', () => {
    expect(renderStatusline('static line', {})).toBe('static line');
  });

  test('substitutes recognised placeholders', () => {
    const out = renderStatusline(
      '{provider} · {model} · {tokens}/{maxTokens} ({pct}%)',
      {
        provider: 'openai',
        model: 'gpt-4o',
        tokens: 1234,
        maxTokens: 200000,
        pct: 12,
      },
    );
    expect(out).toBe('openai · gpt-4o · 1234/200000 (12%)');
  });

  test('missing recognised placeholder renders as empty string', () => {
    // model is recognised but vars omits it.
    const out = renderStatusline('[{model}] {tokens}', { tokens: 100 });
    expect(out).toBe('[] 100');
  });

  test('unknown placeholder is left untouched', () => {
    const out = renderStatusline('{foo} {model}', { model: 'gpt-4o' });
    expect(out).toBe('{foo} gpt-4o');
  });

  test('non-finite or negative numeric value renders as empty', () => {
    const out = renderStatusline('{tokens}|{pct}', {
      tokens: Number.POSITIVE_INFINITY,
      pct: -5,
    });
    expect(out).toBe('|');
  });

  test('adjacent placeholders are substituted independently', () => {
    const out = renderStatusline('{provider}{model}', {
      provider: 'a',
      model: 'b',
    });
    expect(out).toBe('ab');
  });

  test('PLACEHOLDER_NAMES contains every documented placeholder', () => {
    expect(PLACEHOLDER_NAMES).toEqual(
      expect.arrayContaining([
        'model',
        'tokens',
        'maxTokens',
        'pct',
        'cachedTokens',
        'cost',
        'profile',
        'provider',
        'sessionId',
        'branch',
        'cwd',
      ]),
    );
  });
});
