/**
 * Tests for semantic dedup of `read_file` tool results
 * (`src/llm/semantic-dedup.ts`).
 *
 * Contract under test:
 *   - 3 reads of the same file → 2 dedup'd + 1 (last) preserved.
 *   - Mutating-tool results are never touched.
 *   - The last 5 messages are never touched.
 *   - Different paths form independent groups.
 *   - Reads with <3 occurrences are left alone (no win to dedup).
 */
import { describe, test, expect } from 'bun:test';
import type { Message } from '@/types/global';
import {
  DEDUP_MIN_READS,
  DEDUP_RECENCY_WINDOW,
  MUTATING_TOOL_NAMES,
  buildDedupMarker,
  dedupReadResults,
  isMutatingTool,
} from '@/llm/semantic-dedup';

// ---------- builders ----------

let nextMsgId = 0;
function mkUser(text: string): Message {
  nextMsgId += 1;
  return {
    id: `u-${nextMsgId}`,
    role: 'user',
    content: text,
    createdAt: 0,
  };
}

function mkAssistantReadCall(path: string, callId: string): Message {
  nextMsgId += 1;
  return {
    id: `a-${nextMsgId}`,
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id: callId,
        name: 'read_file',
        arguments: { path },
      },
    ],
    createdAt: 0,
  };
}

function mkReadResult(callId: string, body: string): Message {
  nextMsgId += 1;
  return {
    id: `t-${nextMsgId}`,
    role: 'tool',
    toolName: 'read_file',
    toolCallId: callId,
    content: body,
    createdAt: 0,
  };
}

function mkAssistantToolCall(toolName: string, callId: string): Message {
  nextMsgId += 1;
  return {
    id: `a-${nextMsgId}`,
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id: callId,
        name: toolName,
        arguments: {},
      },
    ],
    createdAt: 0,
  };
}

function mkToolResult(toolName: string, callId: string, body: string): Message {
  nextMsgId += 1;
  return {
    id: `t-${nextMsgId}`,
    role: 'tool',
    toolName,
    toolCallId: callId,
    content: body,
    createdAt: 0,
  };
}

// Builds N reads of `path`. Each read pair is (assistant-call, tool-result).
// `bodySize` controls how big the read body is so we can ensure the dedup
// marker is shorter than the original content (otherwise dedup is skipped).
function mkReads(path: string, count: number, bodySize: number = 500): Message[] {
  const big = 'X'.repeat(bodySize);
  const out: Message[] = [];
  for (let i = 0; i < count; i += 1) {
    const callId = `${path}-call-${i}`;
    out.push(mkAssistantReadCall(path, callId));
    out.push(mkReadResult(callId, `${big}#${i}`));
  }
  return out;
}

// Pad with non-read messages so the recency window doesn't shield our
// test reads. `padCount` messages of user-role chatter are appended.
function pad(count: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(mkUser(`filler ${i}`));
  }
  return out;
}

// ---------- tests ----------

describe('exports', () => {
  test('DEDUP_RECENCY_WINDOW is 5 (last 5 never touched)', () => {
    expect(DEDUP_RECENCY_WINDOW).toBe(5);
  });

  test('DEDUP_MIN_READS is 3 (no win below)', () => {
    expect(DEDUP_MIN_READS).toBe(3);
  });

  test('MUTATING_TOOL_NAMES covers write_file, edit_file, multi_edit, run_command, git_commit, notebook_edit', () => {
    expect(MUTATING_TOOL_NAMES.has('write_file')).toBe(true);
    expect(MUTATING_TOOL_NAMES.has('edit_file')).toBe(true);
    expect(MUTATING_TOOL_NAMES.has('multi_edit')).toBe(true);
    expect(MUTATING_TOOL_NAMES.has('run_command')).toBe(true);
    expect(MUTATING_TOOL_NAMES.has('git_commit')).toBe(true);
    expect(MUTATING_TOOL_NAMES.has('notebook_edit')).toBe(true);
    expect(MUTATING_TOOL_NAMES.has('read_file')).toBe(false);
  });

  test('isMutatingTool helper agrees with set', () => {
    expect(isMutatingTool('write_file')).toBe(true);
    expect(isMutatingTool('read_file')).toBe(false);
    expect(isMutatingTool(undefined)).toBe(false);
    expect(isMutatingTool('')).toBe(false);
  });
});

describe('dedupReadResults — basic behaviour', () => {
  test('empty input returns empty output', () => {
    const r = dedupReadResults([]);
    expect(r.messages).toEqual([]);
    expect(r.removedTokens).toBe(0);
    expect(r.dedupedReadCount).toBe(0);
  });

  test('3 reads of same file → 2 dedup\'d + 1 preserved (the LAST)', () => {
    // Layout: [read1, read2, read3, filler*6]. We pad with 6 messages
    // so the recency window (5) sits entirely on the filler — leaving
    // every read pair eligible for substitution.
    const msgs = [...mkReads('a.ts', 3), ...pad(6)];

    const r = dedupReadResults(msgs);

    // 2 read_file results should be substituted.
    expect(r.dedupedReadCount).toBe(2);

    // Locate the three tool-role messages by their toolCallId.
    const toolMsgs = r.messages.filter(
      (m): m is Message => m !== undefined && m.role === 'tool' && m.toolName === 'read_file',
    );
    expect(toolMsgs.length).toBe(3);

    // The first 2 are substituted; the LAST is preserved verbatim.
    expect(toolMsgs[0]?.content).toContain('[dedup: see read_file result at message index');
    expect(toolMsgs[1]?.content).toContain('[dedup: see read_file result at message index');
    expect(toolMsgs[2]?.content).not.toContain('[dedup:');
    expect(typeof toolMsgs[2]?.content).toBe('string');
    expect((toolMsgs[2]?.content as string).startsWith('X')).toBe(true);

    // removedTokens should be positive (we collapsed ~500-byte bodies).
    expect(r.removedTokens).toBeGreaterThan(0);
  });

  test('2 reads of same file → no dedup (below DEDUP_MIN_READS)', () => {
    const msgs = [...mkReads('a.ts', 2), ...pad(6)];
    const r = dedupReadResults(msgs);
    expect(r.dedupedReadCount).toBe(0);
    expect(r.removedTokens).toBe(0);
    // Messages unchanged.
    for (let i = 0; i < msgs.length; i += 1) {
      expect(r.messages[i]?.content).toBe(msgs[i]?.content ?? '');
    }
  });

  test('different paths form independent groups', () => {
    // 3 reads of a.ts, 2 reads of b.ts. Only a.ts should dedup.
    const msgs = [
      ...mkReads('a.ts', 3),
      ...mkReads('b.ts', 2),
      ...pad(6),
    ];
    const r = dedupReadResults(msgs);
    expect(r.dedupedReadCount).toBe(2);
  });

  test('mutating tool results NEVER touched (3 write_file results stay verbatim)', () => {
    const big = 'Y'.repeat(500);
    const msgs: Message[] = [];
    for (let i = 0; i < 3; i += 1) {
      const callId = `wcall-${i}`;
      msgs.push(mkAssistantToolCall('write_file', callId));
      msgs.push(mkToolResult('write_file', callId, `${big}#${i}`));
    }
    msgs.push(...pad(6));

    const r = dedupReadResults(msgs);

    expect(r.dedupedReadCount).toBe(0);
    expect(r.removedTokens).toBe(0);
    // Every write_file result kept verbatim.
    const writeResults = r.messages.filter(
      (m): m is Message =>
        m !== undefined && m.role === 'tool' && m.toolName === 'write_file',
    );
    for (const wr of writeResults) {
      expect(wr.content).not.toContain('[dedup:');
      expect((wr.content as string).startsWith('Y')).toBe(true);
    }
  });

  test('last 5 messages NEVER touched (recency window)', () => {
    // Layout (10 messages, all reads inside recency window for some):
    //   [read1, read2, read3] (6 msgs) + [read4] (2 msgs) = 8
    // Then pad to position the reads so SOME fall inside last 5.
    //
    // Concretely:  read pairs 0,1 OUTSIDE; pairs 2,3 mostly INSIDE.
    //   indices:  0,1 (r0)  2,3 (r1)  4,5 (r2)  6,7 (r3)
    //   total len: 8. recency cutoff = len-5 = 3.
    //   pair 0 (idx 0,1) — outside
    //   pair 1 (idx 2,3) — 3 inside, but the TOOL message is at idx 3 → inside
    //   pair 2 (idx 4,5) — inside
    //   pair 3 (idx 6,7) — inside (the authoritative)
    // Only pair 0's tool message (idx 1) is OUTSIDE the cutoff and
    // gets substituted.
    const msgs = mkReads('a.ts', 4);
    expect(msgs.length).toBe(8);

    const r = dedupReadResults(msgs);

    // The authoritative idx is 7 (last read pair's tool result).
    // Only idx 1 is outside the cutoff (3), so 1 substitution.
    expect(r.dedupedReadCount).toBe(1);

    // Verify the messages at indices >= 3 are untouched.
    for (let i = 3; i < msgs.length; i += 1) {
      expect(r.messages[i]?.content).toBe(msgs[i]?.content ?? '');
    }
  });

  test('input array is not mutated', () => {
    const msgs = [...mkReads('a.ts', 3), ...pad(6)];
    const snapshotContents = msgs.map((m) => m.content);
    dedupReadResults(msgs);
    for (let i = 0; i < msgs.length; i += 1) {
      expect(msgs[i]?.content).toBe(snapshotContents[i] ?? '');
    }
  });

  test('marker references the correct authoritative message index', () => {
    const msgs = [...mkReads('a.ts', 3), ...pad(6)];
    const r = dedupReadResults(msgs);
    // Authoritative is the 3rd read's TOOL message — index 5 in the
    // original/output array (read0=0,1; read1=2,3; read2=4,5).
    const expectedMarker = buildDedupMarker(5);
    // First substituted tool message (idx 1) carries the marker.
    expect(r.messages[1]?.content).toBe(expectedMarker);
    // Second substituted tool message (idx 3) carries the same marker.
    expect(r.messages[3]?.content).toBe(expectedMarker);
  });

  test('skips substitution when original is shorter than marker', () => {
    // Build 3 reads with TINY bodies (1 byte each). The dedup marker
    // is longer, so substitution would inflate — we expect a skip.
    const msgs = [...mkReads('a.ts', 3, 1), ...pad(6)];
    const r = dedupReadResults(msgs);
    expect(r.dedupedReadCount).toBe(0);
    expect(r.removedTokens).toBe(0);
  });
});
