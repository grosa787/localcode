/**
 * Worktree helper tests.
 *
 * Most behaviour is tested with an injected fake spawn so the suite
 * runs without git installed. A single integration test attempts a
 * real `git worktree add` against a freshly-init'd repo and SKIPS
 * cleanly if git isn't on PATH.
 */

import { describe, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  createWorktree,
  diffWorktree,
  isGitRepo,
  type SpawnFn,
} from '@/agents/worktree';

interface FakeCall {
  cmd: readonly string[];
  cwd?: string;
}

function makeFakeSpawn(
  responder: (cmd: readonly string[], cwd?: string) => { code: number; stdout?: string; stderr?: string },
): { spawn: SpawnFn; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const spawn: SpawnFn = (cmd, opts) => {
    calls.push({ cmd, ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) });
    const r = responder(cmd, opts?.cwd);
    return {
      exited: Promise.resolve(r.code),
      stdout: stringStream(r.stdout ?? ''),
      stderr: stringStream(r.stderr ?? ''),
    };
  };
  return { spawn, calls };
}

function stringStream(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('isGitRepo', () => {
  test('returns true when git rev-parse succeeds', async () => {
    const { spawn } = makeFakeSpawn(() => ({ code: 0, stdout: '.git\n' }));
    expect(await isGitRepo('/repo', spawn)).toBe(true);
  });

  test('returns false when git rev-parse fails', async () => {
    const { spawn } = makeFakeSpawn(() => ({ code: 128, stderr: 'not a git repo' }));
    expect(await isGitRepo('/notrepo', spawn)).toBe(false);
  });
});

describe('createWorktree (mocked)', () => {
  test('happy path: rev-parse OK then worktree add OK', async () => {
    const { spawn, calls } = makeFakeSpawn((cmd) => {
      if (cmd[1] === 'rev-parse') return { code: 0 };
      if (cmd[1] === 'worktree' && cmd[2] === 'add') return { code: 0 };
      if (cmd[1] === 'worktree' && cmd[2] === 'remove') return { code: 0 };
      return { code: 1, stderr: 'unknown' };
    });
    const wt = await createWorktree('/repo', 'demo', {
      spawn,
      tmpdir: () => '/tmp',
      shortId: () => 'abcd1234',
    });
    expect(wt.path).toBe(path.join('/tmp', 'lc-agent-demo-abcd1234'));
    const addCall = calls.find((c) => c.cmd[1] === 'worktree' && c.cmd[2] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall?.cmd).toContain('HEAD');
    await wt.cleanup();
    const removeCall = calls.find((c) => c.cmd[1] === 'worktree' && c.cmd[2] === 'remove');
    expect(removeCall).toBeDefined();
  });

  test('throws when repo isn’t a git repo', async () => {
    const { spawn } = makeFakeSpawn(() => ({ code: 128, stderr: 'fatal: not a git repository' }));
    await expect(
      createWorktree('/notrepo', 'demo', { spawn }),
    ).rejects.toThrow(/not a git repository/);
  });

  test('throws when worktree add fails', async () => {
    const { spawn } = makeFakeSpawn((cmd) => {
      if (cmd[1] === 'rev-parse') return { code: 0 };
      if (cmd[2] === 'add') return { code: 128, stderr: 'already exists' };
      return { code: 0 };
    });
    await expect(
      createWorktree('/repo', 'demo', { spawn, tmpdir: () => '/tmp', shortId: () => 'x' }),
    ).rejects.toThrow();
  });

  test('cleanup is idempotent', async () => {
    let removeCount = 0;
    const { spawn } = makeFakeSpawn((cmd) => {
      if (cmd[1] === 'rev-parse') return { code: 0 };
      if (cmd[2] === 'add') return { code: 0 };
      if (cmd[2] === 'remove') {
        removeCount += 1;
        return { code: 0 };
      }
      return { code: 1 };
    });
    const wt = await createWorktree('/repo', 'demo', { spawn, tmpdir: () => '/tmp', shortId: () => 'x' });
    await wt.cleanup();
    await wt.cleanup();
    expect(removeCount).toBe(1);
  });

  test('label sanitisation strips unsafe characters', async () => {
    const { spawn } = makeFakeSpawn((cmd) => {
      if (cmd[1] === 'rev-parse') return { code: 0 };
      return { code: 0 };
    });
    const wt = await createWorktree('/repo', 'bad/label name!', {
      spawn,
      tmpdir: () => '/tmp',
      shortId: () => 'x',
    });
    expect(wt.path).toMatch(/lc-agent-bad_label_name_-x$/);
    // The basename portion has unsafe chars stripped (`/`, ` `, `!`).
    const base = wt.path.split('/').pop() ?? '';
    expect(base).not.toContain(' ');
    expect(base).not.toContain('!');
    await wt.cleanup();
  });
});

describe('diffWorktree (mocked)', () => {
  test('returns stdout from git diff HEAD', async () => {
    const { spawn } = makeFakeSpawn((cmd) => {
      if (cmd[1] === 'diff') return { code: 0, stdout: 'diff --git a b\n' };
      return { code: 1 };
    });
    const out = await diffWorktree('/wt', spawn);
    expect(out).toContain('diff --git');
  });

  test('returns empty string on git failure', async () => {
    const { spawn } = makeFakeSpawn(() => ({ code: 128, stderr: 'broken' }));
    const out = await diffWorktree('/wt', spawn);
    expect(out).toBe('');
  });
});

describe('createWorktree (real git, integration)', () => {
  test('creates a real worktree when git is available', async () => {
    // Detect git on PATH; skip cleanly if absent.
    let gitOk = false;
    const bunRef = (globalThis as unknown as {
      Bun?: { spawn: (c: readonly string[], o?: unknown) => { exited: Promise<number> } };
    }).Bun;
    try {
      if (bunRef === undefined) throw new Error('no bun');
      const proc = bunRef.spawn(['git', '--version'], { stdout: 'ignore', stderr: 'ignore' });
      const code = await proc.exited;
      gitOk = code === 0;
    } catch {
      gitOk = false;
    }
    if (!gitOk) {
      // Skip — git unavailable.
      expect(true).toBe(true);
      return;
    }

    const repoRoot = path.join(os.tmpdir(), `lc-agent-test-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(repoRoot, { recursive: true });
    const Bn = bunRef!;
    const run = async (cmd: readonly string[]): Promise<number> => {
      const p = Bn.spawn(cmd, { cwd: repoRoot, stdout: 'ignore', stderr: 'ignore' });
      return p.exited;
    };
    await run(['git', 'init']);
    await run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init']);

    try {
      const wt = await createWorktree(repoRoot, 'integ');
      const stat = await fs.stat(wt.path);
      expect(stat.isDirectory()).toBe(true);
      await wt.cleanup();
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
