/**
 * AgentInlineMessage interleave — exercises the pure `mergeInterleaved`
 * selector that produces the chronological message + agent-tail union
 * ChatScreen renders. The wire-up regression for the call-site lives
 * in `chatscreen-wave6b-wireup.test.ts`.
 */

import { describe, test, expect } from 'bun:test';
import {
  mergeInterleaved,
  type AgentTailEntry,
} from '@/ui/agent-tail-store';
import type { Message } from '@/types/global';

function msg(id: string, role: Message['role'], at: number, content = ''): Message {
  return {
    id,
    role,
    content,
    createdAt: at,
  };
}

function tail(id: string, at: number): AgentTailEntry {
  return {
    id,
    sessionId: 's1',
    agentId: 'w1',
    templateName: 'debugger',
    to: 'lead',
    message: `tail-${id}`,
    at,
  };
}

describe('mergeInterleaved', () => {
  test('orders by timestamp', () => {
    const m1 = msg('m1', 'user', 100);
    const t1 = tail('t1', 150);
    const m2 = msg('m2', 'assistant', 200);
    const out = mergeInterleaved([m1, m2], [t1]);
    expect(out.map((i) => i.kind)).toEqual(['message', 'agent-tail', 'message']);
  });

  test('lead wins same-timestamp ties', () => {
    const m1 = msg('m1', 'user', 100);
    const t1 = tail('t1', 100);
    const out = mergeInterleaved([m1], [t1]);
    expect(out[0]?.kind).toBe('message');
    expect(out[1]?.kind).toBe('agent-tail');
  });

  test('handles empty inputs', () => {
    expect(mergeInterleaved([], []).length).toBe(0);
    expect(mergeInterleaved([msg('m', 'user', 1)], []).length).toBe(1);
    expect(mergeInterleaved([], [tail('t', 1)]).length).toBe(1);
  });
});
