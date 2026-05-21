/**
 * `git_log` tool — read-only commit history.
 *
 * Spawns `git log --pretty=format:<custom> -n <limit> [-- <path>]` via
 * argv (no shell). Returns an array of structured entries:
 *   { hash, message, author, date }
 *
 * Defaults: limit = 20, max = 200. Path is optional and is passed AFTER
 * `--` so it cannot be interpreted as a ref / flag.
 */

import path from 'node:path';
import { z } from 'zod';

import { type GitToolContext, isGitRepo, runGit } from './git-status';
import type { ToolResult } from './types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export const GitLogArgsSchema = z.object({
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
  path: z.string().min(1).optional(),
});

export type GitLogArgs = z.infer<typeof GitLogArgsSchema>;

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

function fail(message: string): ToolResult {
  return { success: false, output: '', error: message };
}

function succeed(entries: GitLogEntry[]): ToolResult {
  return { success: true, output: JSON.stringify({ entries }) };
}

/**
 * Record/field separators between commits and inside each commit. Chosen
 * to be ASCII control characters that are extremely unlikely to appear in
 * commit messages / author names / ISO dates.
 */
const RECORD_SEP = '\x1eRECORD\x1e';
const FIELD_SEP = '\x1fFIELD\x1f';

function parseLog(raw: string): GitLogEntry[] {
  const records = raw
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const entries: GitLogEntry[] = [];
  for (const rec of records) {
    const parts = rec.split(FIELD_SEP);
    const [hash, author, date, ...messageParts] = parts;
    const message = messageParts.join(FIELD_SEP);
    if (typeof hash !== 'string' || hash.length === 0) continue;
    entries.push({
      hash,
      author: author ?? '',
      date: date ?? '',
      message: (message ?? '').trim(),
    });
  }
  return entries;
}

export async function gitLog(
  args: GitLogArgs,
  ctx: GitToolContext,
): Promise<ToolResult> {
  const parsed = GitLogArgsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return fail(`Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  if (!isGitRepo(ctx.projectRoot)) {
    return fail(`Not a git repository: ${ctx.projectRoot}`);
  }

  const limit = parsed.data.limit ?? DEFAULT_LIMIT;
  // `--pretty=format:<hash>FIELD<author>FIELD<date>FIELD<message>RECORD`.
  const fmt = `format:%H${FIELD_SEP}%an${FIELD_SEP}%ad${FIELD_SEP}%s${RECORD_SEP}`;

  const argv: string[] = [
    'log',
    `--pretty=${fmt}`,
    '--date=iso-strict',
    '-n',
    String(limit),
  ];
  if (parsed.data.path !== undefined) {
    // Strip any absolute prefix that matches projectRoot so the model can
    // pass either form. We DO NOT realpath / containment-check here — git
    // itself only operates on paths inside the repo, and a path that
    // escapes simply yields a non-zero exit with stderr.
    let p = parsed.data.path;
    if (path.isAbsolute(p) && p.startsWith(ctx.projectRoot)) {
      p = path.relative(ctx.projectRoot, p);
    }
    argv.push('--', p);
  }

  const result = await runGit(ctx, argv);
  if (result.code !== 0) {
    return fail(result.stderr.trim() || `git log failed (exit ${result.code})`);
  }

  return succeed(parseLog(result.stdout));
}
