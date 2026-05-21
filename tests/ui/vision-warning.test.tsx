/**
 * Vision-warning gating tests.
 *
 * The composer should toast a warning when the user attaches an image
 * AND `supportsVision(backend, model)` returns false. Suppressed via
 * `config.composer.suppressVisionWarning`. We test the pure decision
 * helper — the React side is exercised by the InputBar image-drop
 * tests in `tests/ui/input-bar-image-drop.test.ts`.
 */
import { describe, test, expect } from 'bun:test';
import { supportsVision, VISION_WARNING_MESSAGE } from '@/llm/model-capabilities';
import { ComposerSettingsSchema } from '@/config/types';

/**
 * Reproduce the composer's decision: do we show the vision warning?
 *
 *   1. If `hasAttachedImage === false`, never warn.
 *   2. If model is heuristically vision-capable, never warn.
 *   3. If `composer.suppressVisionWarning === true`, never warn.
 *   4. Else warn.
 */
function shouldWarnAboutVision(
  hasAttachedImage: boolean,
  backend: 'openai' | 'anthropic' | 'ollama' | 'lmstudio' | 'openrouter' | 'google' | 'custom',
  model: string,
  suppress: boolean,
): boolean {
  if (!hasAttachedImage) return false;
  if (supportsVision(backend, model)) return false;
  if (suppress) return false;
  return true;
}

describe('vision-warning decision', () => {
  test('no attachment → never warn', () => {
    expect(shouldWarnAboutVision(false, 'ollama', 'gemma-2b', false)).toBe(false);
  });

  test('attachment + vision-capable model → no warn', () => {
    expect(shouldWarnAboutVision(true, 'anthropic', 'claude-sonnet-4-6', false)).toBe(false);
    expect(shouldWarnAboutVision(true, 'openai', 'gpt-4o-mini', false)).toBe(false);
    expect(shouldWarnAboutVision(true, 'ollama', 'llama3.2-vision', false)).toBe(false);
    expect(shouldWarnAboutVision(true, 'ollama', 'llava:13b', false)).toBe(false);
    expect(shouldWarnAboutVision(true, 'google', 'gemini-2.0-flash', false)).toBe(false);
  });

  test('attachment + non-vision model → WARN', () => {
    expect(shouldWarnAboutVision(true, 'ollama', 'gemma:7b', false)).toBe(true);
    expect(shouldWarnAboutVision(true, 'openai', 'gpt-3.5-turbo', false)).toBe(true);
    expect(shouldWarnAboutVision(true, 'lmstudio', 'qwen-coder-7b', false)).toBe(true);
    expect(shouldWarnAboutVision(true, 'openrouter', 'meta-llama/llama-3.1-70b', false)).toBe(true);
  });

  test('suppressVisionWarning=true → never warn even for non-vision model', () => {
    expect(shouldWarnAboutVision(true, 'ollama', 'gemma:7b', true)).toBe(false);
    expect(shouldWarnAboutVision(true, 'openai', 'gpt-3.5-turbo', true)).toBe(false);
  });

  test('warning message string is exported and non-empty', () => {
    expect(typeof VISION_WARNING_MESSAGE).toBe('string');
    expect(VISION_WARNING_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe('ComposerSettingsSchema', () => {
  test('defaults to suppressVisionWarning=false', () => {
    const parsed = ComposerSettingsSchema.parse({});
    expect(parsed.suppressVisionWarning).toBe(false);
  });

  test('accepts explicit suppressVisionWarning=true', () => {
    const parsed = ComposerSettingsSchema.parse({ suppressVisionWarning: true });
    expect(parsed.suppressVisionWarning).toBe(true);
  });

  test('handles missing field via default', () => {
    const parsed = ComposerSettingsSchema.parse(undefined);
    expect(parsed.suppressVisionWarning).toBe(false);
  });
});
