/**
 * Integration — compose ConfigManager + SkillsManager (two-source) +
 * ContextManager + SessionManager with telemetry + SlashRegistry with
 * R2 commands. Run a synthetic submit → approve → summarise flow using
 * stubs. Assert invariants: no real LLM calls, no real network fetch,
 * and every piece persists correctly across the boundary.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import { ConfigManager } from '@/config/config-manager';
import { SkillsManager } from '@/skills/skills-manager';
import { ContextManager } from '@/llm/context-manager';
import { ToolExecutor } from '@/llm/tool-executor';
import { getDefaultConfig } from '@/config/defaults';
import { SlashRegistry } from '@/commands/slash-registry';
import { createPermissionsCommand } from '@/commands/cmd-permissions';
import { createCtxSizeCommand } from '@/commands/cmd-ctxsize';
import { createNewSkillCommand } from '@/commands/cmd-new-skill';
import type {
  AppConfig,
  CommandContext,
  Message,
  Screen,
  ToolCall,
  ToolResult,
} from '@/types/global';
import type { ToolHandlerMap } from '@/types/message';

let scratchRoot = '';
let projectRoot = '';
let globalDir = '';
let configPath = '';
let db: Database | null = null;
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  scratchRoot = path.join(os.tmpdir(), `lc-r2-integration-${crypto.randomUUID()}`);
  projectRoot = path.join(scratchRoot, 'proj');
  globalDir = path.join(scratchRoot, 'global-home', 'skills');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(globalDir, { recursive: true });
  configPath = path.join(projectRoot, 'config.toml');
  db = openDb(':memory:');

  // Sentinel fetch that throws if any code ever hits the network.
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network call not allowed in this test');
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  try {
    db?.close();
  } catch {
    // ignore
  }
  db = null;
  await rm(scratchRoot, { recursive: true, force: true });
});

function buildCtx(cfgMgr: ConfigManager): {
  ctx: CommandContext;
  output: string[];
} {
  const output: string[] = [];
  const config: AppConfig = cfgMgr.read();
  const ctx: CommandContext = {
    projectRoot,
    sessionId: null,
    config,
    print: (t) => output.push(t),
    setScreen: (_screen: Screen) => {
      /* no-op */
    },
  };
  return { ctx, output };
}

describe('R2 integration — everything wired together', () => {
  test('submit → approve → summarise end-to-end with stubs', async () => {
    if (!db) throw new Error('db not set');

    // 1. ConfigManager with baseline config.
    const cfgMgr = new ConfigManager(configPath);
    const base = getDefaultConfig('ollama');
    base.model.current = 'qwen2.5-coder:32b';
    base.model.available = ['qwen2.5-coder:32b'];
    base.onboarding.completed = true;
    cfgMgr.write(base);

    // 2. Two-source SkillsManager, add both project-local and global skills.
    const skillsMgr = new SkillsManager({ projectRoot, globalDir });
    await skillsMgr.addFromText(
      'p1.md',
      `---\nname: P1\ndescription: project\n---\nBODY-P1`,
      { scope: 'project' },
    );
    await skillsMgr.addFromText(
      'g1.md',
      `---\nname: G1\ndescription: global\n---\nBODY-G1`,
      { scope: 'global' },
    );
    // Activate the project one.
    await skillsMgr.toggle('p1');

    const all = await skillsMgr.list();
    const p1 = all.find((s) => s.id === 'p1');
    const g1 = all.find((s) => s.id === 'g1');
    expect(p1?.source).toBe('project');
    expect(g1?.source).toBe('global');

    // 3. Register R2 slash commands.
    const registry = new SlashRegistry();
    let overlayCalls = 0;
    registry.register(createPermissionsCommand({ configManager: cfgMgr }));
    registry.register(createCtxSizeCommand({ configManager: cfgMgr }));
    registry.register(
      createNewSkillCommand({
        skillsManager: skillsMgr,
        openSkillOverlay: () => {
          overlayCalls += 1;
        },
      }),
    );

    // 4. Run /permissions add write_file — writes through ConfigManager.
    const permCmd = registry.get('permissions');
    expect(permCmd).not.toBeNull();
    const { ctx } = buildCtx(cfgMgr);
    await permCmd!.execute('add write_file', ctx);
    expect(cfgMgr.read().permissions.autoApprove).toEqual(['write_file']);

    // 5. Run /ctxsize 32768 — updates context.maxTokens.
    const ctxCmd = registry.get('ctxsize');
    expect(ctxCmd).not.toBeNull();
    await ctxCmd!.execute('32768', buildCtx(cfgMgr).ctx);
    expect(cfgMgr.read().context.maxTokens).toBe(32768);

    // 6. Run /new-skill — calls overlay.
    const nsCmd = registry.get('new-skill');
    expect(nsCmd).not.toBeNull();
    await nsCmd!.execute('', buildCtx(cfgMgr).ctx);
    expect(overlayCalls).toBe(1);

    // 7. ToolExecutor consumes permissions to bypass approval for write_file.
    let approvalCalls = 0;
    const toolHandlers: ToolHandlerMap = {
      write_file: async (_args) =>
        ({ success: true, output: 'STUBBED_WRITE_OK' }) satisfies ToolResult,
      run_command: async () =>
        ({ success: true, output: 'STUBBED_CMD_OK' }) satisfies ToolResult,
    };
    const executor = new ToolExecutor({
      handlers: toolHandlers,
      approvalCallback: async () => {
        approvalCalls += 1;
        return true;
      },
      autoApproveTools: cfgMgr.read().permissions.autoApprove,
    });
    const call: ToolCall = {
      id: 'c1',
      name: 'write_file',
      arguments: { path: 'x.ts', content: '' },
    };
    const res = await executor.execute(call);
    expect(res.success).toBe(true);
    // write_file was in autoApprove list — approval callback MUST NOT fire.
    expect(approvalCalls).toBe(0);

    // 8. SessionManager persists telemetry; ContextManager tracks usage.
    const sm = new SessionManager(db);
    const session = sm.createSession(
      projectRoot,
      cfgMgr.read().model.current,
      cfgMgr.read().backend.type,
    );
    const userMsg: Message = {
      id: 'u1',
      role: 'user',
      content: 'Please refactor auth.ts',
      createdAt: Date.now(),
    };
    sm.addMessage(session.id, userMsg);
    const assistantMsg: Message = {
      id: 'a1',
      role: 'assistant',
      content: 'Done — refactored.',
      createdAt: Date.now(),
    };
    sm.addMessage(session.id, assistantMsg, {
      tokensInput: 120,
      tokensOutput: 42,
      durationMs: 1500,
    });

    const stats = sm.getSessionStats(session.id);
    expect(stats.messageCount).toBe(2);
    expect(stats.totalTokensInput).toBe(120);
    expect(stats.totalTokensOutput).toBe(42);
    expect(stats.totalDurationMs).toBe(1500);

    // 9. Summarisation via stub (no real LLM) + persistence to session.summary.
    const cmCtx = new ContextManager();
    cmCtx.add(userMsg);
    cmCtx.add(assistantMsg);
    cmCtx.recordUsage(120, 42);
    expect(cmCtx.sessionTokensIn).toBe(120);
    expect(cmCtx.sessionTokensOut).toBe(42);

    let summariserCalls = 0;
    let receivedCount = 0;
    const summary = await cmCtx.generateSummary(async (msgs) => {
      summariserCalls += 1;
      receivedCount = msgs.length;
      return 'Refactored auth module; 2 files touched';
    });
    expect(summariserCalls).toBe(1);
    expect(receivedCount).toBe(2);
    expect(summary).toBe('Refactored auth module; 2 files touched');
    sm.updateSummary(session.id, summary);
    expect(sm.getSession(session.id)?.summary).toBe(summary);

    // 10. Next time /resume would load — buildSystemPrompt with summary injects it.
    const cmResume = new ContextManager();
    const activeSkills = await skillsMgr.getActiveSkills();
    const prompt = cmResume.buildSystemPrompt({
      localcodeMd: null,
      skills: activeSkills,
      summary: sm.getSession(session.id)?.summary ?? null,
    });
    expect(prompt).toContain('Conversation summary');
    expect(prompt).toContain('Refactored auth module');
    expect(prompt).toContain('BODY-P1');
    expect(prompt).not.toContain('BODY-G1'); // g1 not toggled active
  });

  test('no LLM / network call happens across the whole flow', async () => {
    if (!db) throw new Error('db not set');
    const cfgMgr = new ConfigManager(configPath);
    const base = getDefaultConfig('lmstudio');
    base.model.current = 'x';
    base.model.available = ['x'];
    base.onboarding.completed = true;
    cfgMgr.write(base);

    const skillsMgr = new SkillsManager({ projectRoot, globalDir });
    const registry = new SlashRegistry();
    registry.register(createPermissionsCommand({ configManager: cfgMgr }));
    registry.register(createCtxSizeCommand({ configManager: cfgMgr }));
    registry.register(
      createNewSkillCommand({
        skillsManager: skillsMgr,
        openSkillOverlay: () => {
          /* noop */
        },
      }),
    );

    // Run every R2 command — none should touch the network.
    await registry
      .get('permissions')!
      .execute('list', buildCtx(cfgMgr).ctx);
    await registry
      .get('ctxsize')!
      .execute('', buildCtx(cfgMgr).ctx);
    await registry
      .get('new-skill')!
      .execute('', buildCtx(cfgMgr).ctx);
    // No network errors raised => invariant holds. (Our fetch sentinel
    // throws — if any of the above called fetch, the promise would have
    // rejected.)
    expect(true).toBe(true);
  });
});
