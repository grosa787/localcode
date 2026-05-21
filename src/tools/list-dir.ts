/**
 * `list_dir` tool — recursive tree listing with depth + ignore filtering.
 *
 * Depth: max 5 levels.
 * Always excludes: node_modules, .git, dist, build, .cache, .localcode.
 * Also applies a minimal `.gitignore` matcher (literal names + simple
 * `*.ext` / `name/` / `name/**` patterns). A richer parser lives in
 * `src/init/gitignore-parser.ts` (Agent 7) but is intentionally NOT imported
 * here to keep this module self-contained.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { ListDirArgs, ToolContext, ToolResult } from './types';

/** Zod schema for `list_dir` arguments. */
export const ListDirArgsSchema = z.object({
  path: z.string().min(1).optional(),
});

const MAX_DEPTH = 5;

/** Built-in exclusions that apply in every project. */
const BUILTIN_IGNORES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  '.localcode',
]);

/** A compiled gitignore rule: literal name, extension glob, or directory match. */
interface GitignoreRule {
  kind: 'literal' | 'extension' | 'dirOnly';
  value: string;
}

function resolveInsideRoot(root: string, target: string): string | null {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(absoluteRoot, target);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return absoluteTarget;
}

/**
 * Minimal `.gitignore` parser — enough for common cases but deliberately
 * not complete. Supported forms:
 *   - blank lines / comments starting with `#`
 *   - literal names: `README.md`
 *   - extension globs: `*.log`, `*.tmp`
 *   - directory-only rules: `dist/`
 *   - double-star directory rules: `dist/**`
 * Unsupported forms are silently skipped.
 */
async function loadGitignoreRules(projectRoot: string): Promise<GitignoreRule[]> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let raw: string;
  try {
    raw = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    return [];
  }

  const rules: GitignoreRule[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // negations not supported here
    if (line.startsWith('/')) {
      const stripped = line.slice(1);
      if (stripped.length === 0) continue;
      rules.push({ kind: 'literal', value: stripped });
      continue;
    }
    if (line.endsWith('/**')) {
      rules.push({ kind: 'dirOnly', value: line.slice(0, -3) });
      continue;
    }
    if (line.endsWith('/')) {
      rules.push({ kind: 'dirOnly', value: line.slice(0, -1) });
      continue;
    }
    if (line.startsWith('*.') && !line.includes('/')) {
      rules.push({ kind: 'extension', value: line.slice(1) });
      continue;
    }
    if (!line.includes('/') && !line.includes('*')) {
      rules.push({ kind: 'literal', value: line });
      continue;
    }
    // Anything else — unsupported, skip.
  }
  return rules;
}

function matchesRule(name: string, isDir: boolean, rule: GitignoreRule): boolean {
  switch (rule.kind) {
    case 'literal':
      return name === rule.value;
    case 'extension':
      return !isDir && name.endsWith(rule.value);
    case 'dirOnly':
      return isDir && name === rule.value;
  }
}

function shouldExclude(
  name: string,
  isDir: boolean,
  rules: readonly GitignoreRule[],
): boolean {
  if (BUILTIN_IGNORES.has(name)) return true;
  for (const rule of rules) {
    if (matchesRule(name, isDir, rule)) return true;
  }
  return false;
}

interface WalkParams {
  absolutePath: string;
  displayName: string;
  depth: number;
  rules: readonly GitignoreRule[];
  lines: string[];
}

async function walk(params: WalkParams): Promise<void> {
  const { absolutePath, displayName, depth, rules, lines } = params;
  const indent = '  '.repeat(depth);
  lines.push(`${indent}${displayName}/`);

  if (depth >= MAX_DEPTH) {
    lines.push(`${indent}  [... max depth ${MAX_DEPTH} reached ...]`);
    return;
  }

  let entries: Array<{ name: string; isDir: boolean; isFile: boolean }>;
  try {
    const raw = await fs.readdir(absolutePath, { withFileTypes: true });
    entries = raw.map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
      isFile: e.isFile(),
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lines.push(`${indent}  [error reading directory: ${message}]`);
    return;
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (shouldExclude(entry.name, entry.isDir, rules)) continue;
    if (entry.isDir) {
      await walk({
        absolutePath: path.join(absolutePath, entry.name),
        displayName: entry.name,
        depth: depth + 1,
        rules,
        lines,
      });
    } else if (entry.isFile) {
      lines.push(`${'  '.repeat(depth + 1)}${entry.name}`);
    }
    // symlinks / sockets / other — skipped
  }
}

export async function listDir(
  args: ListDirArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = ListDirArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const relativeTarget = parsed.data.path ?? '.';
  const absoluteTarget = resolveInsideRoot(ctx.projectRoot, relativeTarget);
  if (absoluteTarget === null) {
    return {
      success: false,
      output: '',
      error: `Path traversal blocked: '${relativeTarget}' escapes project root`,
    };
  }

  try {
    const stat = await fs.stat(absoluteTarget);
    if (!stat.isDirectory()) {
      return {
        success: false,
        output: '',
        error: `Not a directory: '${relativeTarget}'`,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Failed to stat '${relativeTarget}': ${message}`,
    };
  }

  const rules = await loadGitignoreRules(ctx.projectRoot);
  const lines: string[] = [];
  const displayName =
    relativeTarget === '.' || relativeTarget === ''
      ? path.basename(path.resolve(ctx.projectRoot)) || 'root'
      : relativeTarget;

  await walk({
    absolutePath: absoluteTarget,
    displayName,
    depth: 0,
    rules,
    lines,
  });

  return { success: true, output: lines.join('\n') };
}
