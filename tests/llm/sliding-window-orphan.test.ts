/**
 * applyRecentWindow — round-boundary slicing regression coverage.
 *
 * The bug this file guards against: naive last-N slicing can leave a
 * `tool` message at position [1] (right after `system`) without the
 * `assistant.tool_calls` that originally opened it. DeepSeek and other
 * strict OpenAI-compatible providers reject this with:
 *
 *   "Messages with role 'tool' must be a response to a preceding
 *    message with 'tool_calls'"
 *
 * The fix: slice on ROUND BOUNDARIES — a "round" is `user` →
 * `assistant` (with optional `tool_calls` + `tool` replies) → next
 * `user`. The window may keep more than maxRecent messages if the
 * tail rounds add up to that, but it will NEVER cut a round in half,
 * so the slice always opens with a `user` message after the system
 * pin (and any `[Compressed context]` summary).
 */

import { describe, expect, test } from 'bun:test';

import { applyRecentWindow } from '@/llm/context-manager';
import type { Message } from '@/types/global';

let nextId = 0;
function mkId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function sys(): Message {
  return { id: 'sys-0', role: 'system', content: 'system prompt', createdAt: 0 };
}

function user(idx: number): Message {
  return { id: `u-${idx}`, role: 'user', content: `user ${idx}`, createdAt: idx };
}

function asst(idx: number, callIds?: string[]): Message {
  const m: Message = {
    id: `a-${idx}`,
    role: 'assistant',
    content: `assistant ${idx}`,
    createdAt: idx,
  };
  if (callIds && callIds.length > 0) {
    m.toolCalls = callIds.map((id) => ({
      id,
      name: 'read_file',
      arguments: { path: 'x.ts' },
    }));
  }
  return m;
}

function tool(idx: number, callId: string): Message {
  return {
    id: `t-${idx}`,
    role: 'tool',
    content: `tool result ${idx}`,
    toolName: 'read_file',
    toolCallId: callId,
    createdAt: idx,
  };
}

function compressedSummary(): Message {
  return {
    id: mkId('compress'),
    role: 'assistant',
    content: '[Compressed context]\n\nEarlier work covered X, Y, Z.',
    createdAt: 0,
  };
}

/**
 * Build a 50-message conversation: `system + 12 rounds, each with
 * (user → assistant.tool_calls → tool → assistant)`, ending on a
 * trailing user. Always starts with `user` after the system, by
 * construction. Total = 1 system + 12*4 + 1 = 50.
 */
function buildLongHistory(): Message[] {
  const out: Message[] = [sys()];
  let i = 1;
  for (let r = 0; r < 12; r += 1) {
    const callId = `call-${r}`;
    out.push(user(i)); i += 1;
    out.push(asst(i, [callId])); i += 1;
    out.push(tool(i, callId)); i += 1;
    out.push(asst(i)); i += 1;
  }
  out.push(user(i));
  return out;
}

describe('applyRecentWindow — round-boundary slicing', () => {
  test('50-message history, max=20 → first non-system message is `user`', () => {
    const history = buildLongHistory();
    expect(history).toHaveLength(50);
    const out = applyRecentWindow(history, 20);
    // System pin first.
    expect(out[0]?.role).toBe('system');
    // Critical invariant: the message AFTER system MUST be a user.
    // Never a leftover tool whose caller got sliced.
    expect(out[1]?.role).toBe('user');
    // No orphan tool anywhere — every tool must have a preceding
    // assistant.tool_calls in the slice.
    const callerIds = new Set<string>();
    for (const m of out) {
      if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) callerIds.add(tc.id);
      }
      if (m.role === 'tool') {
        expect(callerIds.has(m.toolCallId ?? '')).toBe(true);
      }
    }
  });

  test('a single round with many tool_calls + replies is kept whole', () => {
    // 1 system + 1 stale user + a final round with 8 tool_calls each
    // followed by their tool replies, ending on an assistant. Even
    // though the round is larger than maxRecent=4, we MUST keep it
    // intact rather than cut mid-round.
    const out_arr: Message[] = [sys(), user(1)];
    out_arr.push(user(2));                                  // round opener
    out_arr.push(asst(3, ['c1','c2','c3','c4','c5','c6','c7','c8']));
    for (let k = 0; k < 8; k += 1) {
      out_arr.push(tool(4 + k, `c${k + 1}`));
    }
    out_arr.push(asst(20, []));
    const out = applyRecentWindow(out_arr, 4);
    // Round survived intact — assistant.tool_calls + 8 tools.
    const asstIdx = out.findIndex(
      (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length === 8,
    );
    expect(asstIdx).toBeGreaterThanOrEqual(0);
    const toolIds = out
      .filter((m) => m.role === 'tool')
      .map((m) => m.toolCallId);
    expect(toolIds.sort()).toEqual(
      ['c1','c2','c3','c4','c5','c6','c7','c8'].sort(),
    );
    // Slice still opens with user after system.
    expect(out[0]?.role).toBe('system');
    expect(out[1]?.role).toBe('user');
  });

  test('tiny tail edge — system + user + asst.tool_calls + tool + asst, max=2', () => {
    // 5 messages total. cap=2, slack=2 → cap+2=4 → 5 > 4, so the
    // slice runs. Expected behaviour: cannot cut mid-round; keep the
    // whole final round, plus the system pin. Slice opens with user.
    const msgs: Message[] = [
      sys(),
      user(1),
      asst(2, ['call-1']),
      tool(3, 'call-1'),
      asst(4),
    ];
    const out = applyRecentWindow(msgs, 2);
    expect(out[0]?.role).toBe('system');
    expect(out[1]?.role).toBe('user');
    // The full round survives — assistant.tool_calls and its tool
    // reply are paired.
    expect(out.map((m) => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant',
    ]);
  });

  test('compressed-context summary is pinned alongside system', () => {
    const summary = compressedSummary();
    const tail: Message[] = [];
    let i = 1;
    for (let r = 0; r < 10; r += 1) {
      tail.push(user(i)); i += 1;
      tail.push(asst(i)); i += 1;
    }
    const msgs: Message[] = [sys(), summary, ...tail];
    const out = applyRecentWindow(msgs, 6);
    expect(out[0]?.role).toBe('system');
    expect(out[1]?.id).toBe(summary.id);
    expect(out[1]?.content.startsWith('[Compressed context]')).toBe(true);
    // Right after the summary, slice opens with user.
    expect(out[2]?.role).toBe('user');
  });

  test('no orphan tool at the head, even after aggressive trim', () => {
    // 60-message history, max=4 — extreme cut. The slice must still
    // open with user (no orphan tool).
    const history = buildLongHistory();  // 50 msgs
    const extra: Message[] = [];
    let i = 51;
    for (let r = 0; r < 3; r += 1) {
      const cid = `late-call-${r}`;
      extra.push(user(i)); i += 1;
      extra.push(asst(i, [cid])); i += 1;
      extra.push(tool(i, cid)); i += 1;
      extra.push(asst(i)); i += 1;
    }
    const msgs = [...history, ...extra];
    const out = applyRecentWindow(msgs, 4);
    expect(out[0]?.role).toBe('system');
    expect(out[1]?.role).toBe('user');
    // Final round must survive intact.
    expect(out[out.length - 1]?.role === 'assistant'
      || out[out.length - 1]?.role === 'tool'
      || out[out.length - 1]?.role === 'user').toBe(true);
  });

  test('history ending mid-round still slices on a user boundary', () => {
    // Tail ends on a `user` (we just received a new turn but haven't
    // streamed the assistant yet). Slice must still respect rounds.
    const msgs: Message[] = [
      sys(),
      user(1), asst(2, ['c1']), tool(3, 'c1'), asst(4),
      user(5), asst(6, ['c2']), tool(7, 'c2'), asst(8),
      user(9), asst(10, ['c3']), tool(11, 'c3'), asst(12),
      user(13),
    ];
    const out = applyRecentWindow(msgs, 6);
    expect(out[0]?.role).toBe('system');
    expect(out[1]?.role).toBe('user');
    // Last message is the trailing user.
    expect(out[out.length - 1]?.id).toBe('u-13');
    // No orphan tool.
    const seenCallers = new Set<string>();
    for (const m of out) {
      if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) seenCallers.add(tc.id);
      }
      if (m.role === 'tool') {
        expect(seenCallers.has(m.toolCallId ?? '')).toBe(true);
      }
    }
  });
});
