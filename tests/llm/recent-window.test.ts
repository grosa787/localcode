/**
 * applyRecentWindow — sliding-window helper for the chat history sent
 * to the LLM each turn.
 *
 * Verifies the contract documented on the helper:
 *   - small histories pass through;
 *   - 0 / non-positive max disables the window;
 *   - large histories are sliced to system + last N;
 *   - synthetic `[Compressed context]` summary messages are pinned;
 *   - tool_call ↔ tool result pairing in the tail is preserved (we
 *     intentionally don't try to reach back across the cut).
 */

import { describe, expect, test } from 'bun:test';

import {
  applyRecentWindow,
  DEFAULT_MAX_RECENT_MESSAGES,
} from '@/llm/context-manager';
import type { Message } from '@/types/global';

function userMsg(idx: number): Message {
  return {
    id: `u-${idx}`,
    role: 'user',
    content: `user message ${idx}`,
    createdAt: idx,
  };
}

function asstMsg(idx: number, opts?: { toolCalls?: Message['toolCalls'] }): Message {
  const m: Message = {
    id: `a-${idx}`,
    role: 'assistant',
    content: `assistant ${idx}`,
    createdAt: idx,
  };
  if (opts?.toolCalls !== undefined) m.toolCalls = opts.toolCalls;
  return m;
}

function toolMsg(idx: number, callId: string): Message {
  return {
    id: `t-${idx}`,
    role: 'tool',
    content: `tool result ${idx}`,
    toolName: 'read_file',
    toolCallId: callId,
    createdAt: idx,
  };
}

function systemMsg(): Message {
  return {
    id: 'sys-0',
    role: 'system',
    content: 'system prompt',
    createdAt: 0,
  };
}

describe('applyRecentWindow', () => {
  test('empty input returns empty array', () => {
    expect(applyRecentWindow([], 20)).toEqual([]);
  });

  test('history smaller than cap+slack returns unchanged', () => {
    const msgs: Message[] = Array.from({ length: 10 }, (_, i) => userMsg(i));
    const out = applyRecentWindow(msgs, 20);
    expect(out).toHaveLength(10);
    expect(out.map((m) => m.id)).toEqual(msgs.map((m) => m.id));
  });

  test('large history is sliced to last N (no system pin needed)', () => {
    const msgs: Message[] = Array.from({ length: 50 }, (_, i) => userMsg(i));
    const out = applyRecentWindow(msgs, 20);
    expect(out).toHaveLength(20);
    // Should be the LAST 20 user messages (indices 30..49).
    expect(out[0]?.id).toBe('u-30');
    expect(out[out.length - 1]?.id).toBe('u-49');
  });

  test('system message is always pinned', () => {
    const msgs: Message[] = [
      systemMsg(),
      ...Array.from({ length: 50 }, (_, i) => userMsg(i)),
    ];
    const out = applyRecentWindow(msgs, 20);
    // 1 system + 20 tail = 21
    expect(out).toHaveLength(21);
    expect(out[0]?.role).toBe('system');
    expect(out[out.length - 1]?.id).toBe('u-49');
  });

  test('synthetic [Compressed context] summary message is pinned', () => {
    const summary: Message = {
      id: 'compress-0',
      role: 'assistant',
      content: '[Compressed context]\n\nEarlier work covered X, Y, Z.',
      createdAt: 0,
    };
    const msgs: Message[] = [
      systemMsg(),
      summary,
      ...Array.from({ length: 50 }, (_, i) => userMsg(i)),
    ];
    const out = applyRecentWindow(msgs, 20);
    // 1 system + 1 summary + 20 tail = 22
    expect(out).toHaveLength(22);
    expect(out[0]?.role).toBe('system');
    expect(out[1]?.id).toBe('compress-0');
    expect(out[out.length - 1]?.id).toBe('u-49');
  });

  test('maxRecent = 0 disables window (returns full history)', () => {
    const msgs: Message[] = Array.from({ length: 50 }, (_, i) => userMsg(i));
    const out = applyRecentWindow(msgs, 0);
    expect(out).toHaveLength(50);
  });

  test('negative maxRecent treated as disabled', () => {
    const msgs: Message[] = Array.from({ length: 50 }, (_, i) => userMsg(i));
    const out = applyRecentWindow(msgs, -5);
    expect(out).toHaveLength(50);
  });

  test('tool-call/tool-result pair in the tail is preserved intact', () => {
    // 30 filler messages, then assistant-with-toolCall + tool result.
    const filler: Message[] = Array.from({ length: 30 }, (_, i) => userMsg(i));
    const callerAsst = asstMsg(31, {
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'x.ts' } }],
    });
    const toolResult = toolMsg(32, 'call-1');
    const trailing = userMsg(33);

    const msgs: Message[] = [...filler, callerAsst, toolResult, trailing];
    const out = applyRecentWindow(msgs, 20);
    // The tail (last 20) must include both the assistant tool call and
    // its matching tool result — they live next to each other so the
    // slice keeps them paired without any extra logic.
    const ids = out.map((m) => m.id);
    expect(ids).toContain('a-31');
    expect(ids).toContain('t-32');
    expect(ids).toContain('u-33');
    // Order is preserved from the original array.
    expect(ids.indexOf('a-31')).toBeLessThan(ids.indexOf('t-32'));
  });

  test('default constant is 20', () => {
    expect(DEFAULT_MAX_RECENT_MESSAGES).toBe(20);
  });
});
