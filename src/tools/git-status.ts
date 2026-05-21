/**
 * `git_status` tool — read-only snapshot of the git working tree.
 *
 * Spawns `git status` (porcelain v1) via `Bun.spawn` with an argv array —
 * never through `sh -c`, so there's no shell-injection surface. Output is
 * parsed into:
 *   { branch, ahead, behind, staged, modified, untracked, raw }
 *
 * Behaviour:
 *   - Refuses to run if `<projectRoot>/.git` doesn't exist.
 *   - Reports non-zero exit codes as `success: false` with stderr.
 *   - Auto-approved (no filesystem mutations).
 *
 * The `runGit` helper plus `SpawnFn` type are exported so the other git_*
 * tools (and tests) can share the spawn plumbing. Production callers leave
 * `spawn` unset to get the real `Bun.spawn`; tests inject a fake.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { ToolContext, ToolResult } from './types';

const GIT_TIMEOUT_MS = 15_000;

export const GitStatusArgsSchema = z.object({
  short: z.boolean().optional(),
});

export type GitStatusArgs = z.infer<typeof GitStatusArgsSchema>;

export interface GitStatusEnvelope {
  branch: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  raw: string;
}

// ---------- Spawn plumbing (shared by every git_* tool) ----------

/** Subset of `Bun.spawn`'s return value we rely on. */
export interface SpawnedProc {
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  kill?: () => void;
}

/** Minimal spawn options consumed by the git helpers. */
export interface SpawnOpts {
  cwd?: string;
  stdout?: 'pipe' | 'inherit' | 'ignore';
  stderr?: 'pipe' | 'inherit' | 'ignore';
  stdin?: 'pipe' | 'inherit' | 'ignore';
}

/** Pluggable spawn signature so tests can fake git. */
export type SpawnFn = (cmd: readonly string[], opts?: SpawnOpts) => SpawnedProc;

/**
 * `git_*` tool context — projectRoot/dangerouslyAllowAll from the base
 * `ToolContext` plus an optional `spawn` injection seam for tests.
 *
 * Production call sites pass the regular `ToolContext`; the wrapper
 * `asGitCtx` below silently falls back to the real Bun.spawn when no
 * override is present.
 */
export interface GitToolContext extends ToolContext {
  spawn?: SpawnFn;
}

/** Real Bun.spawn binding — used when GitToolContext.spawn is unset. */
function defaultSpawn(cmd: readonly string[], opts?: SpawnOpts): SpawnedProc {
  const bun = (globalThis as unknown as {
    Bun?: { spawn: (c: readonly string[], o?: unknown) => unknown };
  }).Bun;
  if (bun === undefined || typeof bun.spawn !== 'function') {
    throw new Error('Bun.spawn is unavailable — git tools require Bun');
  }
  const bag: Record<string, unknown> = {
    stdout: opts?.stdout ?? 'pipe',
    stderr: opts?.stderr ?? 'pipe',
    stdin: opts?.stdin ?? 'ignore',
  };
  if (opts?.cwd !== undefined) bag['cwd'] = opts.cwd;
  return bun.spawn(cmd, bag) as SpawnedProc;
}

/** Read a ReadableStream<Uint8Array> to a UTF-8 string. */
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

/**
 * Run a git subcommand. Argv-only — no shell interpolation. Returns the
 * captured stdout/stderr and exit code; never throws on non-zero exit.
 */
export async function runGit(
  ctx: GitToolContext,
  argv: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const spawn: SpawnFn = ctx.spawn ?? defaultSpawn;
  const proc = spawn(['git', ...argv], {
    cwd: ctx.projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  let killed = false;
  const timeout = setTimeout(() => {
    killed = true;
    try {
      proc.kill?.();
    } catch {
      // best-effort
    }
  }, GIT_TIMEOUT_MS);

  let stdout = '';
  let stderr = '';
  let code = -1;
  try {
    const results = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ]);
    stdout = results[0];
    stderr = results[1];
    code = results[2];
  } finally {
    clearTimeout(timeout);
  }

  if (killed) {
    return { stdout, stderr: `${stderr}\ngit command timed out after ${GIT_TIMEOUT_MS}ms`, code: code === 0 ? -1 : code };
  }
  return { stdout, stderr, code };
}

/** Returns true when `<root>/.git` exists (as a file or directory). */
export function isGitRepo(root: string): boolean {
  return existsSync(path.join(root, '.git'));
}

function fail(message: string): ToolResult {
  return { success: false, output: '', error: message };
}

function succeed(env: GitStatusEnvelope): ToolResult {
  return { success: true, output: JSON.stringify(env) };
}

/**
 * Parse `git status --porcelain=v1 --branch` output into the structured
 * envelope. The first line is the branch header (e.g. `## main...origin/main
 * [ahead 1, behind 2]`); every subsequent line is `XY path` where X and Y
 * are 1-character status codes.
 */
function parsePorcelainV1(raw: string): GitStatusEnvelope {
  const lines = raw.split('\n');
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith('## ')) {
      const header = line.slice(3);
      // Shapes observed:
      //   `branch...upstream [ahead N, behind M]`
      //   `branch`
      //   `HEAD (no branch)`
      //   `No commits yet on branch`  (freshly-init repo with no commits)
      const noCommitsPrefix = 'No commits yet on ';
      if (header.startsWith(noCommitsPrefix)) {
        branch = header.slice(noCommitsPrefix.length).trim();
      } else {
        const bracketIdx = header.indexOf(' [');
        const beforeBracket = bracketIdx >= 0 ? header.slice(0, bracketIdx) : header;
        const tripleDot = beforeBracket.indexOf('...');
        branch = tripleDot >= 0 ? beforeBracket.slice(0, tripleDot) : beforeBracket;
      }
      const aheadMatch = /ahead (\d+)/.exec(header);
      const behindMatch = /behind (\d+)/.exec(header);
      if (aheadMatch?.[1] !== undefined) ahead = Number(aheadMatch[1]);
      if (behindMatch?.[1] !== undefined) behind = Number(behindMatch[1]);
      continue;
    }
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    const filePath = line.slice(3);
    if (code === '??') {
      untracked.push(filePath);
      continue;
    }
    // Index (X) side — anything non-space/non-? is "staged".
    const x = code[0] ?? ' ';
    const y = code[1] ?? ' ';
    if (x !== ' ' && x !== '?') staged.push(filePath);
    if (y !== ' ' && y !== '?') modified.push(filePath);
  }

  return { branch, ahead, behind, staged, modified, untracked, raw };
}

export async function gitStatus(
  args: GitStatusArgs,
  ctx: GitToolContext,
): Promise<ToolResult> {
  const parsed = GitStatusArgsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return fail(`Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  if (!isGitRepo(ctx.projectRoot)) {
    return fail(`Not a git repository: ${ctx.projectRoot}`);
  }

  // Always pull porcelain output for stable parsing. `short` controls
  // whether we ALSO override `raw` with a human-readable `git status` body.
  // Either way the parsed fields are identical, so callers get structured
  // data regardless.
  const porcelain = await runGit(ctx, ['status', '--porcelain=v1', '--branch']);
  if (porcelain.code !== 0) {
    return fail(porcelain.stderr.trim() || `git status failed (exit ${porcelain.code})`);
  }
  const envelope = parsePorcelainV1(porcelain.stdout);
  if (parsed.data.short !== true) {
    // Replace `raw` with the human-readable output if available; falls
    // back silently to the porcelain text on error.
    const human = await runGit(ctx, ['status']);
    if (human.code === 0) envelope.raw = human.stdout;
  }
  return succeed(envelope);
}
