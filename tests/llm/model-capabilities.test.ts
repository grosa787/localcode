/**
 * Tests for `supportsVision` capability detection.
 *
 * Verifies the heuristic table over the matrix of (backend, model)
 * pairs we expect users to hit in the wild. The list is deliberately
 * NOT exhaustive — the function is a heuristic, not a registry — but
 * every "obvious" case should be locked down so a future refactor
 * can't silently break vision detection on the day a new model ships.
 */
import { describe, expect, test } from 'bun:test';
import {
  supportsVision,
  VISION_WARNING_MESSAGE,
} from '@/llm/model-capabilities';

describe('supportsVision — Anthropic', () => {
  test('claude-3.5 sonnet → true', () => {
    expect(supportsVision('anthropic', 'claude-3-5-sonnet-20241022')).toBe(true);
  });

  test('claude-opus-4-7 → true', () => {
    expect(supportsVision('anthropic', 'claude-opus-4-7-20250101')).toBe(true);
  });

  test('claude-2 → false (legacy)', () => {
    expect(supportsVision('anthropic', 'claude-2.1')).toBe(false);
  });
});

describe('supportsVision — OpenAI', () => {
  test('gpt-4o-2024-08-06 → true', () => {
    expect(supportsVision('openai', 'gpt-4o-2024-08-06')).toBe(true);
  });

  test('gpt-4-turbo → true', () => {
    expect(supportsVision('openai', 'gpt-4-turbo')).toBe(true);
  });

  test('gpt-3.5-turbo → false', () => {
    expect(supportsVision('openai', 'gpt-3.5-turbo')).toBe(false);
  });
});

describe('supportsVision — local models', () => {
  test('Ollama llama3.2-vision → true (substring match)', () => {
    expect(supportsVision('ollama', 'llama3.2-vision')).toBe(true);
  });

  test('Ollama llava:13b → true', () => {
    expect(supportsVision('ollama', 'llava:13b')).toBe(true);
  });

  test('Ollama qwen2-vl-7b → true (vl substring)', () => {
    expect(supportsVision('ollama', 'qwen2-vl-7b')).toBe(true);
  });

  test('Ollama llama3.1 → false (no vision suffix)', () => {
    expect(supportsVision('ollama', 'llama3.1:70b')).toBe(false);
  });

  test('LM Studio moondream → true', () => {
    expect(supportsVision('lmstudio', 'moondream2')).toBe(true);
  });
});

describe('supportsVision — OpenRouter', () => {
  test('openai/gpt-4o → true', () => {
    expect(supportsVision('openrouter', 'openai/gpt-4o')).toBe(true);
  });

  test('anthropic/claude-3.5-sonnet → true', () => {
    expect(supportsVision('openrouter', 'anthropic/claude-3.5-sonnet')).toBe(
      true,
    );
  });

  test('mistralai/mistral-7b → false', () => {
    expect(supportsVision('openrouter', 'mistralai/mistral-7b')).toBe(false);
  });
});

describe('supportsVision — Google', () => {
  test('gemini-1.5-pro → true', () => {
    expect(supportsVision('google', 'gemini-1.5-pro')).toBe(true);
  });

  test('gemini-2.0-flash → true', () => {
    expect(supportsVision('google', 'gemini-2.0-flash')).toBe(true);
  });
});

describe('supportsVision — escape hatches', () => {
  test('force=true short-circuits negative result', () => {
    expect(supportsVision('ollama', 'mystery-model-foo', true)).toBe(true);
  });

  test('empty model name → false', () => {
    expect(supportsVision('anthropic', '')).toBe(false);
  });

  test('undefined backend with vision-hint name → true (substring)', () => {
    expect(supportsVision(undefined, 'custom-vision-7b')).toBe(true);
  });
});

describe('VISION_WARNING_MESSAGE', () => {
  test('is a non-empty string', () => {
    expect(typeof VISION_WARNING_MESSAGE).toBe('string');
    expect(VISION_WARNING_MESSAGE.length).toBeGreaterThan(0);
  });
});
