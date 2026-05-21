/**
 * Pricing-resolver coverage smoke-tests.
 *
 * Verifies that the unified `resolvePrice` helper returns a non-null
 * `ModelPricing` record for representative cloud models across the
 * backends LocalCode supports out of the box. These act as a
 * regression net so a future refactor of the static table or the
 * OpenRouter parser cannot silently drop pricing for the canonical
 * "every user has heard of these" model ids.
 *
 * The OpenRouter cache is intentionally NOT primed here — the resolver
 * must fall through to the static table for the OpenRouter case too.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import { resolvePrice } from '@/llm/pricing/resolver';
import { __resetOpenRouterPricingForTests } from '@/llm/pricing/openrouter-pricing';

beforeEach(() => {
  // Each test must start with a cold OpenRouter cache so the static-
  // table fallback path is exercised deterministically.
  __resetOpenRouterPricingForTests();
});

describe('resolvePrice — representative coverage', () => {
  test('openrouter Anthropic id resolves via static fallback', () => {
    const p = resolvePrice('openrouter', 'anthropic/claude-3.5-sonnet');
    expect(p).not.toBeNull();
    expect(p?.inputPer1M).toBeGreaterThan(0);
    expect(p?.outputPer1M).toBeGreaterThan(0);
  });

  test('anthropic backend resolves Claude Sonnet 4 (longest-prefix)', () => {
    // The static table has `claude-sonnet-4`; date-suffix variants like
    // `claude-sonnet-4-20250514` must hit the longest-prefix branch.
    const p = resolvePrice('anthropic', 'claude-sonnet-4-20250514');
    expect(p).not.toBeNull();
    expect(p?.inputPer1M).toBeGreaterThan(0);
    expect(p?.outputPer1M).toBeGreaterThan(0);
  });

  test('openai backend resolves gpt-4o-mini', () => {
    const p = resolvePrice('openai', 'gpt-4o-mini');
    expect(p).not.toBeNull();
    expect(p?.inputPer1M).toBeGreaterThan(0);
    expect(p?.outputPer1M).toBeGreaterThan(0);
  });

  test('ollama is null (local, free at the margin)', () => {
    // Local providers MUST return null so the UI can render "—" rather
    // than a misleading $0.00 row. Distinguishing free-cloud from
    // local-zero matters when aggregating mixed-backend sessions.
    expect(resolvePrice('ollama', 'llama3.2:3b')).toBeNull();
    expect(resolvePrice('lmstudio', 'qwen2.5-coder:7b')).toBeNull();
  });

  test('empty / invalid model id is null', () => {
    expect(resolvePrice('openai', '')).toBeNull();
  });
});
