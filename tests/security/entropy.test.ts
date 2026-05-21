/**
 * Entropy helper — correctness + threshold tuning sanity.
 */

import { describe, expect, test } from 'bun:test';

import { looksHighEntropy, shannonEntropy } from '@/security';

describe('shannonEntropy', () => {
  test('empty string is 0', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  test('all-same character is 0', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
  });

  test('uniform two-char string is exactly 1 bit', () => {
    expect(shannonEntropy('ab')).toBeCloseTo(1.0, 5);
  });

  test('random base64 has entropy above 5 bits', () => {
    // a high-entropy 64-char base64ish string
    const value = 'aB3+x9YzQ7vL2mNpKwQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj';
    expect(shannonEntropy(value)).toBeGreaterThan(5.0);
  });

  test('dictionary phrase stays under 4 bits', () => {
    const value = 'the quick brown fox jumps over the lazy dog';
    expect(shannonEntropy(value)).toBeLessThan(4.5);
  });
});

describe('looksHighEntropy threshold sanity', () => {
  test('rejects strings shorter than minLength', () => {
    expect(looksHighEntropy('xY9p!Qa', { minLength: 20 })).toBe(false);
  });

  test('rejects dictionary text even when long', () => {
    expect(
      looksHighEntropy('this is a long dictionary phrase that is not a secret', {
        minLength: 20,
        minEntropy: 4.0,
      }),
    ).toBe(false);
  });

  test('accepts random-looking high-entropy strings', () => {
    const v = 'Z9c8B7n6M5l4K3j2I1h0G9f8E7d6C5b4';
    expect(looksHighEntropy(v)).toBe(true);
  });

  test('threshold tunable down', () => {
    const v = 'password123password123';
    expect(looksHighEntropy(v, { minEntropy: 2.5 })).toBe(true);
    expect(looksHighEntropy(v, { minEntropy: 4.5 })).toBe(false);
  });
});
