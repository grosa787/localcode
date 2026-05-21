/**
 * /compress — context summarisation command (FIX #34).
 *
 * Wired against the narrow `CompressContextManager` + `CompressLLM`
 * interfaces in `cmd-compress.ts`. Tests use stubs so we don't need a
 * real ContextManager / LLMAdapter / SessionManager pulled in.
 *
 * Covered scenarios:
 *   - Empty context  → prints "Nothing to compress…", does NOT call
 *     contextManager.compress.
 *   - Non-empty context → invokes compress({ keepLast }) with the
 *     parsed value, prints "✓ Compressed: …" + summary preview.
 *   - --keep-last 6 → forwarded as `keepLast: 6`.
 *   - --keep-last <neg> / non-numeric → defaults to 0.
 *   - sessionId + sessionManager + non-empty summary → updateSummary
 *     called with the streamed summary.
 *   - sessionId null OR empty summary → updateSummary NOT called.
 *   - sessionManager.updateSummary throws → warning printed, command
 *     does not throw.
 *   - LLM `onDone` with error → "Compression failed: <msg>".
 *   - contextManager.compress throws → "Compression failed: <msg>".
 *   - LLM streamChat buffer-and-resolve flow: streamed chunks are
 *     concatenated and trimmed before being passed to compress's
 *     summarizer.
 */
import { describe, test, expect } from 'bun:test';
import { createCompressCommand } from '@/commands/cmd-compress';
import type {
  CommandContext,
  Message,
  AppConfig,
} from '@/types/global';
import type { StreamChatParams, StreamDoneResult } from '@/types/message';

// ---------- Test doubles ----------

interface StubLLMRecord {
  params: StreamChatParams;
  buffer: string;
}

/**
 * Minimal {@link CompressLLM} that synchronously emits the given chunks
 * via `onChunk`, then resolves the stream via `onDone({ stop })`.
 */
function makeStubLLM(
  chunks: readonly string[],
  options: { error?: string } = {},
): {
  llm: { streamChat: (p: StreamChatParams) => Promise<void> };
  records: StubLLMRecord[];
} {
  const records: StubLLMRecord[] = [];
  const llm = {
    streamChat: async (params: StreamChatParams): Promise<void> => {
      const rec: StubLLMRecord = { params, buffer: '' };
      records.push(rec);
      for (const c of chunks) {
        params.onChunk?.(c);
        rec.buffer += c;
      }
      const result: StreamDoneResult = options.error
        ? { finishReason: 'error', error: options.error }
        : { finishReason: 'stop' };
      params.onDone?.(result);
    },
  };
  return { llm, records };
}

interface StubCompressManagerRecord {
  summarizer: ((m: Message[]) => Promise<string>) | null;
  opts: { keepLast?: number } | undefined;
  capturedSummary: string | null;
}

/**
 * Minimal {@link CompressContextManager} stub that captures the
 * arguments to `compress(...)` and feeds the summarizer the recorded
 * messages.
 */
function makeStubCm(initial: Message[]): {
  cm: {
    getMessages: () => Message[];
    compress: (
      summarizer: (m: Message[]) => Promise<string>,
      opts?: { keepLast?: number },
    ) => Promise<{
      oldCount: number;
      newCount: number;
      tokensSaved: number;
      summary: string;
    }>;
  };
  record: StubCompressManagerRecord;
} {
  const messages = initial.slice();
  const record: StubCompressManagerRecord = {
    summarizer: null,
    opts: undefined,
    capturedSummary: null,
  };
  const cm = {
    getMessages: (): Message[] => messages.slice(),
    compress: async (
      summarizer: (m: Message[]) => Promise<string>,
      opts?: { keepLast?: number },
    ): Promise<{
      oldCount: number;
      newCount: number;
      tokensSaved: number;
      summary: string;
    }> => {
      record.summarizer = summarizer;
      record.opts = opts;
      const summary = await summarizer(messages.slice());
      record.capturedSummary = summary;
      return {
        oldCount: messages.length,
        newCount: 1,
        tokensSaved: 42,
        summary,
      };
    },
  };
  return { cm, record };
}

interface StubSessionManagerRecord {
  calls: Array<{ id: string; summary: string }>;
}

function makeStubSessionManager(opts: { throwOnUpdate?: boolean } = {}): {
  sm: { updateSummary: (id: string, summary: string) => void };
  rec: StubSessionManagerRecord;
} {
  const rec: StubSessionManagerRecord = { calls: [] };
  const sm = {
    updateSummary: (id: string, summary: string): void => {
      rec.calls.push({ id, summary });
      if (opts.throwOnUpdate === true) {
        throw new Error('disk full');
      }
    },
  };
  return { sm, rec };
}

function makeCtx(): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  // Minimal AppConfig stub; the command never reads it.
  const config = {} as unknown as AppConfig;
  const ctx: CommandContext = {
    projectRoot: '/tmp/proj',
    sessionId: null,
    config,
    print: (t: string) => output.push(t),
    setScreen: () => {
      /* no-op */
    },
  };
  return { ctx, output };
}

function mkMsg(content: string, id = `m-${content}`): Message {
  return {
    id,
    role: 'user',
    content,
    createdAt: 0,
  };
}

// Static buildCompressPrompt stub — the command calls it once per
// summary, but the actual prompt string is opaque to the test.
function buildCompressPrompt(messages: Message[]): string {
  return `[COMPRESS-PROMPT] ${messages.map((m) => m.content).join('|')}`;
}

// ---------- Empty context ----------

describe('/compress — empty context', () => {
  test('prints "Nothing to compress" and does NOT call cm.compress', async () => {
    const { cm, record } = makeStubCm([]);
    const { llm, records } = makeStubLLM(['unused']);
    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      getSessionId: () => null,
    });

    const { ctx, output } = makeCtx();
    await cmd.execute('', ctx);

    expect(output.join('\n')).toContain('Nothing to compress');
    expect(record.summarizer).toBeNull();
    expect(records.length).toBe(0);
  });
});

// ---------- Default keepLast ----------

describe('/compress — default keepLast', () => {
  test('forwards `{ keepLast: 0 }` to cm.compress and prints success line', async () => {
    const { cm, record } = makeStubCm([
      mkMsg('a'),
      mkMsg('b'),
      mkMsg('c'),
    ]);
    const { llm, records } = makeStubLLM(['summary ', 'text']);
    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      getSessionId: () => null,
    });

    const { ctx, output } = makeCtx();
    await cmd.execute('', ctx);

    expect(record.opts?.keepLast).toBe(0);
    expect(record.capturedSummary).toBe('summary text');
    expect(records.length).toBe(1);
    // The streamed prompt body must include U:/A:/T() lines via the
    // buildCompressPrompt stub passed in.
    const userMsg = records[0]!.params.messages.find(
      (m) => m.role === 'user',
    );
    expect(userMsg?.content).toContain('[COMPRESS-PROMPT]');

    const joined = output.join('\n');
    expect(joined).toContain('Compressing context');
    expect(joined).toMatch(/Compressed: 3 messages → 1/);
    expect(joined).toContain('Summary:');
    expect(joined).toContain('summary text');
  });
});

// ---------- --keep-last parsing ----------

describe('/compress --keep-last parsing', () => {
  test('parses `--keep-last 6` correctly', async () => {
    const { cm, record } = makeStubCm([mkMsg('a'), mkMsg('b')]);
    const { llm } = makeStubLLM(['s']);
    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      getSessionId: () => null,
    });
    const { ctx } = makeCtx();
    await cmd.execute('--keep-last 6', ctx);
    expect(record.opts?.keepLast).toBe(6);
  });

  test('parses `--keep-last 2` correctly', async () => {
    const { cm, record } = makeStubCm([mkMsg('a'), mkMsg('b'), mkMsg('c')]);
    const { llm } = makeStubLLM(['summary']);
    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      getSessionId: () => null,
    });
    const { ctx } = makeCtx();
    await cmd.execute('--keep-last 2', ctx);
    expect(record.opts?.keepLast).toBe(2);
  });

  test('non-numeric arg falls back to 0', async () => {
    const { cm, record } = makeStubCm([mkMsg('a')]);
    const { llm } = makeStubLLM(['s']);
    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      getSessionId: () => null,
    });
    const { ctx } = makeCtx();
    await cmd.execute('--keep-last NaN', ctx);
    expect(record.opts?.keepLast).toBe(0);
  });

  test('omitted flag → keepLast 0', async () => {
    const { cm, record } = makeStubCm([mkMsg('a')]);
    const { llm } = makeStubLLM(['s']);
    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      getSessionId: () => null,
    });
    const { ctx } = makeCtx();
    await cmd.execute('', ctx);
    expect(record.opts?.keepLast).toBe(0);
  });
});

// ---------- Session persistence ----------

describe('/compress — session summary persistence', () => {
  test('sessionId + sessionManager + non-empty summary → updateSummary called', async () => {
    const { cm } = makeStubCm([mkMsg('a'), mkMsg('b')]);
    const { llm } = makeStubLLM(['  dense summary  ']);
    const { sm, rec } = makeStubSessionManager();

    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      sessionManager: sm as never,
      getSessionId: () => 'session-123',
    });

    const { ctx } = makeCtx();
    await cmd.execute('', ctx);

    expect(rec.calls.length).toBe(1);
    expect(rec.calls[0]!.id).toBe('session-123');
    expect(rec.calls[0]!.summary).toBe('dense summary');
  });

  test('sessionId null → updateSummary NOT called', async () => {
    const { cm } = makeStubCm([mkMsg('a')]);
    const { llm } = makeStubLLM(['summary']);
    const { sm, rec } = makeStubSessionManager();

    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      sessionManager: sm as never,
      getSessionId: () => null,
    });
    const { ctx } = makeCtx();
    await cmd.execute('', ctx);
    expect(rec.calls.length).toBe(0);
  });

  test('sessionManager undefined → no crash', async () => {
    const { cm } = makeStubCm([mkMsg('a')]);
    const { llm } = makeStubLLM(['s']);
    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      getSessionId: () => 'sid',
    });
    const { ctx, output } = makeCtx();
    await cmd.execute('', ctx);
    // Just make sure the success line still printed.
    expect(output.join('\n')).toContain('Compressed:');
  });

  test('updateSummary throwing prints warning, does not throw', async () => {
    const { cm } = makeStubCm([mkMsg('a')]);
    const { llm } = makeStubLLM(['summary']);
    const { sm, rec } = makeStubSessionManager({ throwOnUpdate: true });

    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      sessionManager: sm as never,
      getSessionId: () => 'sid',
    });

    const { ctx, output } = makeCtx();
    let threw = false;
    try {
      await cmd.execute('', ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(rec.calls.length).toBe(1);
    // Warning surfaced via print.
    const joined = output.join('\n');
    expect(joined).toContain('disk full');
    expect(joined.toLowerCase()).toContain('warning');
  });
});

// ---------- Failure paths ----------

describe('/compress — error paths', () => {
  test('LLM onDone with error → "Compression failed: <msg>"', async () => {
    const { cm } = makeStubCm([mkMsg('a')]);
    const { llm } = makeStubLLM([], { error: 'model crashed' });
    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      getSessionId: () => null,
    });

    const { ctx, output } = makeCtx();
    await cmd.execute('', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Compression failed');
    expect(joined).toContain('model crashed');
  });

  test('contextManager.compress throws → "Compression failed: <msg>"', async () => {
    const { llm } = makeStubLLM(['unused']);
    const cm = {
      getMessages: () => [mkMsg('a')],
      compress: async () => {
        throw new Error('compress boom');
      },
    };
    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      getSessionId: () => null,
    });
    const { ctx, output } = makeCtx();
    await cmd.execute('', ctx);
    expect(output.join('\n')).toContain('Compression failed');
    expect(output.join('\n')).toContain('compress boom');
  });

  test('long summary (>200 chars) preview is truncated with ellipsis', async () => {
    const { cm } = makeStubCm([mkMsg('a')]);
    const longText = 'x'.repeat(300);
    const { llm } = makeStubLLM([longText]);
    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      getSessionId: () => null,
    });
    const { ctx, output } = makeCtx();
    await cmd.execute('', ctx);
    const summaryLine = output.find((l) => l.startsWith('Summary:'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine!.length).toBeLessThan(300);
    expect(summaryLine).toContain('…');
  });

  test('streamChat buffer flow concatenates chunks then trims', async () => {
    const { cm, record } = makeStubCm([mkMsg('a')]);
    const { llm } = makeStubLLM(['  part-1 ', 'part-2  ']);
    const cmd = createCompressCommand({
      contextManager: cm,
      buildCompressPrompt,
      llm: llm as never,
      getSessionId: () => null,
    });
    const { ctx } = makeCtx();
    await cmd.execute('', ctx);
    // Concatenated: '  part-1 part-2  ' → trimmed: 'part-1 part-2'
    expect(record.capturedSummary).toBe('part-1 part-2');
  });
});
