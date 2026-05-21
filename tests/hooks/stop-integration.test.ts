/**
 * ChatRuntime ↔ Stop hook wiring.
 *
 * Verifies:
 *   - The `Stop` hook fires only on a plain-text final turn (no
 *     pending tool calls). Intermediate turns that emit a tool call
 *     and then recurse do NOT fire `Stop`.
 *   - Usage snapshot env vars (`LOCALCODE_STOP_USAGE_*`) propagate
 *     into the spawned shell.
 *   - A blocking non-zero exit surfaces a synthetic system note but
 *     does NOT roll back the assistant message already streamed.
 *
 * Uses minimal fakes for the LLM / SessionManager / ToolExecutor.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatRuntime } from '@/web/runtime/chat-runtime';
import { SessionEventBus } from '@/web/runtime/event-bus';
import { ApprovalBridge } from '@/web/runtime/approval-bridge';
import { ContextManager } from '@/llm/context-manager';
import { HookEngine, type HookConfig } from '@/hooks';
import type { LLMAdapter } from '@/llm/adapter';
import type { SessionManager } from '@/sessions/session-manager';
import type { ToolExecutor } from '@/llm/tool-executor';
import type { ToolCall } from '@/types/global';

function makeFakeSessionManager(): SessionManager {
  return {
    addMessage: () => undefined,
    getMessages: () => [],
    getSession: () => null,
  } as unknown as SessionManager;
}

function makePassThroughToolExecutor(): ToolExecutor {
  return {
    execute: async () => ({ success: true, output: 'ok' }),
  } as unknown as ToolExecutor;
}

interface LLMScript {
  /** Each entry is one turn the fake LLM will play in order. */
  turns: Array<
    | { kind: 'tool'; calls: ToolCall[] }
    | {
        kind: 'final';
        text: string;
        usage?: {
          promptTokens?: number;
          completionTokens?: number;
          cachedInputTokens?: number;
        };
      }
  >;
}

function makeScriptedLLM(script: LLMScript): {
  streamChat: LLMAdapter['streamChat'];
} {
  let idx = 0;
  return {
    streamChat: (async (opts) => {
      const turn = script.turns[idx];
      idx += 1;
      if (turn === undefined) {
        opts.onDone?.({ finishReason: 'stop' });
        return;
      }
      if (turn.kind === 'tool') {
        opts.onToolCalls?.(turn.calls);
        opts.onDone?.({ finishReason: 'tool_calls' });
        return;
      }
      // final
      opts.onChunk?.(turn.text);
      opts.onDone?.({
        finishReason: 'stop',
        ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
      });
    }) as LLMAdapter['streamChat'],
  };
}

function buildRuntime(opts: {
  hooks: HookConfig[];
  script: LLMScript;
  projectRoot?: string;
}): { runtime: ChatRuntime; events: unknown[] } {
  const events: unknown[] = [];
  const eventBus = new SessionEventBus();
  eventBus.subscribe('s1', (m) => events.push(m));
  return {
    runtime: new ChatRuntime({
      sessionId: 's1',
      tools: [],
      buildSystemMessage: () => ({
        id: 'sys-0',
        role: 'system',
        content: 'sys',
        createdAt: 0,
      }),
      maxContextTokens: 100_000,
      autoCompressPercent: 0.95,
      maxRecentMessages: 0,
      llm: makeScriptedLLM(opts.script),
      toolExecutor: makePassThroughToolExecutor(),
      contextManager: new ContextManager(),
      sessionManager: makeFakeSessionManager(),
      eventBus,
      approvalBridge: new ApprovalBridge({ timeoutMs: 60_000 }),
      hookEngine: new HookEngine({ hooks: opts.hooks }),
      projectRoot: opts.projectRoot ?? process.cwd(),
    }),
    events,
  };
}

describe('ChatRuntime Stop — fires only on plain-text final turn', () => {
  test('intermediate tool-call turn does NOT fire Stop', async () => {
    // Write a marker file ONLY when the Stop hook fires. Since we want
    // to verify it does NOT fire on the tool turn AND DOES fire on the
    // final turn, the marker should be written exactly once.
    const root = mkdtempSync(join(tmpdir(), 'lc-stop-test-'));
    const markerPath = join(root, 'stop-fired.txt');

    const { runtime, events } = buildRuntime({
      script: {
        turns: [
          // Turn 1: tool call (recurses).
          { kind: 'tool', calls: [{ id: 't-1', name: 'noop', arguments: {} }] },
          // Turn 2: plain-text final.
          { kind: 'final', text: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
        ],
      },
      hooks: [
        {
          trigger: 'Stop',
          command: `printf "%s" stop-fired >> "${markerPath}"`,
          blocking: false,
        },
      ],
      projectRoot: root,
    });

    await runtime.sendUserMessage('hi', 'r-1');

    // Final `done` event should appear.
    const done = events.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'done',
    );
    expect(done).toBeDefined();

    // Marker file contents: "stop-fired" exactly once (single hook fire).
    let marker = '';
    try {
      marker = readFileSync(markerPath, 'utf8');
    } catch {
      marker = '';
    }
    expect(marker).toBe('stop-fired');
  });

  test('multiple intermediate tool turns still produce exactly one Stop fire', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lc-stop-test-'));
    const markerPath = join(root, 'stop-fired.txt');
    writeFileSync(markerPath, '');

    const { runtime } = buildRuntime({
      script: {
        turns: [
          { kind: 'tool', calls: [{ id: 't-1', name: 'noop', arguments: {} }] },
          { kind: 'tool', calls: [{ id: 't-2', name: 'noop', arguments: {} }] },
          { kind: 'tool', calls: [{ id: 't-3', name: 'noop', arguments: {} }] },
          { kind: 'final', text: 'finished' },
        ],
      },
      hooks: [
        {
          trigger: 'Stop',
          command: `printf "x" >> "${markerPath}"`,
          blocking: false,
        },
      ],
      projectRoot: root,
    });

    await runtime.sendUserMessage('hi', 'r-1');

    const marker = readFileSync(markerPath, 'utf8');
    // Exactly one fire — three tool turns + one final, only the final hits Stop.
    expect(marker).toBe('x');
  });
});

describe('ChatRuntime Stop — env propagation', () => {
  test('LOCALCODE_STOP_USAGE_* env vars carry the last turn’s usage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lc-stop-test-'));
    const dumpPath = join(root, 'usage.txt');

    const { runtime } = buildRuntime({
      script: {
        turns: [
          {
            kind: 'final',
            text: 'hello',
            usage: {
              promptTokens: 1234,
              completionTokens: 567,
              cachedInputTokens: 89,
            },
          },
        ],
      },
      hooks: [
        {
          trigger: 'Stop',
          command: `printf "p=%s c=%s ch=%s" "$LOCALCODE_STOP_USAGE_PROMPT" "$LOCALCODE_STOP_USAGE_COMPLETION" "$LOCALCODE_STOP_USAGE_CACHED" > "${dumpPath}"`,
          blocking: false,
        },
      ],
      projectRoot: root,
    });

    await runtime.sendUserMessage('hi', 'r-1');

    const dump = readFileSync(dumpPath, 'utf8');
    expect(dump).toBe('p=1234 c=567 ch=89');
  });
});

describe('ChatRuntime Stop — blocking outcome surfaces synthetic note', () => {
  test('blocking non-zero exit appends "Stop hook flagged:" system message', async () => {
    const { runtime, events } = buildRuntime({
      script: {
        turns: [
          {
            kind: 'final',
            text: 'final reply',
            usage: { promptTokens: 1, completionTokens: 1 },
          },
        ],
      },
      hooks: [
        {
          trigger: 'Stop',
          command: 'echo "bad bad bad" >&2; exit 1',
          blocking: true,
        },
      ],
    });

    await runtime.sendUserMessage('hi', 'r-1');

    // Should have BOTH the original assistant reply (committed) AND a
    // synthetic system note announcing the block.
    const assistant = events.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'message_committed' &&
        (e as { message?: { role?: string } }).message?.role === 'assistant',
    );
    expect(assistant).toBeDefined();

    const flag = events.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'message_committed' &&
        (e as { message?: { role?: string } }).message?.role === 'system' &&
        typeof (e as { message?: { content?: string } }).message?.content ===
          'string' &&
        (e as { message: { content: string } }).message.content.startsWith(
          'Stop hook flagged:',
        ),
    );
    expect(flag).toBeDefined();
  });
});

describe('ChatRuntime Stop — no hook configured leaves flow unchanged', () => {
  test('plain-text turn emits done without any Stop processing', async () => {
    const { runtime, events } = buildRuntime({
      script: {
        turns: [{ kind: 'final', text: 'reply' }],
      },
      hooks: [],
    });

    await runtime.sendUserMessage('hi', 'r-1');

    const done = events.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'done',
    );
    expect(done).toBeDefined();
    // No synthetic system note about a Stop hook.
    const stopNote = events.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'message_committed' &&
        (e as { message?: { role?: string } }).message?.role === 'system' &&
        typeof (e as { message?: { content?: string } }).message?.content ===
          'string' &&
        (e as { message: { content: string } }).message.content.startsWith(
          'Stop hook flagged:',
        ),
    );
    expect(stopNote).toBeUndefined();
  });
});
