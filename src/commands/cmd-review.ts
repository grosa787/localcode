/**
 * /review — code review command (FIX #36, Round-6).
 *
 * Three target modes detected from the single argument:
 *
 *   /review                  → whole-project review. Walks the project
 *                              tree (top-level + 1-level deep, capped
 *                              at {@link DIRECTORY_ENTRY_LIMIT} entries)
 *                              and asks the model to call out 3-5 key
 *                              concerns (security, scalability, code
 *                              quality). The tree is sent as a plain
 *                              string — file CONTENT is NOT inlined,
 *                              the model is expected to use `read_file`
 *                              to dive deeper if it wants.
 *   /review src/foo.ts       → single-file review. Reads the file
 *                              (capped at {@link FILE_CONTENT_LIMIT}
 *                              chars to keep the prompt under ~7.5K
 *                              tokens) and asks for structured findings:
 *                              severity / category / location /
 *                              description / suggestion.
 *   /review HEAD~3..HEAD     → git-range review. Runs `git diff <range>`,
 *                              caps the diff at {@link DIFF_CONTENT_LIMIT}
 *                              chars, sends a PR-review prompt asking
 *                              for the same structured findings shape.
 *
 * Detection rules (single-argument heuristics):
 *   - empty            → whole project
 *   - contains `..`    → git range (covers `HEAD~3..HEAD`, `main..feat`,
 *                                  `HEAD~3...main`, etc)
 *   - 7+ hex chars     → bare commit SHA (treated as a git diff vs
 *                        working tree, matches `git diff <sha>`)
 *   - otherwise        → file path (resolved against `projectRoot`)
 *
 * The command does NOT open a UI overlay — it simply streams the
 * model's reply through `ctx.print` line by line. Existing tools
 * registered on the chat session (e.g. `read_file`) are still available
 * to the model when it acts on a side-channel turn, but here we pass
 * `tools: []` because review is a one-shot narrative response — we
 * don't want the model burning a turn on tool calls inside the review
 * itself. The user can always follow up with another message if they
 * want the model to actually read more files.
 *
 * Failure modes:
 *   - Missing file path                → "File not found: <path>".
 *   - File too big                     → truncated with explicit notice.
 *   - `git diff` failure for a range   → surfaced via `ctx.print`,
 *                                        no prompt sent.
 *   - LLM stream error                 → "Review failed: <msg>".
 */

import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

import type {
  CommandContext,
  Message,
  SlashCommand,
} from '@/types/global';
import type { StreamChatParams } from '@/types/message';

// ---------- Limits ----------

/**
 * Hard cap on file-content / diff bytes embedded in the prompt. Keeps
 * the request under ~7.5K tokens at our 4-chars-per-token estimate so
 * we don't blow the model's context window on a single huge file.
 */
const FILE_CONTENT_LIMIT = 30_000;
const DIFF_CONTENT_LIMIT = 30_000;

/** Max top-level entries listed in the whole-project tree summary. */
const DIRECTORY_ENTRY_LIMIT = 200;

/** How deep `walkTopLevel` recurses (1 = only top-level + immediate children). */
const DIRECTORY_MAX_DEPTH = 2;

/**
 * Directories the project-tree walker always skips. Mirrors the
 * gitignore-style skip-list used by `src/init/project-scanner.ts` —
 * this list is intentionally small (no need to re-derive `.gitignore`
 * at this layer; the goal is just to avoid drowning in vendored code).
 */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.localcode',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  'coverage',
  '.cache',
]);

const REVIEW_NAME = 'review';
const REVIEW_DESCRIPTION =
  'Code review by the model: a single file, a git range, or the whole project.';
const REVIEW_USAGE =
  '/review [path | git-range | empty for whole project]';

// ---------- Adapter contract ----------

/**
 * Minimal LLM-adapter surface needed by `/review`. Mirrors
 * {@link CompressLLM} from `cmd-compress.ts` so callers wire the
 * exact same thin shim through. We DO NOT depend on the full
 * `LLMAdapter` here — keeps the command unit-testable with a stub.
 */
export interface ReviewLLM {
  streamChat: (params: StreamChatParams) => Promise<void>;
}

export interface ReviewDeps {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Thin LLM adapter — only `streamChat` is needed. */
  llm: ReviewLLM;
}

// ---------- Factory ----------

export function createReviewCommand(deps: ReviewDeps): SlashCommand {
  const { projectRoot, llm } = deps;

  return {
    name: REVIEW_NAME,
    description: REVIEW_DESCRIPTION,
    usage: REVIEW_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const target = args.trim();

      let prompt: string;
      if (target.length === 0) {
        prompt = await buildProjectPrompt(projectRoot, ctx);
        if (prompt.length === 0) return; // builder already printed an error
      } else if (looksLikeGitRange(target)) {
        const built = await buildGitRangePrompt(projectRoot, target, ctx);
        if (built === null) return;
        prompt = built;
      } else {
        const built = buildFilePrompt(projectRoot, target, ctx);
        if (built === null) return;
        prompt = built;
      }

      ctx.print('Running review…');

      try {
        await runReview(llm, prompt, ctx);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Review failed: ${msg}`);
      }
    },
  };
}

// ---------- Mode detection ----------

/**
 * True when the argument should be treated as a git range / commit
 * reference rather than a filesystem path. Matches:
 *   - any string containing `..`  (covers `A..B`, `A...B`)
 *   - bare commit SHAs of 7+ hex chars (e.g. `abc1234`, `deadbeef`)
 *
 * Intentionally conservative: a path like `./foo..bar` wouldn't be a
 * common file name, and if the user really has one they can prefix
 * with `./` (we'd still match `..` though, so caveat). The goal is to
 * make the common case cheap and unambiguous.
 */
export function looksLikeGitRange(target: string): boolean {
  if (target.includes('..')) return true;
  if (/^[a-f0-9]{7,}$/i.test(target)) return true;
  return false;
}

// ---------- Prompt builders ----------

/**
 * Whole-project prompt. Scans the project root with a depth-limited
 * walker, formats the entries as a plain text tree, and asks the
 * model for 3-5 high-level concerns. Returns '' on scan failure
 * (after printing the reason via `ctx.print`).
 */
async function buildProjectPrompt(
  projectRoot: string,
  ctx: CommandContext,
): Promise<string> {
  let tree: string;
  try {
    tree = await listDirSummary(projectRoot);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to scan project for review: ${msg}`);
    return '';
  }

  if (tree.length === 0) {
    ctx.print('Project root appears empty — nothing to review.');
    return '';
  }

  return [
    'You are reviewing this codebase. Identify 3-5 key concerns at the project level.',
    'Focus areas: security, scalability, code quality, dependency hygiene.',
    'For each concern, suggest a concrete next step the developer can take.',
    'Use `read_file` if you need to dive into a specific file before drawing conclusions.',
    '',
    'Project structure (top-level + 1-level deep):',
    tree,
  ].join('\n');
}

/**
 * Single-file prompt. Reads the file synchronously (caller's
 * responsibility — these are user-supplied paths inside the project
 * root so this is safe) and packages it inside a fenced code block
 * for the model. Returns null on failure, after printing the cause.
 */
function buildFilePrompt(
  projectRoot: string,
  relPath: string,
  ctx: CommandContext,
): string | null {
  const fullPath = path.isAbsolute(relPath)
    ? relPath
    : path.resolve(projectRoot, relPath);

  if (!fs.existsSync(fullPath)) {
    ctx.print(`File not found: ${relPath}`);
    return null;
  }

  let content: string;
  try {
    content = fs.readFileSync(fullPath, 'utf-8');
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to read ${relPath}: ${msg}`);
    return null;
  }

  const truncated = content.length > FILE_CONTENT_LIMIT;
  const body = truncated
    ? `${content.slice(0, FILE_CONTENT_LIMIT)}\n\n[... truncated ${content.length - FILE_CONTENT_LIMIT} more chars ...]`
    : content;

  return [
    `Review this file: ${relPath}`,
    '',
    'Output structured findings, one per issue:',
    '- Severity: critical / high / medium / low',
    '- Category: security / performance / style / correctness',
    '- Location: line:col',
    '- Description: <one-paragraph explanation>',
    '- Suggestion: <concrete fix>',
    '',
    'If the file is fine, say so explicitly — do not invent issues.',
    '',
    'File content:',
    '```',
    body,
    '```',
  ].join('\n');
}

/**
 * Git-range prompt. Runs `git diff <range>` and embeds the (capped)
 * diff in a PR-review prompt. Returns null on failure, after
 * printing the cause.
 */
async function buildGitRangePrompt(
  projectRoot: string,
  range: string,
  ctx: CommandContext,
): Promise<string | null> {
  let stdout = '';
  let stderr = '';
  let failed = false;
  try {
    const result = await execa('git', ['diff', range], {
      cwd: projectRoot,
      reject: false,
    });
    stdout = typeof result.stdout === 'string' ? result.stdout : '';
    stderr = typeof result.stderr === 'string' ? result.stderr : '';
    failed =
      result.failed === true ||
      (typeof result.exitCode === 'number' && result.exitCode !== 0);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`git diff failed: ${msg}`);
    return null;
  }

  if (failed) {
    const reason = stderr.trim().length > 0 ? stderr.trim() : 'unknown error';
    ctx.print(`git diff failed: ${reason}`);
    return null;
  }

  if (stdout.length === 0) {
    ctx.print(`No diff produced for range ${range} — nothing to review.`);
    return null;
  }

  const truncated = stdout.length > DIFF_CONTENT_LIMIT;
  const body = truncated
    ? `${stdout.slice(0, DIFF_CONTENT_LIMIT)}\n\n[... truncated ${stdout.length - DIFF_CONTENT_LIMIT} more chars ...]`
    : stdout;

  return [
    `Review this git diff (range: ${range}). Treat this as a PR review.`,
    '',
    'Output structured findings, one per issue:',
    '- Severity: critical / high / medium / low',
    '- Category: security / performance / style / correctness',
    '- Location: file:line',
    '- Description: <what is wrong>',
    '- Suggestion: <concrete fix>',
    '',
    'If the diff is clean, say so explicitly — do not invent issues.',
    '',
    'Diff:',
    '```diff',
    body,
    '```',
  ].join('\n');
}

// ---------- Filesystem walker ----------

/**
 * Build a depth-limited textual tree of the project. Top-level entries
 * are listed first, and any directory at depth 1 has its immediate
 * children appended underneath, indented by two spaces. Skips
 * vendored/build dirs ({@link SKIP_DIR_NAMES}) and dotfiles whose
 * names start with `.localcode` (we still want to see `.github`,
 * `.gitignore`, etc — they're meaningful for the review).
 *
 * Caps the rendered output at {@link DIRECTORY_ENTRY_LIMIT} entries
 * across all depths to keep the prompt small. The cap is checked AS
 * we collect, so we never accidentally serialise a 10K-entry tree.
 */
export async function listDirSummary(root: string): Promise<string> {
  const lines: string[] = [];
  let count = 0;

  await walkTopLevel(root, '', 0, (entry) => {
    if (count >= DIRECTORY_ENTRY_LIMIT) return false;
    lines.push(entry);
    count += 1;
    return count < DIRECTORY_ENTRY_LIMIT;
  });

  if (count >= DIRECTORY_ENTRY_LIMIT) {
    lines.push(`  …(truncated at ${DIRECTORY_ENTRY_LIMIT} entries)`);
  }

  return lines.join('\n');
}

/**
 * Recursive walker used by {@link listDirSummary}. Calls `emit` once
 * per entry; if `emit` returns false, walking stops immediately. Skips
 * any directory whose basename is in {@link SKIP_DIR_NAMES}.
 *
 * Errors reading individual directories are swallowed — we still want
 * a partial tree if a single subdir is unreadable. The top-level
 * `readdir` error propagates out (caller handles it).
 */
async function walkTopLevel(
  dir: string,
  prefix: string,
  depth: number,
  emit: (entry: string) => boolean,
): Promise<void> {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  // Stable, predictable order: directories first, then files,
  // alphabetically within each group. Makes the rendered tree readable
  // and tests deterministic.
  const sorted = dirents.slice().sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const isDir = entry.isDirectory();
    const label = `${prefix}${entry.name}${isDir ? '/' : ''}`;
    if (!emit(label)) return;

    if (isDir && depth + 1 < DIRECTORY_MAX_DEPTH) {
      const sub = path.join(dir, entry.name);
      try {
        await walkTopLevel(sub, `${prefix}  `, depth + 1, emit);
      } catch {
        // Unreadable subdir — continue with siblings.
      }
    }
  }
}

// ---------- LLM stream driver ----------

/**
 * Run a single one-shot streamed chat with the supplied prompt as the
 * sole user message. Streams visible bytes via `ctx.print` and resolves
 * once `onDone` fires. Throws on stream-level errors so the caller can
 * surface them with a uniform "Review failed: …" prefix.
 */
async function runReview(
  llm: ReviewLLM,
  prompt: string,
  ctx: CommandContext,
): Promise<void> {
  const now = Date.now();

  // Buffer chunks so we print on line boundaries — `ctx.print`
  // produces one chat row per call, so streaming character-by-character
  // would explode the scrollback. Hold partial lines in `buffer` and
  // flush as soon as we see a newline.
  let buffer = '';
  const flushLine = (line: string): void => {
    // Empty lines are still meaningful (paragraph breaks); print them
    // verbatim. The `print` API treats each call as a new chat row.
    ctx.print(line);
  };

  await new Promise<void>((resolve, reject) => {
    void llm
      .streamChat({
        messages: [
          {
            id: `review-sys-${now.toString(36)}`,
            role: 'system',
            content:
              'You are a senior code reviewer. Be concise, concrete, and actionable. Do not invent issues.',
            createdAt: now,
          },
          {
            id: `review-usr-${now.toString(36)}`,
            role: 'user',
            content: prompt,
            createdAt: now,
          },
        ] satisfies Message[],
        // No tools — review is a one-shot narrative response. The
        // user can follow up in chat if they want the model to use
        // `read_file` etc.
        tools: [],
        onChunk: (text: string): void => {
          buffer += text;
          // Drain every complete line in `buffer`.
          let idx = buffer.indexOf('\n');
          while (idx !== -1) {
            const line = buffer.slice(0, idx);
            flushLine(line);
            buffer = buffer.slice(idx + 1);
            idx = buffer.indexOf('\n');
          }
        },
        onToolCalls: (): void => {
          // No tools allowed for review — silently ignore.
        },
        onDone: (result): void => {
          // Flush any trailing partial line so the user doesn't lose
          // the last sentence of the review when the model omits a
          // final newline.
          if (buffer.length > 0) {
            flushLine(buffer);
            buffer = '';
          }
          if (result.error !== undefined && result.error.length > 0) {
            reject(new Error(result.error));
            return;
          }
          resolve();
        },
      })
      .catch((cause: unknown) => {
        // `streamChat` documents itself as not throwing post-connection,
        // but defensive: surface any pre-stream errors as a rejection.
        const msg = cause instanceof Error ? cause.message : String(cause);
        reject(new Error(msg));
      });
  });
}
