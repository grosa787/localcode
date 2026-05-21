/**
 * WorktreeGC tests — registry + on-disk orphan scan + safe removal.
 *
 * Uses a fake `GitRunner` so the suite never shells out to real git.
 * On-disk fixtures live under tmpdir per test.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  WorktreeGC,
  isSafeWorktreePath,
  worktreesDir,
  type GitRunner,
} from '@/agents/worktree-gc';

interface GitCall {
  args: readonly string[];
  cwd?: string;
}

function makeFakeGit(
  responder: (args: readonly string[]) => { stdout: string; exitCode: number },
): { runner: GitRunner; calls: GitCall[] } {
  const calls: GitCall[] = [];
  const runner: GitRunner = {
    async run(args, opts) {
      calls.push({ args, ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) });
      return responder(args);
    },
  };
  return { runner, calls };
}

let projectRoot = '';
let worktreesPath = '';

beforeEach(async () => {
  projectRoot = path.join(os.tmpdir(), `lc-gc-${crypto.randomUUID()}`);
  worktreesPath = worktreesDir(projectRoot);
  await fs.mkdir(worktreesPath, { recursive: true });
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe('isSafeWorktreePath', () => {
  test('accepts a direct descendant of <projectRoot>/.localcode/worktrees/', () => {
    const candidate = path.join(worktreesPath, 'lc-agent-foo-abcd');
    expect(isSafeWorktreePath(projectRoot, candidate)).toBe(candidate);
  });

  test('rejects the worktrees dir itself', () => {
    expect(isSafeWorktreePath(projectRoot, worktreesPath)).toBeNull();
  });

  test('rejects paths outside the worktrees dir', () => {
    expect(isSafeWorktreePath(projectRoot, '/tmp/random-dir')).toBeNull();
    expect(
      isSafeWorktreePath(projectRoot, path.join(projectRoot, 'src', 'main.ts')),
    ).toBeNull();
  });

  test('rejects path-traversal attempts', () => {
    const evil = path.join(worktreesPath, '..', '..', 'etc');
    expect(isSafeWorktreePath(projectRoot, evil)).toBeNull();
  });

  test('resolves relative paths through the base dir guard', () => {
    // A path that *looks* like it's inside but resolves outside.
    const evil = `${worktreesPath}-sibling`;
    expect(isSafeWorktreePath(projectRoot, evil)).toBeNull();
  });
});

describe('WorktreeGC.gcOrphans — fixture (3 dirs, 2 registered, 1 orphan)', () => {
  test('identifies and removes the unregistered orphan', async () => {
    // Setup: 3 worktree directories on disk.
    const a = path.join(worktreesPath, 'lc-agent-alpha-aaaa');
    const b = path.join(worktreesPath, 'lc-agent-beta-bbbb');
    const c = path.join(worktreesPath, 'lc-agent-gamma-cccc');
    for (const p of [a, b, c]) await fs.mkdir(p, { recursive: true });

    // Backdate them all so the age threshold fires. The default is 5
    // minutes — we set mtime to "ten minutes ago".
    const oldMs = Date.now() - 10 * 60 * 1000;
    for (const p of [a, b, c]) {
      await fs.utimes(p, new Date(oldMs), new Date(oldMs));
    }

    const removeAttempts: string[] = [];
    const { runner } = makeFakeGit((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        // All three appear registered in git so corruption isn't the
        // discriminator — only the active-set check should flag `c`.
        const lines = [a, b, c].map((p) => `worktree ${p}`).join('\n');
        return { stdout: lines, exitCode: 0 };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        const target = args[args.length - 1] ?? '';
        removeAttempts.push(target);
        return { stdout: '', exitCode: 0 };
      }
      if (args[0] === 'branch') return { stdout: '', exitCode: 0 };
      return { stdout: '', exitCode: 1 };
    });

    const gc = new WorktreeGC({ git: runner });
    gc.register('alpha', a, null);
    gc.register('beta', b, null);
    // `c` (gamma) is intentionally NOT registered → should be orphan.

    const result = await gc.gcOrphans(projectRoot);

    expect(result.removed).toContain(c);
    expect(result.removed).not.toContain(a);
    expect(result.removed).not.toContain(b);
    expect(result.errors).toEqual([]);
    expect(removeAttempts).toEqual([c]);

    // On disk: a and b remain, c is gone.
    expect(await dirExists(a)).toBe(true);
    expect(await dirExists(b)).toBe(true);
    expect(await dirExists(c)).toBe(false);
  });
});

describe('WorktreeGC.gcOrphans — corruption (not in git worktree list)', () => {
  test('removes corrupt dirs even when fresh', async () => {
    const dir = path.join(worktreesPath, 'lc-agent-zeta-zzzz');
    await fs.mkdir(dir, { recursive: true });

    const { runner } = makeFakeGit((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        // git doesn't know about it — corrupt.
        return { stdout: '', exitCode: 0 };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return { stdout: '', exitCode: 1 };
      }
      return { stdout: '', exitCode: 0 };
    });
    const gc = new WorktreeGC({ git: runner });
    // No register → unknown. Fresh → not age-stale. But corrupt path
    // qualifies it for removal regardless.

    const result = await gc.gcOrphans(projectRoot);
    expect(result.removed).toContain(dir);
    expect(await dirExists(dir)).toBe(false);
  });
});

describe('WorktreeGC.gcOrphans — empty / missing dir', () => {
  test('returns empty result when worktrees dir is missing', async () => {
    const otherRoot = path.join(os.tmpdir(), `lc-gc-nodir-${crypto.randomUUID()}`);
    const { runner } = makeFakeGit(() => ({ stdout: '', exitCode: 0 }));
    const gc = new WorktreeGC({ git: runner });
    const result = await gc.gcOrphans(otherRoot);
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('returns empty result when worktrees dir is empty', async () => {
    const { runner } = makeFakeGit(() => ({ stdout: '', exitCode: 0 }));
    const gc = new WorktreeGC({ git: runner });
    const result = await gc.gcOrphans(projectRoot);
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('WorktreeGC.register/release/activeCount', () => {
  test('register/release update the active set', () => {
    const gc = new WorktreeGC();
    expect(gc.activeCount()).toBe(0);
    gc.register('a', '/tmp/a', null);
    gc.register('b', '/tmp/b', 'agent-b');
    expect(gc.activeCount()).toBe(2);
    gc.release('a');
    expect(gc.activeCount()).toBe(1);
    gc.release('nonexistent');
    expect(gc.activeCount()).toBe(1);
  });

  test('listActive returns the entries verbatim', () => {
    const gc = new WorktreeGC();
    gc.register('x', '/some/path', 'branch-x');
    const active = gc.listActive();
    expect(active.length).toBe(1);
    expect(active[0]?.agentId).toBe('x');
    expect(active[0]?.branch).toBe('branch-x');
  });
});

describe('WorktreeGC.listAll — distinguishes active vs orphan vs corrupt', () => {
  test('classifies each directory correctly', async () => {
    const active = path.join(worktreesPath, 'lc-agent-active-aaaa');
    const orphan = path.join(worktreesPath, 'lc-agent-orphan-bbbb');
    const corrupt = path.join(worktreesPath, 'lc-agent-corrupt-cccc');
    for (const p of [active, orphan, corrupt]) await fs.mkdir(p, { recursive: true });

    const { runner } = makeFakeGit((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        // `corrupt` intentionally omitted from the list.
        return {
          stdout: `worktree ${active}\nworktree ${orphan}`,
          exitCode: 0,
        };
      }
      return { stdout: '', exitCode: 0 };
    });

    const gc = new WorktreeGC({ git: runner });
    gc.register('active', active, null);

    const summaries = await gc.listAll(projectRoot);
    const byPath = new Map(summaries.map((s) => [s.path, s]));
    expect(byPath.get(active)?.active).toBe(true);
    expect(byPath.get(active)?.corrupt).toBe(false);
    expect(byPath.get(orphan)?.active).toBe(false);
    expect(byPath.get(orphan)?.corrupt).toBe(false);
    expect(byPath.get(corrupt)?.active).toBe(false);
    expect(byPath.get(corrupt)?.corrupt).toBe(true);
  });
});

describe('WorktreeGC.releaseAll', () => {
  test('removes every active entry and clears the registry', async () => {
    const a = path.join(worktreesPath, 'lc-agent-rel-aaaa');
    const b = path.join(worktreesPath, 'lc-agent-rel-bbbb');
    for (const p of [a, b]) await fs.mkdir(p, { recursive: true });

    const { runner } = makeFakeGit(() => ({ stdout: '', exitCode: 0 }));
    const gc = new WorktreeGC({ git: runner });
    gc.register('a', a, null);
    gc.register('b', b, null);

    const result = await gc.releaseAll(projectRoot);
    expect(result.removed.sort()).toEqual([a, b].sort());
    expect(gc.activeCount()).toBe(0);
    expect(await dirExists(a)).toBe(false);
    expect(await dirExists(b)).toBe(false);
  });
});

async function dirExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
