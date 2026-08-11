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

describe('resolvePrice — unsloth is local and always free', () => {
  // Unsloth Studio is a local server, so every id it serves costs $0 at
  // the margin. It must short-circuit to null exactly like ollama /
  // lmstudio rather than fall through to `lookupStaticPrice`.

  test('realistic unsloth GGUF repo ids are null', () => {
    expect(
      resolvePrice('unsloth', 'unsloth/qwen3-coder-30B-A3B-Instruct-GGUF'),
    ).toBeNull();
    expect(
      resolvePrice('unsloth', 'unsloth/gemma-4-26B-A4B-it-GGUF'),
    ).toBeNull();
    expect(resolvePrice('unsloth', 'unsloth/gpt-oss-120b-GGUF')).toBeNull();
  });

  test('ids that WOULD prefix-match a cloud price row are still null', () => {
    // This is the regression that matters. `lookupStaticPrice` does a
    // longest-prefix match, so a locally-served id like `gpt-5-GGUF`
    // resolves to GPT-5's $5/$15-per-1M row if unsloth is allowed to
    // fall through — billing a free local session at cloud rates.
    // Short-circuiting on the backend is what prevents it.
    expect(resolvePrice('unsloth', 'gpt-5-GGUF')).toBeNull();
    expect(resolvePrice('unsloth', 'gpt-4o')).toBeNull();
    expect(resolvePrice('unsloth', 'claude-sonnet-4-20250514')).toBeNull();
    expect(resolvePrice('unsloth', 'qwen/qwen3-coder-GGUF')).toBeNull();
  });

  test('the same ids DO resolve on a cloud backend (guard is not vacuous)', () => {
    // Proves the assertions above are testing the backend short-circuit
    // and not merely that these ids are absent from the price table.
    expect(resolvePrice('openai', 'gpt-4o')).not.toBeNull();
    expect(resolvePrice('anthropic', 'claude-sonnet-4-20250514')).not.toBeNull();
  });

  test('empty model id on unsloth is null', () => {
    expect(resolvePrice('unsloth', '')).toBeNull();
  });
});
