import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPlanCommand,
  type PlanLLM,
  type PlanContextManager,
} from '@/commands/cmd-plan';
import type { AppConfig, CommandContext, Message } from '@/types/global';

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-plan-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeCtx(printedLines: string[]): CommandContext {
  return {
    projectRoot: tmpRoot,
    sessionId: null,
    config: {} as AppConfig,
    print: (s) => {
      printedLines.push(s);
    },
    setScreen: () => {},
  };
}

const fakeCm: PlanContextManager = {
  buildSystemPrompt(): string {
    return 'BASE-SYSTEM';
  },
};

describe('createPlanCommand', () => {
  test('rejects empty args with usage hint', async () => {
    const printed: string[] = [];
    const llm: PlanLLM = {
      async streamChat() {
        throw new Error('should not be called');
      },
    };
    const cmd = createPlanCommand({
      llm,
      contextManager: fakeCm,
      readLocalcodeMd: () => null,
    });
    await cmd.execute('   ', makeCtx(printed));
    expect(printed.join('\n')).toContain('Usage: /plan');
  });

  test('streams plan to chat and writes a markdown file', async () => {
    const printed: string[] = [];
    const llm: PlanLLM = {
      async streamChat({ onChunk, onDone }) {
        onChunk?.('## Files\n');
        onChunk?.('- src/foo.ts: new\n');
        onDone?.({ error: undefined });
      },
    };
    const cmd = createPlanCommand({
      llm,
      contextManager: fakeCm,
      readLocalcodeMd: () => null,
    });
    await cmd.execute('add /usage command', makeCtx(printed));

    const plansDir = path.join(tmpRoot, '.localcode', 'plans');
    expect(existsSync(plansDir)).toBe(true);
    const files = readdirSync(plansDir);
    expect(files).toHaveLength(1);
    const planContents = readFileSync(path.join(plansDir, files[0] ?? ''), 'utf8');
    expect(planContents).toContain('# Plan: add /usage command');
    expect(planContents).toContain('## Files');
    expect(planContents).toContain('src/foo.ts');
  });

  test('echoes the approve prompt + plan path on success', async () => {
    const printed: string[] = [];
    const llm: PlanLLM = {
      async streamChat({ onChunk, onDone }) {
        onChunk?.('plan body\n');
        onDone?.({ error: undefined });
      },
    };
    const cmd = createPlanCommand({
      llm,
      contextManager: fakeCm,
      readLocalcodeMd: () => null,
    });
    await cmd.execute('do thing', makeCtx(printed));
    const all = printed.join('\n');
    expect(all).toContain('Approve this plan?');
    expect(all).toContain('Plan saved to');
  });

  test('reports stream error and does not write a plan', async () => {
    const printed: string[] = [];
    const llm: PlanLLM = {
      async streamChat({ onDone }) {
        onDone?.({ error: 'network down' });
      },
    };
    const cmd = createPlanCommand({
      llm,
      contextManager: fakeCm,
      readLocalcodeMd: () => null,
    });
    await cmd.execute('do thing', makeCtx(printed));
    expect(printed.join('\n')).toContain('LLM stream ended with error: network down');
    expect(existsSync(path.join(tmpRoot, '.localcode', 'plans'))).toBe(false);
  });

  test('handles empty stream gracefully', async () => {
    const printed: string[] = [];
    const llm: PlanLLM = {
      async streamChat({ onDone }) {
        onDone?.({});
      },
    };
    const cmd = createPlanCommand({
      llm,
      contextManager: fakeCm,
      readLocalcodeMd: () => null,
    });
    await cmd.execute('do thing', makeCtx(printed));
    expect(printed.join('\n')).toContain('empty plan');
  });

  test('uses the system prompt from the context manager + planning suffix', async () => {
    const printed: string[] = [];
    let receivedSystem: Message | undefined;
    const llm: PlanLLM = {
      async streamChat({ messages, onDone }) {
        receivedSystem = messages.find((m) => m.role === 'system');
        onDone?.({});
      },
    };
    const cmd = createPlanCommand({
      llm,
      contextManager: fakeCm,
      readLocalcodeMd: () => 'PROJECT-MD',
    });
    await cmd.execute('something', makeCtx(printed));
    expect(receivedSystem?.content).toContain('BASE-SYSTEM');
    expect(receivedSystem?.content).toContain('senior software engineer');
  });
});
