/**
 * R3 — `ThinkingPhrases` data + `pickPhrase` helper.
 *
 * Spec invariants:
 *   - Each locale ships a 30-item phrase bank.
 *   - No duplicates within a single bank.
 *   - `pickPhrase(locale, i)` cycles through the bank deterministically
 *     using positive integer indices (and gracefully handles negatives /
 *     non-finite via modulo math).
 *   - Both English and Russian banks are independent — selecting one
 *     locale doesn't affect output for the other.
 */
import { describe, test, expect } from 'bun:test';
import {
  PHRASES_EN,
  PHRASES_RU,
  PHRASE_ROTATE_MS,
  GRADIENT_STEP_MS,
  pickPhrase,
} from '@/ui/components/ThinkingPhrases';

describe('ThinkingPhrases — bank shape', () => {
  test('English bank has exactly 30 entries', () => {
    expect(PHRASES_EN.length).toBe(30);
  });

  test('Russian bank has exactly 30 entries', () => {
    expect(PHRASES_RU.length).toBe(30);
  });

  test('every English phrase is a non-empty string', () => {
    for (const p of PHRASES_EN) {
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    }
  });

  test('every Russian phrase is a non-empty string', () => {
    for (const p of PHRASES_RU) {
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    }
  });

  test('English bank has no duplicates', () => {
    const seen = new Set<string>(PHRASES_EN);
    expect(seen.size).toBe(PHRASES_EN.length);
  });

  test('Russian bank has no duplicates', () => {
    const seen = new Set<string>(PHRASES_RU);
    expect(seen.size).toBe(PHRASES_RU.length);
  });
});

describe('ThinkingPhrases — pickPhrase', () => {
  test('en: index 0 returns first English phrase', () => {
    expect(pickPhrase('en', 0)).toBe(PHRASES_EN[0]!);
  });

  test('ru: index 0 returns first Russian phrase', () => {
    expect(pickPhrase('ru', 0)).toBe(PHRASES_RU[0]!);
  });

  test('en: cycles deterministically across [0..29]', () => {
    for (let i = 0; i < PHRASES_EN.length; i += 1) {
      expect(pickPhrase('en', i)).toBe(PHRASES_EN[i]!);
    }
  });

  test('ru: cycles deterministically across [0..29]', () => {
    for (let i = 0; i < PHRASES_RU.length; i += 1) {
      expect(pickPhrase('ru', i)).toBe(PHRASES_RU[i]!);
    }
  });

  test('en: index 30 wraps back to first phrase', () => {
    expect(pickPhrase('en', 30)).toBe(PHRASES_EN[0]!);
  });

  test('ru: index 30 wraps back to first phrase', () => {
    expect(pickPhrase('ru', 30)).toBe(PHRASES_RU[0]!);
  });

  test('en: large index modulos correctly', () => {
    expect(pickPhrase('en', 1234)).toBe(PHRASES_EN[1234 % PHRASES_EN.length]!);
  });

  test('ru: large index modulos correctly', () => {
    expect(pickPhrase('ru', 9_999_999)).toBe(
      PHRASES_RU[9_999_999 % PHRASES_RU.length]!,
    );
  });

  test('negative indices map to a valid phrase via modulo math', () => {
    const result = pickPhrase('en', -1);
    expect(typeof result).toBe('string');
    expect(result.length > 0).toBe(true);
    // -1 mod 30 = 29 in mathematical modulo.
    expect(result).toBe(PHRASES_EN[29]!);
  });

  test('en and ru are independent', () => {
    // Same index, different banks → different phrases (assuming no
    // cross-language collision, which our hard-coded banks satisfy).
    expect(pickPhrase('en', 0)).not.toBe(pickPhrase('ru', 0));
    expect(pickPhrase('en', 5)).not.toBe(pickPhrase('ru', 5));
  });
});

describe('ThinkingPhrases — rotation timings', () => {
  test('PHRASE_ROTATE_MS is 30 seconds (per spec)', () => {
    expect(PHRASE_ROTATE_MS).toBe(30_000);
  });

  test('GRADIENT_STEP_MS is a positive number', () => {
    expect(typeof GRADIENT_STEP_MS).toBe('number');
    expect(GRADIENT_STEP_MS).toBeGreaterThan(0);
  });
});
