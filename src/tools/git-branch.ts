/**
 * `git_branch` tool — read-only inventory of local + remote branches.
 *
 * Combines `git branch --show-current` with `git branch -a` to produce:
 *   { current, all: string[] }
 *
 * The remote-tracking entries that git prints in the form
 * `remotes/origin/HEAD -> origin/main` are simplified to just the LHS so
 * the array is easy to scan.
 */

import { z } from 'zod';

import { type GitToolContext, isGitRepo, runGit } from './git-status';
import type { ToolResult } from './types';

export const GitBranchArgsSchema = z.object({}).strict();

export type GitBranchArgs = z.infer<typeof GitBranchArgsSchema>;

export interface GitBranchEnvelope {
  current: string | null;
  all: string[];
}

function fail(message: string): ToolResult {
  return { success: false, output: '', error: message };
}

function succeed(env: GitBranchEnvelope): ToolResult {
  return { success: true, output: JSON.stringify(env) };
}

export async function gitBranch(
  args: GitBranchArgs,
  ctx: GitToolContext,
): Promise<ToolResult> {
  const parsed = GitBranchArgsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return fail(`Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  if (!isGitRepo(ctx.projectRoot)) {
    return fail(`Not a git repository: ${ctx.projectRoot}`);
  }

  const showCurrent = await runGit(ctx, ['branch', '--show-current']);
  let current: string | null = null;
  if (showCurrent.code === 0) {
    const trimmed = showCurrent.stdout.trim();
    current = trimmed.length > 0 ? trimmed : null;
  }

  const allRes = await runGit(ctx, ['branch', '-a']);
  if (allRes.code !== 0) {
    return fail(allRes.stderr.trim() || `git branch -a failed (exit ${allRes.code})`);
  }
  const all = allRes.stdout
    .split('\n')
    .map((line) => line.replace(/^\*?\s+/, '').trim())
    .filter((line) => line.length > 0)
    // `remotes/origin/HEAD -> origin/main` → `remotes/origin/HEAD`.
    .map((line) => {
      const arrow = line.indexOf(' -> ');
      return arrow >= 0 ? line.slice(0, arrow) : line;
    });

  return succeed({ current, all });
}
