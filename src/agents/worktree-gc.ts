/**
 * WorktreeGC — garbage collection for stale git worktrees created by the
 * agent orchestrator.
 *
 * Problem: when `spawn_agent` runs with `isolation: 'worktree'`, the
 * orchestrator creates a git worktree under
 * `<projectRoot>/.localcode/worktrees/lc-agent-<label>-<short>`. If the
 * agent crashes, the user cancels, or the process is killed before the
 * orchestrator can run its `cleanup()`, the worktree directory and its
 * `.git/worktrees/<name>` registration stay behind forever.
 *
 * This module owns:
 *   - The in-process registry of *active* worktrees (so a GC pass can
 *     distinguish "still running" from "abandoned").
 *   - A scan + prune routine that walks
 *     `<projectRoot>/.localcode/worktrees/*` and removes anything that
 *     looks orphaned.
 *   - Path safety: removal is hard-locked to paths that resolve under
 *     the project's `.localcode/worktrees/` directory. Anything outside
 *     is rejected, so a corrupted registry can't `rm -rf /`.
 *
 * Removal strategy (per orphan):
 *   1. `git worktree remove --force <path>` against the project root.
 *      Cleans up `.git/worktrees/<name>` registration + the checkout.
 *   2. `rm -rf <path>` as a fallback when git refused.
 *   3. `git branch -D <branch>` if a branch name was associated and
 *      it still exists locally.
 *
 * All git operations use `execa` (the same dep the rest of the CLI uses
 * for shell-out) and swallow per-worktree errors so one corrupt entry
 * never aborts the whole GC pass.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execa } from 'execa';

/** Registry entry for an active worktree. */
interface RegistryEntry {
  readonly agentId: string;
  readonly worktreePath: string;
  readonly branchName: string | null;
  readonly registeredAt: number;
}

/** Outcome of `gcOrphans`. */
export interface GcResult {
  /** Worktree paths that were successfully removed. */
  readonly removed: string[];
  /** Human-readable error lines (one per failure). Never empty if any orphan failed. */
  readonly errors: string[];
}

/** Pluggable shell-out for git commands — defaults to `execa`. */
export interface GitRunner {
  run(args: readonly string[], opts?: { cwd?: string }): Promise<{ stdout: string; exitCode: number }>;
}

const defaultGitRunner: GitRunner = {
  async run(args, opts) {
    try {
      const res = await execa('git', [...args], {
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        reject: false,
        stripFinalNewline: true,
      });
      return { stdout: typeof res.stdout === 'string' ? res.stdout : '', exitCode: res.exitCode ?? 0 };
    } catch (err) {
      // execa throws only on spawn failures (e.g. `git` not on PATH).
      // Treat as a non-zero exit so the caller can decide.
      return {
        stdout: err instanceof Error ? err.message : String(err),
        exitCode: -1,
      };
    }
  },
};

/** Construct the canonical worktrees dir for a given project. */
export function worktreesDir(projectRoot: string): string {
  return path.resolve(projectRoot, '.localcode', 'worktrees');
}

/**
 * Validate that `candidate` resolves to a path strictly under
 * `<projectRoot>/.localcode/worktrees/`. Returns the resolved absolute
 * path on success, `null` on rejection. Used as a defensive gate before
 * any destructive op.
 */
export function isSafeWorktreePath(
  projectRoot: string,
  candidate: string,
): string | null {
  const base = worktreesDir(projectRoot);
  const resolved = path.resolve(candidate);
  // Require the candidate to be a *direct or deeper* descendant — and
  // reject when it equals the base dir itself.
  if (resolved === base) return null;
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!resolved.startsWith(withSep)) return null;
  return resolved;
}

/**
 * Tracked-worktree summary used by `/worktrees`.
 */
export interface WorktreeSummary {
  readonly agentId: string;
  readonly path: string;
  readonly branch: string | null;
  /** True iff still in the active registry set (i.e. an agent is using it). */
  readonly active: boolean;
  /** True when on-disk but no git-registered worktree backs it. */
  readonly corrupt: boolean;
  /** Last modification time (ms epoch); -1 when we couldn't stat. */
  readonly mtimeMs: number;
}

export class WorktreeGC {
  /** agentId -> registry entry */
  private readonly active = new Map<string, RegistryEntry>();
  private readonly git: GitRunner;
  /**
   * Minimum age before an unregistered dir is considered orphaned. This
   * window protects against deleting a worktree that's mid-spawn (the
   * registry call happens slightly after the directory appears).
   */
  private readonly orphanAgeMs: number;

  constructor(opts?: { git?: GitRunner; orphanAgeMs?: number }) {
    this.git = opts?.git ?? defaultGitRunner;
    this.orphanAgeMs = opts?.orphanAgeMs ?? 5 * 60 * 1000; // 5 minutes
  }

  /** Track a freshly-created worktree. Idempotent on agentId. */
  register(agentId: string, worktreePath: string, branchName: string | null): void {
    this.active.set(agentId, {
      agentId,
      worktreePath: path.resolve(worktreePath),
      branchName,
      registeredAt: Date.now(),
    });
  }

  /**
   * Drop an entry — call when the agent terminates normally (the
   * orchestrator's per-agent `cleanup()` already removed the dir).
   */
  release(agentId: string): void {
    this.active.delete(agentId);
  }

  /** Diagnostic — number of currently-tracked active worktrees. */
  activeCount(): number {
    return this.active.size;
  }

  /** Snapshot of every registered (active) entry — for `/worktrees`. */
  listActive(): readonly { agentId: string; path: string; branch: string | null }[] {
    return [...this.active.values()].map((e) => ({
      agentId: e.agentId,
      path: e.worktreePath,
      branch: e.branchName,
    }));
  }

  /**
   * Walk `<projectRoot>/.localcode/worktrees/` and return a per-dir
   * summary that distinguishes active / orphan-candidate / corrupt.
   * Pure-read — no removals.
   */
  async listAll(projectRoot: string): Promise<readonly WorktreeSummary[]> {
    const base = worktreesDir(projectRoot);
    const dirEntries = await safeReadDir(base);
    const activeByPath = new Map<string, RegistryEntry>();
    for (const e of this.active.values()) {
      activeByPath.set(e.worktreePath, e);
    }

    const registered = await this.gitWorktreePaths(projectRoot);

    const out: WorktreeSummary[] = [];
    for (const name of dirEntries) {
      const full = path.join(base, name);
      const safe = isSafeWorktreePath(projectRoot, full);
      if (safe === null) continue;
      let mtimeMs = -1;
      try {
        const st = await fs.stat(safe);
        mtimeMs = st.mtimeMs;
      } catch {
        // best-effort
      }
      const entry = activeByPath.get(safe);
      const active = entry !== undefined;
      const corrupt = !registered.has(safe);
      const agentId = entry?.agentId ?? this.parseAgentIdFromBasename(name);
      out.push({
        agentId,
        path: safe,
        branch: entry?.branchName ?? null,
        active,
        corrupt,
        mtimeMs,
      });
    }
    return out;
  }

  /**
   * Scan the project's worktree dir + remove every orphan. An entry is
   * orphan iff (a) NOT in the active set AND its mtime is older than
   * `orphanAgeMs`, OR (b) NOT in `git worktree list` (corrupt registry).
   *
   * Per-entry failures are collected into `errors[]` — the pass never
   * throws.
   */
  async gcOrphans(projectRoot: string): Promise<GcResult> {
    const removed: string[] = [];
    const errors: string[] = [];

    const base = worktreesDir(projectRoot);
    const dirEntries = await safeReadDir(base);
    if (dirEntries.length === 0) return { removed, errors };

    const activePaths = new Set<string>();
    for (const e of this.active.values()) activePaths.add(e.worktreePath);

    const branchByPath = new Map<string, string | null>();
    for (const e of this.active.values()) branchByPath.set(e.worktreePath, e.branchName);

    const registered = await this.gitWorktreePaths(projectRoot);

    const now = Date.now();
    for (const name of dirEntries) {
      const full = path.join(base, name);
      const safe = isSafeWorktreePath(projectRoot, full);
      if (safe === null) {
        errors.push(`refused unsafe path: ${full}`);
        continue;
      }
      if (activePaths.has(safe)) continue; // still in use

      let mtimeMs = 0;
      try {
        const st = await fs.stat(safe);
        mtimeMs = st.mtimeMs;
      } catch {
        // Stat failure — treat as orphan; we'll fall through to removal.
      }

      const ageMs = now - mtimeMs;
      const isStale = ageMs >= this.orphanAgeMs;
      const isCorrupt = !registered.has(safe);

      // Orphan iff (a) stale-and-untracked OR (b) corrupt.
      if (!isStale && !isCorrupt) continue;

      const branch = branchByPath.get(safe) ?? null;
      const ok = await this.removeOne(projectRoot, safe, branch, errors);
      if (ok) removed.push(safe);
    }
    return { removed, errors };
  }

  /**
   * Remove every active worktree we registered. Called by the
   * orchestrator on `disposeAll()` to release worktrees that were still
   * "live" at shutdown. Distinct from gcOrphans — this skips age/git-
   * list heuristics and aggressively tears down everything we own.
   */
  async releaseAll(projectRoot: string): Promise<GcResult> {
    const removed: string[] = [];
    const errors: string[] = [];
    const entries = [...this.active.values()];
    this.active.clear();
    for (const e of entries) {
      const safe = isSafeWorktreePath(projectRoot, e.worktreePath);
      if (safe === null) {
        errors.push(`refused unsafe path: ${e.worktreePath}`);
        continue;
      }
      const ok = await this.removeOne(projectRoot, safe, e.branchName, errors);
      if (ok) removed.push(safe);
    }
    return { removed, errors };
  }

  // ---------- internals ----------

  /** Best-effort `git worktree list --porcelain` -> set of absolute paths. */
  private async gitWorktreePaths(projectRoot: string): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const res = await this.git.run(['worktree', 'list', '--porcelain'], {
        cwd: projectRoot,
      });
      if (res.exitCode !== 0) return out;
      for (const line of res.stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          out.add(path.resolve(line.slice('worktree '.length).trim()));
        }
      }
    } catch {
      // best-effort — empty set means we treat unknown dirs as corrupt
    }
    return out;
  }

  /**
   * Remove a single worktree. Tries `git worktree remove --force` first,
   * then `rm -rf` as a fallback. Returns true on success.
   */
  private async removeOne(
    projectRoot: string,
    worktreePath: string,
    branchName: string | null,
    errors: string[],
  ): Promise<boolean> {
    const safe = isSafeWorktreePath(projectRoot, worktreePath);
    if (safe === null) {
      errors.push(`refused unsafe path: ${worktreePath}`);
      return false;
    }
    let cleared = false;
    try {
      const res = await this.git.run(
        ['worktree', 'remove', '--force', safe],
        { cwd: projectRoot },
      );
      if (res.exitCode === 0) cleared = true;
    } catch (err) {
      errors.push(`git worktree remove failed for ${safe}: ${describe(err)}`);
    }

    // Always best-effort delete the on-disk directory — `git worktree
    // remove` succeeds at the registry level but won't help when the
    // directory drifted out of git's view (the corrupt case).
    try {
      await fs.rm(safe, { recursive: true, force: true });
      cleared = true;
    } catch (err) {
      errors.push(`rm -rf failed for ${safe}: ${describe(err)}`);
    }

    // Best-effort branch cleanup. Only attempt when the branch name was
    // tracked — we won't try to infer branch names for orphans we never
    // registered (the local-only branch heuristic is fragile).
    if (branchName !== null && cleared) {
      try {
        await this.git.run(['branch', '-D', branchName], { cwd: projectRoot });
      } catch {
        // ignore — leaving the branch is harmless
      }
    }

    return cleared;
  }

  private parseAgentIdFromBasename(name: string): string {
    // Basename format: `lc-agent-<label>-<short>`. We don't know the
    // original label split, so return the trailing short id (or the
    // whole basename when the prefix is missing).
    const m = /^lc-agent-(.+)-([a-z0-9]+)$/i.exec(name);
    if (m === null) return name;
    return m[2] ?? name;
  }
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
