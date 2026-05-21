/**
 * `git_diff` tool — read-only unified diff of the working tree.
 *
 * Runs `git diff [--staged] [-- <path>]`. Output is capped at 100 KB so a
 * single huge refactor can't blow up the context window — the cap footer
 * tells the model how to inspect more if needed.
 */

import path from 'node:path';
import { z } from 'zod';

import { type GitToolContext, isGitRepo, runGit } from './git-status';
import type { ToolResult } from './types';

const DIFF_CAP_BYTES = 100_000;

export const GitDiffArgsSchema = z.object({
  path: z.string().min(1).optional(),
  staged: z.boolean().optional(),
});

export type GitDiffArgs = z.infer<typeof GitDiffArgsSchema>;

export interface GitDiffEnvelope {
  staged: boolean;
  path: string | null;
  diff: string;
  truncated: boolean;
  sizeBytes: number;
}

function fail(message: string): ToolResult {
  return { success: false, output: '', error: message };
}

function succeed(env: GitDiffEnvelope): ToolResult {
  return { success: true, output: JSON.stringify(env) };
}

function cap(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= DIFF_CAP_BYTES) return { text: raw, truncated: false };
  const head = raw.slice(0, DIFF_CAP_BYTES);
  const footer = `\n[diff truncated at ${DIFF_CAP_BYTES} bytes — re-run git diff manually to inspect more]`;
  return { text: `${head}${footer}`, truncated: true };
}

export async function gitDiff(
  args: GitDiffArgs,
  ctx: GitToolContext,
): Promise<ToolResult> {
  const parsed = GitDiffArgsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return fail(`Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  if (!isGitRepo(ctx.projectRoot)) {
    return fail(`Not a git repository: ${ctx.projectRoot}`);
  }

  const argv: string[] = ['diff'];
  if (parsed.data.staged === true) argv.push('--staged');
  if (parsed.data.path !== undefined) {
    let p = parsed.data.path;
    if (path.isAbsolute(p) && p.startsWith(ctx.projectRoot)) {
      p = path.relative(ctx.projectRoot, p);
    }
    argv.push('--', p);
  }

  const result = await runGit(ctx, argv);
  if (result.code !== 0) {
    return fail(result.stderr.trim() || `git diff failed (exit ${result.code})`);
  }

  const { text, truncated } = cap(result.stdout);
  return succeed({
    staged: parsed.data.staged === true,
    path: parsed.data.path ?? null,
    diff: text,
    truncated,
    sizeBytes: result.stdout.length,
  });
}
