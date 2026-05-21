/**
 * Zod schema coverage for the new `outputStyle` field on `Config`.
 *   - default is `'concise'`,
 *   - valid enum values round-trip,
 *   - unknown values fail validation,
 *   - `getDefaultConfig` materialises the field.
 */

import { describe, expect, test } from 'bun:test';
import {
  ConfigSchema,
  OutputStyleSchema,
} from '@/config/types';
import { getDefaultConfig } from '@/config/defaults';

describe('outputStyle config field', () => {
  test('default value is "concise"', () => {
    const minimal = {
      backend: { type: 'ollama' as const, baseUrl: 'http://localhost:11434' },
      model: { current: '', available: [] },
      onboarding: { completed: false },
      permissions: { autoApprove: [], profile: 'default' as const },
      context: {
        maxTokens: 8192,
        keepAliveSeconds: 1800,
        responseTimeoutSeconds: 300,
        trimToolResultsAfter: 3,
        autoCompressPercent: 0.8,
        maxRecentMessages: 20,
      },
      sound: {
        enabled: false,
        onCompletion: true,
        onApproval: true,
        onError: true,
        volume: 0.5,
        completionFile: null,
        approvalFile: null,
        errorFile: null,
      },
      generation: {
        temperature: 0.2,
        topP: 0.9,
        repeatPenalty: 1.1,
        maxTokens: 4096,
      },
    };
    const parsed = ConfigSchema.parse(minimal);
    expect(parsed.outputStyle).toBe('concise');
  });

  test('every documented value round-trips', () => {
    for (const v of ['concise', 'explanatory', 'verbose'] as const) {
      expect(OutputStyleSchema.parse(v)).toBe(v);
    }
  });

  test('unknown value fails validation', () => {
    expect(OutputStyleSchema.safeParse('chatty').success).toBe(false);
    expect(OutputStyleSchema.safeParse('').success).toBe(false);
    expect(OutputStyleSchema.safeParse(42).success).toBe(false);
  });

  test('getDefaultConfig sets outputStyle to "concise"', () => {
    const cfg = getDefaultConfig('ollama');
    expect(cfg.outputStyle).toBe('concise');
  });

  test('getDefaultConfig outputStyle survives Zod re-parse', () => {
    const cfg = getDefaultConfig('ollama');
    const parsed = ConfigSchema.parse(cfg);
    expect(parsed.outputStyle).toBe('concise');
  });
});
