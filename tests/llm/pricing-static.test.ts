/**
 * Static pricing table — lookup behaviour. Mirrors the prefix-resolution
 * contract documented in `src/llm/pricing/static-pricing.ts`.
 */

import { describe, test, expect } from 'bun:test';
import {
  lookupStaticPrice,
  STATIC_PRICING,
} from '@/llm/pricing/static-pricing';

describe('lookupStaticPrice', () => {
  test('exact id match resolves to the canonical row', () => {
    const p = lookupStaticPrice('anthropic/claude-3.5-sonnet');
    expect(p).not.toBeNull();
    expect(p?.inputPer1M).toBe(3.0);
    expect(p?.outputPer1M).toBe(15.0);
  });

  test('basename match for vendor-native ids', () => {
    const p = lookupStaticPrice('claude-3-5-sonnet');
    expect(p).not.toBeNull();
    expect(p?.inputPer1M).toBe(3.0);
  });

  test('longest-prefix match with date / variant suffix', () => {
    const p = lookupStaticPrice('openai/gpt-4o-2024-08-06');
    expect(p).not.toBeNull();
    expect(p?.inputPer1M).toBe(2.5);
  });

  test('unknown model returns null', () => {
    expect(lookupStaticPrice('local/qwen-fancy')).toBeNull();
    expect(lookupStaticPrice('ollama/llama3')).toBeNull();
  });

  test('empty input safe — returns null', () => {
    expect(lookupStaticPrice('')).toBeNull();
  });

  test('table contains rows for major families', () => {
    // Belt-and-braces: catch accidental table-trim regressions.
    expect(Object.keys(STATIC_PRICING).length).toBeGreaterThan(10);
    expect(STATIC_PRICING['gpt-4o-mini']).toBeDefined();
    expect(STATIC_PRICING['gemini-2.5-pro']).toBeDefined();
  });
});
