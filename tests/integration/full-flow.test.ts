import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDb } from '@/sessions/db';
import { SessionManager } from '@/sessions/session-manager';
import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';
import { SkillsManager } from '@/skills/skills-manager';
import { ContextManager } from '@/llm/context-manager';
import type { Message } from '@/types/global';

let tmpDir = '';
let db: Database | null = null;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-integration-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  db = openDb(':memory:');
});

afterEach(async () => {
  try {
    db?.close();
  } catch {
    // ignore
  }
  db = null;
  await rm(tmpDir, { recursive: true, force: true });
});

describe('Integration — module composition', () => {
  test('Config + Session + Skills + Context wire together', async () => {
    // 1. Config round-trip.
    const configPath = path.join(tmpDir, 'config.toml');
    const cfgMgr = new ConfigManager(configPath);
    const cfg = getDefaultConfig('ollama');
    cfg.model.current = 'qwen2.5-coder:32b';
    cfg.model.available = ['qwen2.5-coder:32b'];
    cfg.onboarding.completed = true;
    cfgMgr.write(cfg);
    expect(cfgMgr.read().model.current).toBe('qwen2.5-coder:32b');

    // 2. Session round-trip via in-memory SQLite.
    if (!db) throw new Error('db not initialised');
    const sm = new SessionManager(db);
    const session = sm.createSession(tmpDir, cfg.model.current, cfg.backend.type);
    const userMsg: Message = {
      id: 'u1',
      role: 'user',
      content: 'Hello, LocalCode',
      createdAt: Date.now(),
    };
    sm.addMessage(session.id, userMsg);
    const loaded = sm.getMessages(session.id);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.content).toBe('Hello, LocalCode');

    // 3. Skills: add a skill, activate it, build prompt.
    const skillsDir = path.join(tmpDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
    const skillsMgr = new SkillsManager(skillsDir);
    await skillsMgr.addFromText(
      'typescript.md',
      `---\nname: TypeScript\ndescription: TS rules\n---\nUse strict mode always.`,
    );
    await skillsMgr.toggle('typescript');
    const active = await skillsMgr.getActiveSkills();
    expect(active).toHaveLength(1);

    // 4. Context manager composes LOCALCODE.md + skills into the system prompt.
    const cm = new ContextManager();
    cm.add(userMsg);
    const prompt = cm.buildSystemPrompt('# Project\nLocalCode demo', active);
    expect(prompt).toContain('[PROJECT CONTEXT]');
    expect(prompt).toContain('LocalCode demo');
    expect(prompt).toContain('[ACTIVE SKILLS]');
    expect(prompt).toContain('Use strict mode always.');
    expect(cm.getMessages()).toHaveLength(1);
  });

  test('ContextManager buildSystemPrompt handles absent md + empty skills', () => {
    const cm = new ContextManager();
    const prompt = cm.buildSystemPrompt(null, []);
    expect(prompt).not.toContain('[PROJECT CONTEXT]');
    expect(prompt).not.toContain('[ACTIVE SKILLS]');
  });
});
