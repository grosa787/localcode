/**
 * Token-economy round — verify the tightened
 * `trimToolResultsAfter` default propagates through every layer the
 * runtime reads.
 *
 *   - `DEFAULT_TRIM_TOOL_RESULTS_AFTER` (the in-module constant used
 *     by `trimOldToolResults` when no explicit value is supplied) is 3.
 *   - `ContextSettingsSchema.parse(undefined)` fills in 3.
 *   - `getDefaultConfig(...)` carries 3 across all backends.
 */
import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_TRIM_TOOL_RESULTS_AFTER,
  trimOldToolResults,
} from '@/llm/context-manager';
import { ContextSettingsSchema } from '@/config/types';
import { DEFAULTS, getDefaultConfig } from '@/config/defaults';
import type { Message } from '@/types/global';

describe('trimToolResultsAfter — default tightened to 3 (token-economy)', () => {
  test('DEFAULT_TRIM_TOOL_RESULTS_AFTER constant is 3', () => {
    expect(DEFAULT_TRIM_TOOL_RESULTS_AFTER).toBe(3);
  });

  test('ContextSettingsSchema.parse(undefined) yields trimToolResultsAfter=3', () => {
    const parsed = ContextSettingsSchema.parse(undefined);
    expect(parsed.trimToolResultsAfter).toBe(3);
  });

  test('DEFAULTS.context.trimToolResultsAfter is 3', () => {
    expect(DEFAULTS.context.trimToolResultsAfter).toBe(3);
  });

  test('getDefaultConfig fills 3 across backends', () => {
    expect(getDefaultConfig('ollama').context.trimToolResultsAfter).toBe(3);
    expect(getDefaultConfig('openrouter').context.trimToolResultsAfter).toBe(3);
    expect(getDefaultConfig('anthropic').context.trimToolResultsAfter).toBe(3);
  });

  test('trimOldToolResults with default keep=3 collapses older tool results', () => {
    // 5 tool results → only the last 3 survive verbatim.
    const msgs: Message[] = [];
    for (let i = 0; i < 5; i += 1) {
      msgs.push({
        id: `t-${i}`,
        role: 'tool',
        content: `body-${i}`,
        toolName: 'read_file',
        toolCallId: `c-${i}`,
        createdAt: 0,
      });
    }
    const out = trimOldToolResults(msgs);
    expect(out[0]?.content).toContain('bytes collapsed');
    expect(out[1]?.content).toContain('bytes collapsed');
    expect(out[2]?.content).toBe('body-2');
    expect(out[3]?.content).toBe('body-3');
    expect(out[4]?.content).toBe('body-4');
  });
});
