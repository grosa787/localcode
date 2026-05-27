/**
 * Tests for the compression-strategy selector + executor
 * (`src/llm/compress-strategy.ts`).
 *
 * Contract under test:
 *   - `chooseCompressStrategy` returns `dedup` when dedup savings are
 *     meaningful, `summarize` when the middle is large AND the backend
 *     has a cheap model, `truncate` when no cheap model is available,
 *     and `dedup` otherwise (cheap default).
 *   - `resolveCheapModel` maps OpenAI→gpt-4o-mini, Anthropic→haiku,
 *     Google→gemini-1.5-flash, OpenRouter→openai/gpt-4o-mini, and
 *     local providers (ollama/lmstudio/custom) → null.
 *   - `applyCompressStrategy` with strategy='dedup' performs the dedup
 *     pass and returns a new list.
 *   - `applyCompressStrategy` with strategy='summarize' calls the
 *     injected summariser, inserts an `[auto-compressed summary]`
 *     system message, preserves mutating-tool history in the middle.
 *   - `applyCompressStrategy` with strategy='truncate' drops the
 *     non-mutating middle.
 *   - Fallback: summarize without a wired summariser → truncate.
 *   - Fallback: summariser that throws or returns empty → truncate.
 */
import { describe, test, expect } from 'bun:test';
import type { Backend, Message } from '@/types/global';
import {
  CHEAP_MODEL_BY_BACKEND,
  DEDUP_USEFUL_SAVINGS_TOKENS,
  HEAD_KEEP,
  SUMMARIZE_MIDDLE_MIN,
  SUMMARIZE_TAIL_KEEP,
  SUMMARY_MARKER,
  TRUNCATE_TAIL_KEEP,
  applyCompressStrategy,
  chooseCompressStrategy,
  resolveCheapModel,
} from '@/llm/compress-strategy';

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

function mkAssistant(text: string): Message {
  nextMsgId += 1;
  return {
    id: `a-${nextMsgId}`,
    role: 'assistant',
    content: text,
    createdAt: 0,
  };
}

function mkReadCall(path: string, callId: string): Message {
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

function mkWriteCall(callId: string): Message {
  nextMsgId += 1;
  return {
    id: `a-${nextMsgId}`,
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: callId, name: 'write_file', arguments: { path: 'x.ts' } },
    ],
    createdAt: 0,
  };
}

function mkWriteResult(callId: string, body: string): Message {
  nextMsgId += 1;
  return {
    id: `t-${nextMsgId}`,
    role: 'tool',
    toolName: 'write_file',
    toolCallId: callId,
    content: body,
    createdAt: 0,
  };
}

function buildLongSession(count: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i % 2 === 0) out.push(mkUser(`user msg ${i}`));
    else out.push(mkAssistant(`assistant reply ${i}`));
  }
  return out;
}

// ---------- exports ----------

describe('module exports / cheap-model lookup', () => {
  test('CHEAP_MODEL_BY_BACKEND covers every Backend literal', () => {
    const backends: Backend[] = [
      'openai',
      'openrouter',
      'anthropic',
      'google',
      'ollama',
      'lmstudio',
      'custom',
    ];
    for (const b of backends) {
      expect(b in CHEAP_MODEL_BY_BACKEND).toBe(true);
    }
  });

  test('resolveCheapModel returns correct id per cloud backend', () => {
    expect(resolveCheapModel('openai')).toBe('gpt-4o-mini');
    expect(resolveCheapModel('openrouter')).toBe('openai/gpt-4o-mini');
    expect(resolveCheapModel('anthropic')).toBe('claude-3-5-haiku-latest');
    expect(resolveCheapModel('google')).toBe('gemini-1.5-flash');
  });

  test('resolveCheapModel returns null for local providers', () => {
    expect(resolveCheapModel('ollama')).toBeNull();
    expect(resolveCheapModel('lmstudio')).toBeNull();
    expect(resolveCheapModel('custom')).toBeNull();
  });

  test('exported tuning constants are sensible', () => {
    expect(HEAD_KEEP).toBe(6);
    expect(SUMMARIZE_TAIL_KEEP).toBe(10);
    expect(SUMMARIZE_MIDDLE_MIN).toBe(100);
    expect(TRUNCATE_TAIL_KEEP).toBe(30);
    expect(DEDUP_USEFUL_SAVINGS_TOKENS).toBe(200);
    expect(SUMMARY_MARKER).toBe('[auto-compressed summary]');
  });
});

// ---------- chooseCompressStrategy ----------

describe('chooseCompressStrategy — decision matrix', () => {
  test('small history → dedup (cheap default)', () => {
    const messages = buildLongSession(10);
    const out = chooseCompressStrategy({ backend: 'openai', messages });
    expect(out).toBe('dedup');
  });

  test('large history + cheap model available → summarize', () => {
    const messages = buildLongSession(200);
    expect(chooseCompressStrategy({ backend: 'openai', messages })).toBe('summarize');
    expect(chooseCompressStrategy({ backend: 'openrouter', messages })).toBe('summarize');
    expect(chooseCompressStrategy({ backend: 'anthropic', messages })).toBe('summarize');
    expect(chooseCompressStrategy({ backend: 'google', messages })).toBe('summarize');
  });

  test('large history + no cheap model → truncate (fallback)', () => {
    const messages = buildLongSession(200);
    expect(chooseCompressStrategy({ backend: 'ollama', messages })).toBe('truncate');
    expect(chooseCompressStrategy({ backend: 'lmstudio', messages })).toBe('truncate');
    expect(chooseCompressStrategy({ backend: 'custom', messages })).toBe('truncate');
  });

  test('dedup savings >= 200 tokens override middle-size logic', () => {
    const messages = buildLongSession(200);
    // Even with a huge history + cheap model, big dedup savings keep dedup.
    const out = chooseCompressStrategy({
      backend: 'openai',
      messages,
      dedupSavingsTokens: 500,
    });
    expect(out).toBe('dedup');
  });

  test('dedup savings under 200 tokens do not pin to dedup', () => {
    const messages = buildLongSession(200);
    const out = chooseCompressStrategy({
      backend: 'openai',
      messages,
      dedupSavingsTokens: 50,
    });
    expect(out).toBe('summarize');
  });

  test('boundary: exactly SUMMARIZE_MIDDLE_MIN middle is enough', () => {
    // total = HEAD_KEEP + SUMMARIZE_TAIL_KEEP + SUMMARIZE_MIDDLE_MIN
    const total = HEAD_KEEP + SUMMARIZE_TAIL_KEEP + SUMMARIZE_MIDDLE_MIN;
    const messages = buildLongSession(total);
    expect(chooseCompressStrategy({ backend: 'openai', messages })).toBe('summarize');
  });

  test('boundary: middle just below SUMMARIZE_MIDDLE_MIN → dedup', () => {
    const total = HEAD_KEEP + SUMMARIZE_TAIL_KEEP + SUMMARIZE_MIDDLE_MIN - 1;
    const messages = buildLongSession(total);
    expect(chooseCompressStrategy({ backend: 'openai', messages })).toBe('dedup');
  });
});

// ---------- applyCompressStrategy — dedup ----------

describe('applyCompressStrategy — dedup', () => {
  test('runs the dedup pass and reports tokens removed', async () => {
    const big = 'X'.repeat(400);
    const messages: Message[] = [];
    // 3 reads of `a.ts` — eligible for dedup.
    for (let i = 0; i < 3; i += 1) {
      const callId = `call-${i}`;
      messages.push(mkReadCall('a.ts', callId));
      messages.push(mkReadResult(callId, `${big}#${i}`));
    }
    // Pad to push the early reads out of the recency window.
    for (let i = 0; i < 6; i += 1) messages.push(mkUser(`pad ${i}`));

    const r = await applyCompressStrategy({
      strategy: 'dedup',
      messages,
    });

    expect(r.applied).toBe('dedup');
    expect(r.removedTokens).toBeGreaterThan(0);
    expect(r.messages.length).toBe(messages.length);
    // Verify substitution happened on at least one tool message.
    const substituted = r.messages.filter(
      (m): m is Message =>
        m !== undefined &&
        m.role === 'tool' &&
        typeof m.content === 'string' &&
        m.content.includes('[dedup:'),
    );
    expect(substituted.length).toBeGreaterThan(0);
  });
});

// ---------- applyCompressStrategy — summarize ----------

describe('applyCompressStrategy — summarize', () => {
  test('inserts a system message with [auto-compressed summary] marker', async () => {
    const messages = buildLongSession(150);
    let summarizerCalls = 0;
    const r = await applyCompressStrategy({
      strategy: 'summarize',
      messages,
      summarize: async () => {
        summarizerCalls += 1;
        return 'concise summary of the middle';
      },
    });

    expect(r.applied).toBe('summarize');
    expect(summarizerCalls).toBe(1);
    expect(r.summary).toBe('concise summary of the middle');

    // Exactly one [auto-compressed summary] message must be present.
    const summaryMsgs = r.messages.filter(
      (m): m is Message =>
        m !== undefined &&
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.startsWith(SUMMARY_MARKER),
    );
    expect(summaryMsgs.length).toBe(1);

    // Output must be shorter than the input (compression actually happened).
    expect(r.messages.length).toBeLessThan(messages.length);
    expect(r.removedTokens).toBeGreaterThan(0);
  });

  test('preserves mutating-tool results from the middle verbatim', async () => {
    // Build a 150-msg history with a write_file pair INSIDE the middle.
    const head: Message[] = [];
    for (let i = 0; i < HEAD_KEEP; i += 1) {
      head.push(mkUser(`head ${i}`));
    }
    const middleFiller: Message[] = [];
    for (let i = 0; i < 100; i += 1) middleFiller.push(mkUser(`mid ${i}`));
    const writeCall = mkWriteCall('w-call-1');
    const writeResult = mkWriteResult('w-call-1', 'wrote x.ts (43 lines)');
    const moreMid: Message[] = [];
    for (let i = 0; i < 20; i += 1) moreMid.push(mkUser(`mid2 ${i}`));
    const tail: Message[] = [];
    for (let i = 0; i < SUMMARIZE_TAIL_KEEP; i += 1) tail.push(mkUser(`tail ${i}`));

    const messages: Message[] = [
      ...head,
      ...middleFiller,
      writeCall,
      writeResult,
      ...moreMid,
      ...tail,
    ];

    const r = await applyCompressStrategy({
      strategy: 'summarize',
      messages,
      summarize: async () => 'summary',
    });

    expect(r.applied).toBe('summarize');
    // Mutating-tool messages must STILL appear in the output.
    const writeCallStill = r.messages.find((m) => m.id === writeCall.id);
    const writeResultStill = r.messages.find((m) => m.id === writeResult.id);
    expect(writeCallStill).toBeDefined();
    expect(writeResultStill).toBeDefined();
    expect(writeResultStill?.content).toBe('wrote x.ts (43 lines)');
  });

  test('summariser that throws → falls back to truncate', async () => {
    const messages = buildLongSession(150);
    const r = await applyCompressStrategy({
      strategy: 'summarize',
      messages,
      summarize: async () => {
        throw new Error('cheap model is down');
      },
    });
    expect(r.applied).toBe('truncate');
  });

  test('summariser that returns empty string → falls back to truncate', async () => {
    const messages = buildLongSession(150);
    const r = await applyCompressStrategy({
      strategy: 'summarize',
      messages,
      summarize: async () => '   ',
    });
    expect(r.applied).toBe('truncate');
  });

  test('strategy=summarize WITHOUT a wired summariser → falls back to truncate', async () => {
    const messages = buildLongSession(150);
    const r = await applyCompressStrategy({
      strategy: 'summarize',
      messages,
    });
    expect(r.applied).toBe('truncate');
  });
});

// ---------- applyCompressStrategy — truncate ----------

describe('applyCompressStrategy — truncate', () => {
  test('drops the non-mutating middle', async () => {
    const messages = buildLongSession(200);
    const r = await applyCompressStrategy({
      strategy: 'truncate',
      messages,
    });
    expect(r.applied).toBe('truncate');
    expect(r.messages.length).toBeLessThanOrEqual(HEAD_KEEP + TRUNCATE_TAIL_KEEP);
    expect(r.removedTokens).toBeGreaterThan(0);
  });

  test('keeps short histories untouched (≤ HEAD + tail keep)', async () => {
    const messages = buildLongSession(HEAD_KEEP + TRUNCATE_TAIL_KEEP - 5);
    const r = await applyCompressStrategy({
      strategy: 'truncate',
      messages,
    });
    expect(r.applied).toBe('truncate');
    expect(r.messages.length).toBe(messages.length);
    expect(r.removedTokens).toBe(0);
  });

  test('preserves mutating-tool results even when truncating', async () => {
    // Build: head + filler with mid-write + tail. Total >> HEAD+TRUNCATE_TAIL.
    const head: Message[] = [];
    for (let i = 0; i < HEAD_KEEP; i += 1) head.push(mkUser(`head ${i}`));
    const filler: Message[] = [];
    for (let i = 0; i < 100; i += 1) filler.push(mkUser(`mid ${i}`));
    const writeCall = mkWriteCall('w-1');
    const writeResult = mkWriteResult('w-1', 'committed write');
    const moreFiller: Message[] = [];
    for (let i = 0; i < 50; i += 1) moreFiller.push(mkUser(`mid2 ${i}`));
    const tail: Message[] = [];
    for (let i = 0; i < TRUNCATE_TAIL_KEEP; i += 1) tail.push(mkUser(`tail ${i}`));

    const messages = [
      ...head,
      ...filler,
      writeCall,
      writeResult,
      ...moreFiller,
      ...tail,
    ];

    const r = await applyCompressStrategy({
      strategy: 'truncate',
      messages,
    });
    expect(r.applied).toBe('truncate');
    // Mutating-tool results survive.
    expect(r.messages.find((m) => m.id === writeCall.id)).toBeDefined();
    expect(r.messages.find((m) => m.id === writeResult.id)).toBeDefined();
  });
});

// ---------- realistic 50-message session ----------

describe('realistic compression — token savings on mock session', () => {
  test('50-message session with repeated reads — dedup saves tokens', async () => {
    // Build a realistic-ish session: 8 reads of the same file
    // interspersed with reasoning + 1 actual write at the end.
    const messages: Message[] = [];
    messages.push(mkUser('Please refactor src/app.ts')); // 1
    messages.push(mkAssistant('Let me look at the file first.')); // 2
    // 8 reads of the same file with big bodies (8 KB each) — typical of a
    // model re-reading after each edit suggestion.
    const big = 'L'.repeat(2000);
    for (let i = 0; i < 8; i += 1) {
      const callId = `read-${i}`;
      messages.push(mkReadCall('src/app.ts', callId)); // assistant
      messages.push(mkReadResult(callId, `${big}#${i}`)); // tool
    }
    // Mid reasoning
    for (let i = 0; i < 10; i += 1) messages.push(mkAssistant(`step ${i}`));
    // One mutating tool (write)
    const wcall = mkWriteCall('w-final');
    const wres = mkWriteResult('w-final', 'applied 1 hunk to src/app.ts');
    messages.push(wcall);
    messages.push(wres);
    // Tail chatter — 13 messages
    for (let i = 0; i < 13; i += 1) messages.push(mkUser(`tail ${i}`));

    const r = await applyCompressStrategy({
      strategy: 'dedup',
      messages,
    });

    expect(r.applied).toBe('dedup');
    // Each substituted body was ~2000 bytes → ~500 tokens. We dedup'd
    // 7 of 8 reads (last one preserved, recency window MAY shield more).
    expect(r.removedTokens).toBeGreaterThan(1000);

    // Mutating-tool messages still verbatim.
    const wresStill = r.messages.find((m) => m.id === wres.id);
    expect(wresStill?.content).toBe('applied 1 hunk to src/app.ts');
  });
});
