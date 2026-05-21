/**
 * Regression coverage for the TUI i18n core.
 *
 * The bug this skill targets: v0.20.0 shipped a language picker that
 * persisted `config.locale = 'ru'` but the rest of the TUI rendered
 * English regardless. Root cause: there was no i18n layer at all — every
 * `<Text>` was a hardcoded English literal.
 *
 * These tests pin the new contract:
 *   - `getActiveLocale()` reflects the most recent `setActiveLocale()`.
 *   - `t(key)` returns the active-locale string for known keys and falls
 *     back to English when the key is missing from the active table.
 *   - `subscribeLocale()` fires on every flip and stops firing after
 *     unsubscribe.
 *   - Placeholder substitution applies to every value position.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  getActiveLocale,
  setActiveLocale,
  subscribeLocale,
  t,
} from '../../src/i18n/index.js';

describe('TUI i18n core', () => {
  beforeEach(() => {
    setActiveLocale('en');
  });

  afterEach(() => {
    setActiveLocale('en');
  });

  test('getActiveLocale defaults to en', () => {
    expect(getActiveLocale()).toBe('en');
  });

  test('setActiveLocale flips the module-level mirror', () => {
    setActiveLocale('ru');
    expect(getActiveLocale()).toBe('ru');
    setActiveLocale('en');
    expect(getActiveLocale()).toBe('en');
  });

  test('t() resolves against the active locale', () => {
    setActiveLocale('en');
    const enHint = t('language.choose');
    setActiveLocale('ru');
    const ruHint = t('language.choose');
    expect(enHint).toBe('Choose your language');
    expect(ruHint).toBe('Выберите язык');
    expect(enHint).not.toBe(ruHint);
  });

  test('t() substitutes named placeholders', () => {
    setActiveLocale('en');
    expect(t('onboarding.selected', { name: 'OpenAI' })).toBe(
      'Selected: OpenAI',
    );
    setActiveLocale('ru');
    expect(t('onboarding.selected', { name: 'OpenAI' })).toBe(
      'Выбрано: OpenAI',
    );
  });

  test('t() handles plural-correct keyed variants', () => {
    setActiveLocale('ru');
    expect(t('chat.queueCountOne')).toBe(
      '↳ 1 сообщение в очереди (отправится после этого хода)',
    );
    expect(t('chat.queueCountMany', { n: 5 })).toBe(
      '↳ 5 сообщений в очереди (отправятся после этого хода)',
    );
  });

  test('t() accepts an explicit locale override', () => {
    setActiveLocale('en');
    expect(t('language.welcome', undefined, 'ru')).toBe(
      'Добро пожаловать в LocalCode',
    );
    expect(t('language.welcome', undefined, 'en')).toBe(
      'Welcome to LocalCode',
    );
  });

  test('subscribeLocale fires for each locale change and unsubscribes cleanly', () => {
    const received: string[] = [];
    const off = subscribeLocale((l) => received.push(l));
    setActiveLocale('ru');
    setActiveLocale('en');
    setActiveLocale('ru');
    off();
    setActiveLocale('en');
    expect(received).toEqual(['ru', 'en', 'ru']);
  });

  test('setActiveLocale is a no-op when locale already matches', () => {
    setActiveLocale('en');
    const received: string[] = [];
    const off = subscribeLocale((l) => received.push(l));
    setActiveLocale('en');
    off();
    expect(received).toEqual([]);
  });
});
