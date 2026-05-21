/**
 * Git worktree wrapper — creates an isolated copy of `repoRoot` for a
 * sub-agent to write into without colliding with the lead agent's
 * working tree.
 *
 * Strategy:
 *   1. Verify `repoRoot` is a git repo (`git rev-parse --git-dir`).
 *   2. Choose a unique tmp path: `${tmpdir}/lc-agent-<label>-<short>`.
 *   3. `git worktree add <path> HEAD` — checkout copy of current HEAD.
 *   4. `cleanup()` runs `git worktree remove --force <path>` and rms
 *      the directory if anything is left.
 *
 * If git is unavailable OR `repoRoot` isn't a git repo, the helper
 * throws a clear error. The orchestrator catches and falls back to
 * `isolation === 'shared'`.
 *
 * Diff helper: `diffWorktree(path)` runs `git -C <path> diff HEAD`
 * relative to the base commit so the orchestrator can return the
 * worker's changes verbatim from `await_agent`.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export interface Worktree {
  /** Absolute path to the worktree checkout. */
  readonly path: string;
  /** Idempotent teardown. Logs but never throws on failure. */
  cleanup(): Promise<void>;
}

/** Options for `createWorktree`. Mainly seams for tests. */
export interface CreateWorktreeOptions {
  /** Override Bun.spawn — used by tests to fake git. */
  spawn?: SpawnFn;
  /** Override `os.tmpdir()`. Used as the base dir only when `baseDir` is unset. */
  tmpdir?: () => string;
  /** Override the random short-id generator. */
  shortId?: () => string;
  /**
   * Explicit base directory for the new worktree. When set, takes
   * precedence over `tmpdir`. Created on demand. The orchestrator passes
   * `<projectRoot>/.localcode/worktrees/` here so the WorktreeGC can
   * walk a known location to find orphans.
   */
  baseDir?: string;
}

/** Subset of Bun.spawn we use; matches Bun's typing closely. */
export type SpawnFn = (cmd: readonly string[], opts?: SpawnOpts) => SpawnedProc;
export interface SpawnOpts {
  cwd?: string;
  stdout?: 'pipe' | 'inherit' | 'ignore';
  stderr?: 'pipe' | 'inherit' | 'ignore';
}
export interface SpawnedProc {
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
}

/** Default short-id — alphanumeric, 8 chars. */
function defaultShortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Default spawn binding — `Bun.spawn`. */
function defaultSpawn(cmd: readonly string[], opts?: SpawnOpts): SpawnedProc {
  // Cast: Bun.spawn is the canonical entry point at runtime. We go
  // through `unknown` so the loose `(cmd, opts) => unknown` shape we
  // use here doesn't have to satisfy Bun's overloaded type signature.
  const bun = (globalThis as unknown as {
    Bun?: { spawn: (c: readonly string[], o?: unknown) => unknown };
  }).Bun;
  if (bun === undefined || typeof bun.spawn !== 'function') {
    throw new Error('Bun.spawn is unavailable — worktree helper requires Bun');
  }
  const bag: Record<string, unknown> = {
    stdout: opts?.stdout ?? 'pipe',
    stderr: opts?.stderr ?? 'pipe',
  };
  if (opts?.cwd !== undefined) bag['cwd'] = opts.cwd;
  return bun.spawn(cmd, bag) as SpawnedProc;
}

async function readStream(s: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (s === null || s === undefined) return '';
  const reader = s.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(out);
}

/** Run a git command; throws with combined stdout+stderr on non-zero exit. */
async function runGit(
  spawn: SpawnFn,
  args: readonly string[],
  opts: { cwd?: string } = {},
): Promise<string> {
  const proc = spawn(['git', ...args], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    readStream(proc.stdout),
    readStream(proc.stderr),
  ]);
  if (code !== 0) {
    const detail = (err.length > 0 ? err : out).trim();
    throw new Error(`git ${args.join(' ')} exited ${code}${detail ? `: ${detail}` : ''}`);
  }
  return out;
}

/**
 * Sanity-check that `repoRoot` is a git repo. Cheap — used by the
 * orchestrator before deciding to spawn with isolation='worktree'.
 */
export async function isGitRepo(
  repoRoot: string,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<boolean> {
  try {
    await runGit(spawnFn, ['rev-parse', '--git-dir'], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a fresh git worktree as a copy of `repoRoot`'s current HEAD.
 * Returns the absolute path and an idempotent cleanup callback.
 *
 * Throws if git is unavailable or the repo isn't a git repo. The
 * orchestrator catches and switches to shared mode.
 */
export async function createWorktree(
  repoRoot: string,
  label: string,
  opts: CreateWorktreeOptions = {},
): Promise<Worktree> {
  const spawn = opts.spawn ?? defaultSpawn;
  const base = opts.baseDir ?? (opts.tmpdir ?? os.tmpdir)();
  const shortId = (opts.shortId ?? defaultShortId)();

  // Sanity-check repoRoot — clearer error than letting `git worktree add` fail.
  if (!(await isGitRepo(repoRoot, spawn))) {
    throw new Error(`createWorktree: ${repoRoot} is not a git repository`);
  }

  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'agent';
  const wtPath = path.join(base, `lc-agent-${safeLabel}-${shortId}`);

  // Ensure the parent directory exists when caller supplied a baseDir
  // (e.g. `<projectRoot>/.localcode/worktrees/`). `git worktree add`
  // wants the *target* path to be absent but the parent to exist.
  if (opts.baseDir !== undefined) {
    try {
      await fs.mkdir(opts.baseDir, { recursive: true });
    } catch {
      // best-effort — let git surface a clearer error if the dir is unusable
    }
  }

  await runGit(spawn, ['worktree', 'add', wtPath, 'HEAD'], { cwd: repoRoot });

  let cleaned = false;
  return {
    path: wtPath,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      // Best-effort: prune the worktree registration first, then rm the dir.
      try {
        await runGit(spawn, ['worktree', 'remove', '--force', wtPath], {
          cwd: repoRoot,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[worktree] remove failed for ${wtPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      try {
        await fs.rm(wtPath, { recursive: true, force: true });
      } catch {
        // ignore — git worktree remove already deletes the path on success
      }
    },
  };
}

/**
 * `git diff HEAD` inside the worktree. Returns the unified diff of the
 * worker's uncommitted changes versus the base it was forked from.
 * Empty string when there are no changes (or git fails).
 */
export async function diffWorktree(
  worktreePath: string,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<string> {
  try {
    return await runGit(spawnFn, ['diff', 'HEAD'], { cwd: worktreePath });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[worktree] diff failed for ${worktreePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return '';
  }
}
