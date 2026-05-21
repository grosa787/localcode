/**
 * R16 — `buildPreviewSummaryPrompt(messages)` builds the user prompt
 * fed to the LLM by the auto-summarise-on-exit flow. The output of that
 * call lands on `Session.summary` and is shown in the `/resume` overlay
 * as a one-or-two-sentence preview row.
 *
 * Contract verified here:
 *   - Header instructs the model to produce 100-200 chars.
 *   - The example sentence is included verbatim so the model has a
 *     concrete imitation target.
 *   - Only the trailing 30 messages are rendered (older context is
 *     dropped so the prompt stays small for cheap local models).
 *   - Tool / system rows are excluded (they're noise for a preview).
 *   - User content is truncated to 300 chars; assistant to 200 chars.
 */
import { describe, test, expect } from 'bun:test';
import { buildPreviewSummaryPrompt } from '@/llm/context-manager';
import type { Message } from '@/types/global';

function userMsg(content: string, id = '0'): Message {
  return { id: `u-${id}`, role: 'user', content, createdAt: 0 };
}

function asstMsg(content: string, id = '0'): Message {
  return { id: `a-${id}`, role: 'assistant', content, createdAt: 0 };
}

function toolMsg(content: string, id = '0'): Message {
  return {
    id: `t-${id}`,
    role: 'tool',
    content,
    toolName: 'read_file',
    toolCallId: 'c1',
    createdAt: 0,
  };
}

function systemMsg(content: string, id = '0'): Message {
  return { id: `s-${id}`, role: 'system', content, createdAt: 0 };
}

describe('buildPreviewSummaryPrompt (R16)', () => {
  test('returns a string containing the "100-200 chars" length instruction', () => {
    const out = buildPreviewSummaryPrompt([userMsg('hello')]);
    expect(typeof out).toBe('string');
    expect(out).toContain('100-200 chars');
  });

  test('includes the example sentence verbatim so the model imitates the form', () => {
    const out = buildPreviewSummaryPrompt([userMsg('hi')]);
    expect(out).toContain(
      'Refactoring user authentication to use JWT instead of session cookies; debugging cookie domain mismatch.',
    );
  });

  test('only the trailing 30 messages are rendered', () => {
    // Build 35 user messages with distinct content so we can verify
    // the slice-to-last-30 behaviour: messages 0-4 must be absent and
    // 5-34 must all be present.
    const msgs: Message[] = [];
    for (let i = 0; i < 35; i++) {
      msgs.push(userMsg(`MARK_${i}_END`, String(i)));
    }
    const out = buildPreviewSummaryPrompt(msgs);
    // First 5 are sliced off.
    for (let i = 0; i < 5; i++) {
      expect(out).not.toContain(`MARK_${i}_END`);
    }
    // Last 30 are kept.
    for (let i = 5; i < 35; i++) {
      expect(out).toContain(`MARK_${i}_END`);
    }
  });

  test('drops tool and system rows (only user/assistant survive)', () => {
    const msgs: Message[] = [
      userMsg('USER_LINE'),
      asstMsg('ASST_LINE'),
      toolMsg('TOOL_LINE'),
      systemMsg('SYSTEM_LINE'),
    ];
    const out = buildPreviewSummaryPrompt(msgs);
    expect(out).toContain('USER_LINE');
    expect(out).toContain('ASST_LINE');
    expect(out).not.toContain('TOOL_LINE');
    expect(out).not.toContain('SYSTEM_LINE');
  });

  test('user content is truncated to 300 chars (everything after dropped)', () => {
    const longBody = `${'x'.repeat(300)}DROP_ME${'y'.repeat(50)}`;
    const out = buildPreviewSummaryPrompt([userMsg(longBody)]);
    // The 300-char prefix survives; the marker after position 300 is gone.
    expect(out).toContain('x'.repeat(300));
    expect(out).not.toContain('DROP_ME');
  });

  test('assistant content is truncated to 200 chars (everything after dropped)', () => {
    const longBody = `${'a'.repeat(200)}DROP_ME${'b'.repeat(50)}`;
    const out = buildPreviewSummaryPrompt([asstMsg(longBody)]);
    expect(out).toContain('a'.repeat(200));
    expect(out).not.toContain('DROP_ME');
    // Sanity: the 199-char prefix is also kept (truncation is at 200,
    // not earlier).
    expect(out).toContain('a'.repeat(199));
  });
});
