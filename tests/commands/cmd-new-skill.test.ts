/**
 * /new-skill — thin glue that opens the skill-input overlay and prints
 * the default save location.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNewSkillCommand } from '@/commands/cmd-new-skill';
import { SkillsManager } from '@/skills/skills-manager';
import type { AppConfig, CommandContext } from '@/types/global';
import { getDefaultConfig } from '@/config/defaults';

let scratchRoot = '';
let projectRoot = '';
let globalDir = '';

beforeEach(async () => {
  scratchRoot = path.join(os.tmpdir(), `lc-newskill-${crypto.randomUUID()}`);
  projectRoot = path.join(scratchRoot, 'proj');
  globalDir = path.join(scratchRoot, 'global-home', 'skills');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(globalDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

function buildCtx(): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  const ctx: CommandContext = {
    projectRoot,
    sessionId: null,
    config,
    print: (t) => output.push(t),
    setScreen: () => {
      /* no-op */
    },
  };
  return { ctx, output };
}

describe('/new-skill', () => {
  test('invokes openSkillOverlay exactly once', async () => {
    const skillsMgr = new SkillsManager({ projectRoot, globalDir });
    let calls = 0;
    const cmd = createNewSkillCommand({
      skillsManager: skillsMgr,
      openSkillOverlay: () => {
        calls += 1;
      },
    });
    const { ctx } = buildCtx();
    await cmd.execute('', ctx);
    expect(calls).toBe(1);
  });

  test('prints hint with the project-local save directory', async () => {
    const skillsMgr = new SkillsManager({ projectRoot, globalDir });
    const cmd = createNewSkillCommand({
      skillsManager: skillsMgr,
      openSkillOverlay: () => {
        /* noop */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);

    const joined = output.join('\n');
    expect(joined).toContain('Default save location');
    expect(joined).toContain(path.join(projectRoot, '.localcode', 'skills'));
  });

  test('falls back to global directory when no projectRoot is configured', async () => {
    const skillsMgr = new SkillsManager({ globalDir });
    const cmd = createNewSkillCommand({
      skillsManager: skillsMgr,
      openSkillOverlay: () => {
        /* noop */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    const joined = output.join('\n');
    expect(joined).toContain(globalDir);
  });

  test('propagates a failure to open the overlay into a printed error', async () => {
    const skillsMgr = new SkillsManager({ projectRoot, globalDir });
    const cmd = createNewSkillCommand({
      skillsManager: skillsMgr,
      openSkillOverlay: () => {
        throw new Error('overlay-init-failed');
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Failed to open skill overlay');
    expect(joined).toContain('overlay-init-failed');
    // Must not leak the "Opening…" message when the overlay failed.
    expect(joined).not.toContain('Default save location');
  });
});
