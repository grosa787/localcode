/**
 * `buildSystemPrompt` injects the correct output-style preamble for each
 * style. Verifies:
 *   - the preamble text matches per style,
 *   - omitting `outputStyle` suppresses the preamble entirely (no
 *     "Response style:" line in the prompt),
 *   - the preamble is byte-stable across two identical calls.
 */

import { describe, expect, test } from 'bun:test';
import { ContextManager } from '@/llm/context-manager';

describe('buildSystemPrompt — outputStyle preamble', () => {
  test('concise preamble is injected when outputStyle="concise"', () => {
    const cm = new ContextManager();
    const out = cm.buildSystemPrompt({ outputStyle: 'concise' });
    expect(out).toContain(
      'Response style: concise — minimal narration, direct answers.',
    );
  });

  test('explanatory preamble is injected when outputStyle="explanatory"', () => {
    const cm = new ContextManager();
    const out = cm.buildSystemPrompt({ outputStyle: 'explanatory' });
    expect(out).toContain('Response style: explanatory');
    expect(out).toContain('rationale, tradeoffs, and alternatives');
  });

  test('verbose preamble is injected when outputStyle="verbose"', () => {
    const cm = new ContextManager();
    const out = cm.buildSystemPrompt({ outputStyle: 'verbose' });
    expect(out).toContain('Response style: verbose');
    expect(out).toContain('detailed step-by-step commentary');
  });

  test('omitting outputStyle suppresses the preamble entirely', () => {
    const cm = new ContextManager();
    const out = cm.buildSystemPrompt({});
    expect(out).not.toContain('Response style:');
  });

  test('the preamble is byte-stable for fixed inputs', () => {
    const cm = new ContextManager();
    const a = cm.buildSystemPrompt({ outputStyle: 'explanatory' });
    const b = cm.buildSystemPrompt({ outputStyle: 'explanatory' });
    expect(a).toBe(b);
  });
});
