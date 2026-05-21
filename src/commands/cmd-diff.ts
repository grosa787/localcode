/**
 * /diff — full-screen, syntax-highlighted diff viewer.
 *
 * Replaces the previous text-only chat-stream implementation with an
 * interactive TUI overlay. The command resolves a set of {@link DiffEntry}
 * records from git or from the on-disk working tree and hands them off to
 * `<DiffViewer>` via the `openViewer` callback injected by the composition
 * root.
 *
 * Surface:
 *   /diff                       — diff of the working tree vs HEAD.
 *                                  Equivalent to `git diff HEAD`. We use
 *                                  this as the "all pending changes" view
 *                                  because the spec asked for "unsaved file
 *                                  changes (pending writes from current
 *                                  turn)" — in a TUI session pending writes
 *                                  are always written through the
 *                                  approval flow before commit, so the
 *                                  working tree IS the pending set.
 *   /diff HEAD                   — explicit working tree vs HEAD.
 *   /diff <commitA> <commitB>    — diff between two refs.
 *   /diff <filepath>             — single file vs HEAD.
 *
 * Failure modes:
 *   - Not a git repo                    → prints a friendly error to chat.
 *   - Unknown ref / file                → surfaces stderr verbatim.
 *   - `openViewer` not wired (no-op)    → falls back to the legacy text path.
 *
 * The viewer is a *pure presentation* surface; this module is the entire
 * data layer for `/diff`.
 */

import { execa } from 'execa';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import type {
  CommandContext,
  SlashCommand,
} from '@/types/global';

/**
 * One file's worth of before/after content. Consumed by `<DiffViewer>`
 * which computes the unified diff via the `diff` package at render
 * time so we never pre-cache an ANSI-coloured string.
 */
export interface DiffEntry {
  /** Project-relative or absolute file path used as the row title. */
  readonly filePath: string;
  /** Pre-change contents. Empty string when {@link mode} is `'created'`. */
  readonly before: string;
  /** Post-change contents. Empty string when {@link mode} is `'deleted'`. */
  readonly after: string;
  /** What happened to the file in this change set. */
  readonly mode: 'modified' | 'created' | 'deleted';
}

export interface DiffDeps {
  /** Absolute path to the git working tree (typically the project root). */
  readonly projectRoot: string;
  /**
   * Called when the command has assembled a non-empty `DiffEntry[]`. The
   * composition root (`app.tsx`) wires this to `setDiffEntries(entries)`
   * which mounts `<DiffViewer>`. Optional — when undefined the command
   * falls back to surfacing a chat message instead of opening the viewer.
   */
  readonly openViewer?: (entries: readonly DiffEntry[]) => void;
}

const DIFF_NAME = 'diff';
const DIFF_DESCRIPTION =
  'Open the full-screen diff viewer (pending changes, vs HEAD, between commits, or a single file).';
const DIFF_USAGE =
  '/diff [HEAD | <commitA> <commitB> | <filepath>]';

/**
 * Factory that returns the `/diff` SlashCommand with its dependencies
 * captured in a closure. No LLM dependency — pure git+fs.
 */
export function createDiffCommand(deps: DiffDeps): SlashCommand {
  return {
    name: DIFF_NAME,
    description: DIFF_DESCRIPTION,
    usage: DIFF_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];

      let entries: readonly DiffEntry[] = [];
      try {
        entries = await resolveDiffEntries(tokens, deps.projectRoot);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`/diff failed: ${msg}`);
        return;
      }

      if (entries.length === 0) {
        ctx.print('No changes.');
        return;
      }

      if (deps.openViewer !== undefined) {
        deps.openViewer(entries);
        return;
      }

      // Fallback: viewer not wired (e.g. headless tests). Surface a tiny
      // text summary so the user still sees what would have been shown.
      ctx.print(
        `Diff summary (${entries.length} file${entries.length === 1 ? '' : 's'}):`,
      );
      for (const e of entries) {
        ctx.print(`  [${e.mode}] ${e.filePath}`);
      }
    },
  };
}

// ---------- entry resolution ----------

/**
 * Translate the tokens after `/diff` into a list of {@link DiffEntry}.
 *
 * Token shapes recognised (in priority order):
 *   - []                 → working tree vs HEAD (all changed files).
 *   - ['HEAD']           → same as []; explicit form.
 *   - [<commitA>, <commitB>] → diff between two refs (if both look like
 *                              git refs and neither is a file path).
 *   - [<filepath>]       → single file vs HEAD. Recognised when the
 *                          single token resolves to an existing file in
 *                          the project root.
 *
 * Order matters: filepaths are checked AFTER the two-ref form, so a
 * directory named "HEAD~1" doesn't accidentally shadow `git diff HEAD~1`.
 * In practice the heuristic is "is it an existing path?" — we fall back
 * to ref-mode when the token doesn't match a file on disk.
 */
async function resolveDiffEntries(
  tokens: readonly string[],
  projectRoot: string,
): Promise<readonly DiffEntry[]> {
  if (tokens.length === 0) {
    return collectEntriesFromRefs(projectRoot, 'HEAD', null);
  }

  if (tokens.length === 1) {
    const tok = tokens[0] ?? '';
    // Single-file mode if the token names an existing tracked path.
    const looksLikeFile = await fileExists(projectRoot, tok);
    if (looksLikeFile) {
      return collectEntriesForFile(projectRoot, tok);
    }
    // Otherwise treat as a ref (e.g. `HEAD`, `main`, `abc1234`).
    return collectEntriesFromRefs(projectRoot, tok, null);
  }

  if (tokens.length === 2) {
    const [a, b] = tokens;
    if (a === undefined || b === undefined) {
      throw new Error('Invalid arguments.');
    }
    return collectEntriesFromRefs(projectRoot, a, b);
  }

  throw new Error(`Too many arguments (got ${tokens.length}, expected 0..2).`);
}

/**
 * Run `git diff --name-status [base] [head]` to enumerate changed files,
 * then `git show <ref>:<path>` for each side to materialise the
 * before/after content. When {@link head} is null we compare {@link base}
 * to the working tree (matches `git diff base`).
 */
async function collectEntriesFromRefs(
  projectRoot: string,
  base: string,
  head: string | null,
): Promise<readonly DiffEntry[]> {
  const argv: string[] = ['diff', '--name-status', '-z', base];
  if (head !== null) argv.push(head);

  const listing = await runGit(argv, projectRoot);
  // `-z` separates records with NUL; each record is "<status>\t<path>".
  // For renames it's "R<NN>\t<oldPath>\t<newPath>" — we coalesce the
  // shape into either a 2- or 3-element burst.
  const records = parseNameStatus(listing);

  const entries: DiffEntry[] = [];
  for (const rec of records) {
    if (rec.status.startsWith('A')) {
      // Added.
      const after = await readSide(projectRoot, head, rec.path);
      entries.push({
        filePath: rec.path,
        before: '',
        after,
        mode: 'created',
      });
      continue;
    }
    if (rec.status.startsWith('D')) {
      const before = await readSide(projectRoot, base, rec.path);
      entries.push({
        filePath: rec.path,
        before,
        after: '',
        mode: 'deleted',
      });
      continue;
    }
    if (rec.status.startsWith('R') && rec.renameTo !== undefined) {
      const before = await readSide(projectRoot, base, rec.path);
      const after = await readSide(projectRoot, head, rec.renameTo);
      entries.push({
        filePath: `${rec.path} → ${rec.renameTo}`,
        before,
        after,
        mode: 'modified',
      });
      continue;
    }
    // Default: modified.
    const before = await readSide(projectRoot, base, rec.path);
    const after = await readSide(projectRoot, head, rec.path);
    entries.push({
      filePath: rec.path,
      before,
      after,
      mode: 'modified',
    });
  }
  return entries;
}

async function collectEntriesForFile(
  projectRoot: string,
  filePath: string,
): Promise<readonly DiffEntry[]> {
  // Compare HEAD:<path> to working-tree contents.
  let before = '';
  try {
    before = await runGit(['show', `HEAD:${filePath}`], projectRoot);
  } catch {
    // File is untracked or HEAD missing — treat as a new file.
    before = '';
  }
  let after = '';
  try {
    after = await fs.readFile(path.join(projectRoot, filePath), 'utf8');
  } catch {
    // File deleted on disk.
    after = '';
  }
  if (before === after) return [];
  const mode: DiffEntry['mode'] =
    before.length === 0 ? 'created' : after.length === 0 ? 'deleted' : 'modified';
  return [{ filePath, before, after, mode }];
}

interface NameStatusRecord {
  readonly status: string;
  readonly path: string;
  readonly renameTo?: string;
}

function parseNameStatus(raw: string): readonly NameStatusRecord[] {
  // `git diff --name-status -z` emits each FIELD separated by NUL — the
  // status token (e.g. `M`, `A`, `D`, `R85`) is its own token, and the
  // path that follows is the next token. Rename records take three
  // tokens: `R<NN>`, `<oldPath>`, `<newPath>`.
  //
  // (Older callers sometimes saw a tab between status and path with -z;
  // modern git emits a pure NUL-delimited stream. We handle BOTH so a
  // host with an older git binary still works — if the token contains a
  // tab we split on it; otherwise we treat the status and path as
  // separate tokens.)
  const out: NameStatusRecord[] = [];
  const tokens = raw.split('\0').filter((s) => s.length > 0);
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] ?? '';
    const tabIdx = tok.indexOf('\t');
    let status: string;
    let p: string;
    if (tabIdx !== -1) {
      // Legacy form: status and path packed into a single token.
      status = tok.slice(0, tabIdx);
      p = tok.slice(tabIdx + 1);
    } else {
      // Modern -z form: status is a standalone token; path is next.
      status = tok;
      p = tokens[i + 1] ?? '';
      if (p.length === 0) continue;
      i += 1; // consume the path token we just read
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const next = tokens[i + 1] ?? '';
      out.push({ status, path: p, renameTo: next });
      i += 1; // consume the rename-to token
      continue;
    }
    out.push({ status, path: p });
  }
  return out;
}

/**
 * Read one side of the diff. `ref === null` means the working tree.
 */
async function readSide(
  projectRoot: string,
  ref: string | null,
  filePath: string,
): Promise<string> {
  if (ref === null) {
    try {
      return await fs.readFile(path.join(projectRoot, filePath), 'utf8');
    } catch {
      return '';
    }
  }
  try {
    return await runGit(['show', `${ref}:${filePath}`], projectRoot);
  } catch {
    return '';
  }
}

async function fileExists(projectRoot: string, candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(projectRoot, candidate));
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Thin wrapper around `execa('git', ...)`. Throws on non-zero exit with a
 * friendly message that includes stderr; the caller surfaces this to
 * `ctx.print`. Stdout is returned verbatim (no trimming — `git show` is
 * byte-faithful and trimming would corrupt files that end without a
 * trailing newline).
 */
async function runGit(argv: readonly string[], cwd: string): Promise<string> {
  let result;
  try {
    result = await execa('git', [...argv], { cwd, reject: false });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`git ${argv[0] ?? ''} failed to spawn: ${msg}`);
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const failed =
    result.failed === true ||
    (typeof result.exitCode === 'number' && result.exitCode !== 0);
  if (failed) {
    const stderrLower = stderr.toLowerCase();
    if (stderrLower.includes('not a git repository')) {
      throw new Error('Not a git repository or no changes.');
    }
    const reason = stderr.trim().length > 0 ? stderr.trim() : 'unknown error';
    throw new Error(reason);
  }
  return stdout;
}
