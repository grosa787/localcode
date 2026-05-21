/**
 * sanitiseToolCallPairing — defensive sanitiser for OpenAI-compatible
 * wire payloads. Targeted regression coverage for the sliding-window
 * cut bug: a `tool` message whose caller `assistant.tool_calls` got
 * sliced off must NEVER be sent to the provider — DeepSeek (and other
 * strict gateways) rejects with:
 *
 *   "Messages with role 'tool' must be a response to a preceding
 *    message with 'tool_calls'"
 *
 * This file targets four scenarios:
 *   1. Orphan tool at position [1] (right after system) → dropped.
 *   2. Orphan assistant.tool_calls (no matching tool reply) →
 *      tool_calls field stripped, assistant content preserved.
 *   3. Both directions present in one payload → both cleaned.
 *   4. Mid-array orphan tool (caller sliced before this tool) →
 *      dropped while neighbouring valid pairs survive intact.
 *   5. Already-valid payload → passes through unchanged.
 *   6. Empty input / single message → no-op.
 */

import { describe, expect, test } from 'bun:test';

import { sanitiseToolCallPairing } from '@/llm/adapter';
import type { WireMessage } from '@/types/message';

function sys(): WireMessage {
  return { role: 'system', content: 'sys prompt' };
}

function user(text: string): WireMessage {
  return { role: 'user', content: text };
}

function asst(text: string, callIds?: string[]): WireMessage {
  const m: WireMessage = { role: 'assistant', content: text };
  if (callIds && callIds.length > 0) {
    m.tool_calls = callIds.map((id) => ({
      id,
      type: 'function' as const,
      function: { name: 'read_file', arguments: '{"path":"x.ts"}' },
    }));
  }
  return m;
}

function tool(callId: string, body = 'tool result'): WireMessage {
  return { role: 'tool', content: body, tool_call_id: callId };
}

describe('sanitiseToolCallPairing — orphan tool messages', () => {
  test('orphan tool at position [1] is dropped (sliding-window cut)', () => {
    // The slice-from-the-tail case: caller assistant got sliced off,
    // tool reply landed right after the system prompt. DeepSeek would
    // 400 on this exact shape.
    const wire: WireMessage[] = [
      sys(),
      tool('call-orphan', 'leftover tool result'),
      user('next user turn'),
      asst('reply'),
    ];
    const out = sanitiseToolCallPairing(wire);
    expect(out.find((m) => m.role === 'tool')).toBeUndefined();
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  test('mid-array orphan tool is dropped, valid pairs survive', () => {
    // Walk-forward sanity check: an orphan tool in the middle of the
    // array — caller assistant for `call-X` was sliced — should be
    // removed while the perfectly-paired (asst, tool) round around it
    // stays intact.
    const wire: WireMessage[] = [
      sys(),
      user('q1'),
      asst('a1', ['call-1']),
      tool('call-1', 'r1'),
      tool('call-orphan', 'mid-array orphan'),  // no caller upstream
      user('q2'),
      asst('a2', ['call-2']),
      tool('call-2', 'r2'),
    ];
    const out = sanitiseToolCallPairing(wire);
    const orphan = out.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call-orphan',
    );
    expect(orphan).toBeUndefined();
    // Both valid tool replies survived.
    expect(out.filter((m) => m.role === 'tool').length).toBe(2);
    expect(out.filter((m) => m.role === 'assistant').length).toBe(2);
  });

  test('tool with empty / missing tool_call_id is dropped', () => {
    const wire: WireMessage[] = [
      sys(),
      { role: 'tool', content: 'no id at all' },
      user('q'),
    ];
    const out = sanitiseToolCallPairing(wire);
    expect(out.find((m) => m.role === 'tool')).toBeUndefined();
  });
});

describe('sanitiseToolCallPairing — orphan assistant.tool_calls', () => {
  test('assistant tool_calls without matching tool reply has tool_calls stripped', () => {
    // Inverse cut: caller survived, replies got trimmed. Existing
    // sanitiser behaviour — preserved across the new orphan-tool pass.
    const wire: WireMessage[] = [
      sys(),
      user('q'),
      asst('I will look it up.', ['missing-call']),
      // No matching tool reply for "missing-call".
    ];
    const out = sanitiseToolCallPairing(wire);
    const a = out.find((m) => m.role === 'assistant');
    expect(a).toBeDefined();
    expect(a?.tool_calls).toBeUndefined();
    // Content survives so the user still sees the assistant turn.
    expect(a?.content).toBe('I will look it up.');
  });

  test('assistant with no content AND orphan tool_calls is dropped entirely', () => {
    const wire: WireMessage[] = [
      sys(),
      user('q'),
      asst('', ['orphan-call']),  // no text, no usable tool_calls
    ];
    const out = sanitiseToolCallPairing(wire);
    expect(out.find((m) => m.role === 'assistant')).toBeUndefined();
  });
});

describe('sanitiseToolCallPairing — combined directions', () => {
  test('both orphan-tool and orphan-tool_calls present → both cleaned', () => {
    const wire: WireMessage[] = [
      sys(),
      tool('orphan-leading', 'leftover'),                    // dropped (orphan tool)
      user('q'),
      asst('I will think.', ['unanswered-call']),            // tool_calls stripped
      user('q2'),
      asst('a2', ['call-2']),
      tool('call-2', 'r2'),                                  // kept (paired)
    ];
    const out = sanitiseToolCallPairing(wire);
    // Leading orphan tool removed.
    expect(out[0]?.role).toBe('system');
    expect(out[1]?.role).toBe('user');
    // First assistant kept, but tool_calls stripped.
    const firstAsst = out.find(
      (m) => m.role === 'assistant' && m.content === 'I will think.',
    );
    expect(firstAsst).toBeDefined();
    expect(firstAsst?.tool_calls).toBeUndefined();
    // Paired tool reply for call-2 still present.
    const paired = out.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call-2',
    );
    expect(paired).toBeDefined();
  });

  test('result always starts with non-tool role after sanitiser', () => {
    // Property: after the sanitiser runs, the wire array can never
    // open with a `tool` message at position [1] when [0] is system.
    const wire: WireMessage[] = [
      sys(),
      tool('orphan-1'),
      tool('orphan-2'),
      tool('orphan-3'),
      user('first user'),
    ];
    const out = sanitiseToolCallPairing(wire);
    // None of the leading tools survive.
    for (let i = 0; i < out.length; i += 1) {
      const m = out[i];
      if (!m) continue;
      if (m.role === 'tool') {
        // Must have a preceding assistant.tool_calls with this id.
        let foundCaller = false;
        for (let j = 0; j < i; j += 1) {
          const prior = out[j];
          if (prior?.role === 'assistant' && Array.isArray(prior.tool_calls)) {
            if (prior.tool_calls.some((tc) => tc.id === m.tool_call_id)) {
              foundCaller = true;
              break;
            }
          }
        }
        expect(foundCaller).toBe(true);
      }
    }
  });
});

describe('sanitiseToolCallPairing — pass-through cases', () => {
  test('valid payload with paired tool calls is unchanged', () => {
    const wire: WireMessage[] = [
      sys(),
      user('q'),
      asst('let me check', ['call-1']),
      tool('call-1', 'r1'),
      asst('done'),
    ];
    const out = sanitiseToolCallPairing(wire);
    expect(out).toHaveLength(wire.length);
    expect(out.map((m) => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant',
    ]);
  });

  test('empty input → empty output', () => {
    expect(sanitiseToolCallPairing([])).toEqual([]);
  });

  test('single user message passes through', () => {
    const wire: WireMessage[] = [user('hi')];
    expect(sanitiseToolCallPairing(wire)).toEqual(wire);
  });
});
