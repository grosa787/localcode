/**
 * /worktrees slash command tests — list, gc preview, gc force.
 *
 * Uses a real `WorktreeGC` against a tmpdir-backed projectRoot with a
 * fake `GitRunner` so we never shell out.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createWorktreesCommand } from '@/commands/cmd-worktrees';
import { WorktreeGC, worktreesDir, type GitRunner } from '@/agents/worktree-gc';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext } from '@/types/global';

let projectRoot = '';

beforeEach(async () => {
  projectRoot = path.join(os.tmpdir(), `lc-wtcmd-${crypto.randomUUID()}`);
  await fs.mkdir(worktreesDir(projectRoot), { recursive: true });
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

function makeFakeGit(activeRegistered: readonly string[]): GitRunner {
  return {
    async run(args) {
      if (args[0] === 'worktree' && args[1] === 'list') {
        const lines = activeRegistered.map((p) => `worktree ${p}`).join('\n');
        return { stdout: lines, exitCode: 0 };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return { stdout: '', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    },
  };
}

function buildCtx(): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  const ctx: CommandContext = {
    projectRoot,
    sessionId: null,
    config,
    print: (t: string) => output.push(t),
    setScreen: () => { /* no-op */ },
  };
  return { ctx, output };
}

describe('/worktrees — list', () => {
  test('prints "No sub-agent worktrees on disk" when empty', async () => {
    const gc = new WorktreeGC({ git: makeFakeGit([]) });
    const cmd = createWorktreesCommand({ gc, getProjectRoot: () => projectRoot });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.join('\n')).toContain('No sub-agent worktrees');
  });

  test('lists active and orphan dirs separately', async () => {
    const active = path.join(worktreesDir(projectRoot), 'lc-agent-act-aaaa');
    const orphan = path.join(worktreesDir(projectRoot), 'lc-agent-orph-bbbb');
    await fs.mkdir(active, { recursive: true });
    await fs.mkdir(orphan, { recursive: true });
    const gc = new WorktreeGC({ git: makeFakeGit([active, orphan]) });
    gc.register('act', active, null);
    const cmd = createWorktreesCommand({ gc, getProjectRoot: () => projectRoot });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('active (1)');
    expect(joined).toContain('orphan candidates (1)');
    expect(joined).toContain(active);
    expect(joined).toContain(orphan);
  });
});

describe('/worktrees gc — preview (no force)', () => {
  test('lists what would be removed without actually removing', async () => {
    const orphan = path.join(worktreesDir(projectRoot), 'lc-agent-foo-bbbb');
    await fs.mkdir(orphan, { recursive: true });
    const gc = new WorktreeGC({ git: makeFakeGit([orphan]) });
    const cmd = createWorktreesCommand({ gc, getProjectRoot: () => projectRoot });
    const { ctx, output } = buildCtx();
    await cmd.execute('gc', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Would remove 1 worktree');
    expect(joined).toContain('gc force');
    // Dir still on disk.
    const stat = await fs.stat(orphan).catch(() => null);
    expect(stat).not.toBeNull();
  });

  test('reports "No orphan worktree candidates" when nothing matches', async () => {
    const gc = new WorktreeGC({ git: makeFakeGit([]) });
    const cmd = createWorktreesCommand({ gc, getProjectRoot: () => projectRoot });
    const { ctx, output } = buildCtx();
    await cmd.execute('gc', ctx);
    expect(output.join('\n')).toContain('No orphan');
  });
});

describe('/worktrees gc force', () => {
  test('actually removes orphan dirs and reports the count', async () => {
    const orphan = path.join(worktreesDir(projectRoot), 'lc-agent-foo-cccc');
    await fs.mkdir(orphan, { recursive: true });
    // Backdate so age-stale predicate fires.
    const oldMs = Date.now() - 10 * 60 * 1000;
    await fs.utimes(orphan, new Date(oldMs), new Date(oldMs));
    const gc = new WorktreeGC({ git: makeFakeGit([orphan]) });
    const cmd = createWorktreesCommand({ gc, getProjectRoot: () => projectRoot });
    const { ctx, output } = buildCtx();
    await cmd.execute('gc force', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Removed 1 orphan');
    const stat = await fs.stat(orphan).catch(() => null);
    expect(stat).toBeNull();
  });
});

describe('/worktrees — gc null', () => {
  test('prints the disabled message when no GC is wired', async () => {
    const cmd = createWorktreesCommand({ gc: null, getProjectRoot: () => projectRoot });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.join('\n')).toContain('not enabled');
  });
});

describe('/worktrees — unknown verb', () => {
  test('prints usage line', async () => {
    const gc = new WorktreeGC({ git: makeFakeGit([]) });
    const cmd = createWorktreesCommand({ gc, getProjectRoot: () => projectRoot });
    const { ctx, output } = buildCtx();
    await cmd.execute('frobnicate', ctx);
    expect(output.join('\n')).toContain('Unknown subcommand');
  });
});
