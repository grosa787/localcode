/**
 * Git tool tests — exercises `git_status`, `git_log`, `git_branch`,
 * `git_diff`, and `git_commit` end-to-end against a real temp git repo
 * spun up per test. Uses `Bun.spawn` exactly the way the tool helpers do
 * so we cover the real argv plumbing rather than a mock.
 *
 * `git_commit` is also exercised with a fake `SpawnFn` to verify failure
 * paths (non-git directory, commit aborted) without polluting the real
 * working tree.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { gitStatus } from '@/tools/git-status';
import { gitLog } from '@/tools/git-log';
import { gitBranch } from '@/tools/git-branch';
import { gitDiff } from '@/tools/git-diff';
import { commitGitCommit, previewGitCommit } from '@/tools/git-commit';
import type { GitToolContext, SpawnFn } from '@/tools/git-status';

// ---------- Helpers ----------

interface ParsedStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  raw: string;
}

let tmpRoot = '';

function ctx(root: string = tmpRoot): GitToolContext {
  return { projectRoot: root, dangerouslyAllowAll: false };
}

function ctxWithSpawn(spawn: SpawnFn): GitToolContext {
  return { projectRoot: tmpRoot, dangerouslyAllowAll: false, spawn };
}

async function git(...argv: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...argv], {
    cwd: tmpRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${argv.join(' ')} failed: ${stderr}`);
  }
}

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `lc-git-${crypto.randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
  await git('init');
  // Pin branch name so the parser sees a deterministic header.
  await git('checkout', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await git('config', 'commit.gpgsign', 'false');
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------- git_status ----------

describe('git_status', () => {
  test('rejects non-git directories', async () => {
    const empty = path.join(os.tmpdir(), `lc-nogit-${crypto.randomUUID()}`);
    await mkdir(empty, { recursive: true });
    try {
      const res = await gitStatus({}, ctx(empty));
      expect(res.success).toBe(false);
      expect(res.error ?? '').toMatch(/Not a git repository/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('classifies untracked vs staged vs modified', async () => {
    // Set up: 1 untracked, 1 staged (new), 1 staged-and-modified.
    await writeFile(path.join(tmpRoot, 'tracked.txt'), 'v1\n');
    await git('add', 'tracked.txt');
    await git('commit', '-m', 'initial');
    await writeFile(path.join(tmpRoot, 'tracked.txt'), 'v2\n');
    await writeFile(path.join(tmpRoot, 'untracked.txt'), 'new\n');
    await writeFile(path.join(tmpRoot, 'staged.txt'), 'fresh\n');
    await git('add', 'staged.txt');

    const res = await gitStatus({}, ctx());
    expect(res.success).toBe(true);
    const env = JSON.parse(res.output) as ParsedStatus;
    expect(env.branch).toBe('main');
    expect(env.untracked).toContain('untracked.txt');
    expect(env.staged).toContain('staged.txt');
    expect(env.modified).toContain('tracked.txt');
  });

  test('short=true returns porcelain raw', async () => {
    // Create an initial commit so the header is the normal `## main` form
    // rather than `## No commits yet on main` (we exercise that path
    // separately below).
    await writeFile(path.join(tmpRoot, 'init.txt'), 'init\n');
    await git('add', 'init.txt');
    await git('commit', '-m', 'init');
    await writeFile(path.join(tmpRoot, 'a.txt'), 'x\n');
    const res = await gitStatus({ short: true }, ctx());
    expect(res.success).toBe(true);
    const env = JSON.parse(res.output) as ParsedStatus;
    expect(env.raw).toMatch(/##\s+main/);
  });

  test('no-commits-yet branch header is parsed', async () => {
    await writeFile(path.join(tmpRoot, 'a.txt'), 'x\n');
    const res = await gitStatus({ short: true }, ctx());
    expect(res.success).toBe(true);
    const env = JSON.parse(res.output) as ParsedStatus;
    expect(env.branch).toBe('main');
  });
});

// ---------- git_log ----------

describe('git_log', () => {
  test('returns entries with hash + message + author + date', async () => {
    await writeFile(path.join(tmpRoot, 'a.txt'), '1\n');
    await git('add', 'a.txt');
    await git('commit', '-m', 'first');
    await writeFile(path.join(tmpRoot, 'a.txt'), '2\n');
    await git('add', 'a.txt');
    await git('commit', '-m', 'second');

    const res = await gitLog({}, ctx());
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output) as {
      entries: Array<{ hash: string; message: string; author: string; date: string }>;
    };
    expect(parsed.entries.length).toBe(2);
    const messages = parsed.entries.map((e) => e.message);
    expect(messages).toContain('first');
    expect(messages).toContain('second');
    const first = parsed.entries[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.hash.length).toBeGreaterThanOrEqual(7);
      expect(first.author).toMatch(/Test/);
      expect(first.date.length).toBeGreaterThan(0);
    }
  });

  test('limit honoured', async () => {
    for (let i = 0; i < 5; i += 1) {
      await writeFile(path.join(tmpRoot, 'a.txt'), `${i}\n`);
      await git('add', 'a.txt');
      await git('commit', '-m', `commit-${i}`);
    }
    const res = await gitLog({ limit: 2 }, ctx());
    const parsed = JSON.parse(res.output) as { entries: unknown[] };
    expect(parsed.entries.length).toBe(2);
  });

  test('limit above max rejected', async () => {
    const res = await gitLog({ limit: 1000 }, ctx());
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Invalid args/);
  });

  test('non-git directory rejected', async () => {
    const empty = path.join(os.tmpdir(), `lc-nogit-${crypto.randomUUID()}`);
    await mkdir(empty, { recursive: true });
    try {
      const res = await gitLog({}, ctx(empty));
      expect(res.success).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

// ---------- git_branch ----------

describe('git_branch', () => {
  test('returns current and lists branches', async () => {
    await writeFile(path.join(tmpRoot, 'a.txt'), '1\n');
    await git('add', 'a.txt');
    await git('commit', '-m', 'first');
    await git('checkout', '-b', 'feature/x');

    const res = await gitBranch({}, ctx());
    expect(res.success).toBe(true);
    const env = JSON.parse(res.output) as { current: string | null; all: string[] };
    expect(env.current).toBe('feature/x');
    expect(env.all).toContain('feature/x');
    expect(env.all).toContain('main');
  });

  test('non-git directory rejected', async () => {
    const empty = path.join(os.tmpdir(), `lc-nogit-${crypto.randomUUID()}`);
    await mkdir(empty, { recursive: true });
    try {
      const res = await gitBranch({}, ctx(empty));
      expect(res.success).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

// ---------- git_diff ----------

describe('git_diff', () => {
  test('worktree diff shows unstaged change', async () => {
    await writeFile(path.join(tmpRoot, 'a.txt'), 'one\n');
    await git('add', 'a.txt');
    await git('commit', '-m', 'first');
    await writeFile(path.join(tmpRoot, 'a.txt'), 'two\n');

    const res = await gitDiff({}, ctx());
    expect(res.success).toBe(true);
    const env = JSON.parse(res.output) as {
      staged: boolean;
      diff: string;
      truncated: boolean;
    };
    expect(env.staged).toBe(false);
    expect(env.diff).toContain('-one');
    expect(env.diff).toContain('+two');
    expect(env.truncated).toBe(false);
  });

  test('staged=true returns index vs HEAD diff', async () => {
    await writeFile(path.join(tmpRoot, 'a.txt'), 'one\n');
    await git('add', 'a.txt');
    await git('commit', '-m', 'first');
    await writeFile(path.join(tmpRoot, 'a.txt'), 'two\n');
    await git('add', 'a.txt');

    const res = await gitDiff({ staged: true }, ctx());
    expect(res.success).toBe(true);
    const env = JSON.parse(res.output) as { staged: boolean; diff: string };
    expect(env.staged).toBe(true);
    expect(env.diff).toContain('+two');
  });

  test('empty diff returns empty string but success', async () => {
    await writeFile(path.join(tmpRoot, 'a.txt'), 'one\n');
    await git('add', 'a.txt');
    await git('commit', '-m', 'first');

    const res = await gitDiff({}, ctx());
    expect(res.success).toBe(true);
    const env = JSON.parse(res.output) as { diff: string };
    expect(env.diff).toBe('');
  });
});

// ---------- git_commit ----------

describe('git_commit (real repo)', () => {
  test('preview shows pending diff when staged', async () => {
    await writeFile(path.join(tmpRoot, 'a.txt'), 'v1\n');
    await git('add', 'a.txt');
    const res = await previewGitCommit({ message: 'add a' }, ctx());
    expect(res.success).toBe(true);
    expect(res.requiresApproval).toBe(true);
    expect(res.output).toContain('Will commit with message: add a');
    expect(res.output).toContain('+v1');
  });

  test('preview reports no-changes when nothing staged', async () => {
    const res = await previewGitCommit({ message: 'noop' }, ctx());
    expect(res.success).toBe(true);
    expect(res.output).toContain('(no changes to commit)');
  });

  test('commit produces a real HEAD hash', async () => {
    await writeFile(path.join(tmpRoot, 'a.txt'), 'hello\n');
    await git('add', 'a.txt');
    const res = await commitGitCommit({ message: 'real commit' }, ctx());
    expect(res.success).toBe(true);
    const env = JSON.parse(res.output) as { hash: string; message: string };
    expect(env.hash.length).toBeGreaterThanOrEqual(7);
    expect(env.message).toBe('real commit');
  });

  test('addAll=true stages everything before commit', async () => {
    await writeFile(path.join(tmpRoot, 'a.txt'), 'one\n');
    await writeFile(path.join(tmpRoot, 'b.txt'), 'two\n');
    const res = await commitGitCommit(
      { message: 'commit with addAll', addAll: true },
      ctx(),
    );
    expect(res.success).toBe(true);
    // Verify both files made it into the commit by checking status.
    const status = await gitStatus({}, ctx());
    const env = JSON.parse(status.output) as ParsedStatus;
    expect(env.staged.length).toBe(0);
    expect(env.modified.length).toBe(0);
    expect(env.untracked.length).toBe(0);
  });

  test('non-git directory rejected', async () => {
    const empty = path.join(os.tmpdir(), `lc-nogit-${crypto.randomUUID()}`);
    await mkdir(empty, { recursive: true });
    try {
      const res = await commitGitCommit({ message: 'x' }, ctx(empty));
      expect(res.success).toBe(false);
      expect(res.error ?? '').toMatch(/Not a git repository/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('empty message rejected by Zod', async () => {
    const res = await previewGitCommit({ message: '' }, ctx());
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Invalid args/);
  });
});

// ---------- git_commit with fake spawn (failure paths) ----------

describe('git_commit (mocked spawn)', () => {
  test('non-zero git commit exit surfaced as failure', async () => {
    await writeFile(path.join(tmpRoot, 'a.txt'), 'staged\n');
    await git('add', 'a.txt');

    function makeStream(s: string): ReadableStream<Uint8Array> {
      return new ReadableStream({
        start(controller) {
          if (s.length > 0) controller.enqueue(new TextEncoder().encode(s));
          controller.close();
        },
      });
    }

    const fake: SpawnFn = (cmd) => {
      // Pretend `git commit` always exits 1 with an error message. Other
      // commands (diff, rev-parse) succeed silently.
      if (cmd.length >= 2 && cmd[0] === 'git' && cmd[1] === 'commit') {
        return {
          exited: Promise.resolve(1),
          stdout: makeStream(''),
          stderr: makeStream('mocked failure'),
        };
      }
      return {
        exited: Promise.resolve(0),
        stdout: makeStream(''),
        stderr: makeStream(''),
      };
    };
    const res = await commitGitCommit({ message: 'will fail' }, ctxWithSpawn(fake));
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/mocked failure/);
  });
});
