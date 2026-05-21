/**
 * `git_commit` tool — two-phase commit with mandatory approval.
 *
 * Phase 1 (`previewGitCommit`):
 *   - Validates args.
 *   - Refuses to run if the cwd isn't a git repo.
 *   - When `addAll` is true, runs `git diff HEAD` to show what WOULD be
 *     committed after `git add -A`. Otherwise runs `git diff --staged`
 *     to show what's already staged.
 *   - Returns a structured envelope tagged `requiresApproval: true`.
 *
 * Phase 2 (`commitGitCommit`):
 *   - Optionally runs `git add -A`.
 *   - Runs `git commit -m <message>`.
 *   - Returns the new HEAD hash via `git rev-parse HEAD`.
 *
 * Like every git tool here, we spawn via argv (no shell) so the commit
 * message cannot inject shell metacharacters.
 */

import { z } from 'zod';

import { type GitToolContext, isGitRepo, runGit } from './git-status';
import type { ToolResult } from './types';

const DIFF_CAP_BYTES = 50_000;

export const GitCommitArgsSchema = z.object({
  message: z.string().min(1, 'message must be a non-empty string'),
  addAll: z.boolean().optional(),
});

export type GitCommitArgs = z.infer<typeof GitCommitArgsSchema>;

function fail(message: string): ToolResult {
  return { success: false, output: '', error: message, requiresApproval: true };
}

function succeed(output: string): ToolResult {
  return { success: true, output, requiresApproval: true };
}

function cap(raw: string): string {
  if (raw.length <= DIFF_CAP_BYTES) return raw;
  return `${raw.slice(0, DIFF_CAP_BYTES)}\n[diff truncated at ${DIFF_CAP_BYTES} bytes]`;
}

export async function previewGitCommit(
  args: GitCommitArgs,
  ctx: GitToolContext,
): Promise<ToolResult> {
  const parsed = GitCommitArgsSchema.safeParse(args);
  if (!parsed.success) {
    return fail(`Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  if (!isGitRepo(ctx.projectRoot)) {
    return fail(`Not a git repository: ${ctx.projectRoot}`);
  }

  // Choose the diff scope that matches what `commit` will actually
  // include: HEAD-diff for addAll, staged-diff otherwise.
  const argv: string[] =
    parsed.data.addAll === true ? ['diff', 'HEAD'] : ['diff', '--staged'];
  const diff = await runGit(ctx, argv);
  if (diff.code !== 0) {
    return fail(diff.stderr.trim() || `git diff failed (exit ${diff.code})`);
  }
  const body = diff.stdout.length === 0
    ? '(no changes to commit)'
    : cap(diff.stdout);
  const summary = [
    `Will commit with message: ${parsed.data.message}`,
    `addAll: ${parsed.data.addAll === true ? 'true' : 'false'}`,
    '',
    body,
  ].join('\n');
  return succeed(summary);
}

export async function commitGitCommit(
  args: GitCommitArgs,
  ctx: GitToolContext,
): Promise<ToolResult> {
  const parsed = GitCommitArgsSchema.safeParse(args);
  if (!parsed.success) {
    return fail(`Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  if (!isGitRepo(ctx.projectRoot)) {
    return fail(`Not a git repository: ${ctx.projectRoot}`);
  }

  if (parsed.data.addAll === true) {
    const add = await runGit(ctx, ['add', '-A']);
    if (add.code !== 0) {
      return fail(add.stderr.trim() || `git add -A failed (exit ${add.code})`);
    }
  }

  const commit = await runGit(ctx, ['commit', '-m', parsed.data.message]);
  if (commit.code !== 0) {
    return fail(
      commit.stderr.trim() ||
        commit.stdout.trim() ||
        `git commit failed (exit ${commit.code})`,
    );
  }

  const rev = await runGit(ctx, ['rev-parse', 'HEAD']);
  const hash = rev.code === 0 ? rev.stdout.trim() : '(unknown)';
  return succeed(
    JSON.stringify({
      hash,
      message: parsed.data.message,
      addAll: parsed.data.addAll === true,
      output: commit.stdout.trim(),
    }),
  );
}
