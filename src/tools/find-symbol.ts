/**
 * `find_symbol` tool — regex-based symbol search across the project
 * (ROADMAP #11 — simplified, no tree-sitter).
 *
 * Walks the project tree via `fast-glob`, classifies each file by its
 * extension, and runs a small set of language-aware regexes to locate
 * declarations matching the given symbol name. The result is formatted
 * as one line per occurrence with a 1-based file:line:column header
 * and a single-line context preview.
 *
 * Caps:
 *   - Up to MAX_FILES (1000) files are scanned.
 *   - Up to MAX_MATCHES (50) matches are returned.
 * Both limits are reflected in the output footer when reached so the
 * model knows the result is partial.
 *
 * Read-only, no approval required.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';

import type { FindSymbolArgs, ToolContext, ToolResult } from './types';

/** Allowed kinds; `'any'` is the wildcard fallback. */
export const FIND_SYMBOL_KINDS = [
  'function',
  'class',
  'interface',
  'type',
  'const',
  'variable',
  'any',
] as const;

/** Zod schema for `find_symbol` arguments. */
export const FindSymbolArgsSchema = z.object({
  name: z.string().min(1, 'name must be a non-empty string'),
  kind: z.enum(FIND_SYMBOL_KINDS).optional(),
});

const MAX_FILES = 1000;
const MAX_MATCHES = 50;

/**
 * Directories that are always skipped — large, generated, or VCS metadata.
 * `fast-glob` ignore globs apply uniformly.
 */
const DEFAULT_IGNORE: readonly string[] = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  '.cache/**',
  '.localcode/**',
  '.next/**',
  'target/**', // Rust build dir
  '**/__pycache__/**',
  '**/*.min.js',
  '**/*.lock',
  'bun.lock',
  'package-lock.json',
];

/** Extensions we recognise → language identifier. */
type Lang = 'ts' | 'py' | 'go' | 'rs' | 'java' | 'other';

const EXT_TO_LANG: ReadonlyMap<string, Lang> = new Map([
  ['.ts', 'ts'],
  ['.tsx', 'ts'],
  ['.js', 'ts'],
  ['.jsx', 'ts'],
  ['.mjs', 'ts'],
  ['.cjs', 'ts'],
  ['.py', 'py'],
  ['.go', 'go'],
  ['.rs', 'rs'],
  ['.java', 'java'],
]);

function languageFor(filePath: string): Lang {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG.get(ext) ?? 'other';
}

/**
 * Escape a string for safe use inside a RegExp source. The set covers
 * every metachar that can appear in JS regex.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Single match record produced by the per-language scanner. */
interface SymbolMatch {
  file: string;
  /** 1-based line number. */
  line: number;
  /** 0-based column index where the matching declaration begins. */
  column: number;
  /** Trimmed line text used as the result preview. */
  preview: string;
}

/** A compiled regex paired with the kind it represents. */
interface KindRegex {
  re: RegExp;
  kind: string;
  /**
   * `true` when the regex source is line-start-anchored via the
   * `(?:^|\n)` prefix. For per-line scanning we strip the prefix and
   * anchor on `^` instead. `false` means the regex is intended to match
   * anywhere in the line (e.g. the plain word-boundary fallback).
   */
  lineAnchored: boolean;
}

/**
 * Build the array of regexes to evaluate per file for the requested
 * `kind`. When `kind === 'any'` (or omitted) we run the union for the
 * detected language; when the file is in an unknown language we fall
 * back to a plain word-boundary match.
 *
 * Each regex is anchored to a line start with `(^|\n)` and uses
 * non-capturing groups so the offset of the matched name can be
 * recovered from `match.index + (leading-newline ? 1 : 0)`.
 */
function buildRegexes(name: string, lang: Lang, kind: string): KindRegex[] {
  const n = escapeRegex(name);
  const regexes: KindRegex[] = [];

  // Always-on plain word-boundary fallback. `lineAnchored: false` so
  // the per-line scanner doesn't try to anchor it on `^`.
  const plain: KindRegex = {
    re: new RegExp(`\\b${n}\\b`),
    kind: 'any',
    lineAnchored: false,
  };

  if (lang === 'other') {
    return [plain];
  }

  // Helper to keep the per-language tables tight.
  const la = (re: RegExp, k: string): KindRegex => ({
    re,
    kind: k,
    lineAnchored: true,
  });

  // For each language we provide a per-kind catalogue. The keys must
  // line up with `FIND_SYMBOL_KINDS`. When `kind` is 'any' we union
  // every entry for the language.
  switch (lang) {
    case 'ts': {
      const all: ReadonlyArray<KindRegex> = [
        la(new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${n}\\b`), 'function'),
        la(new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`), 'class'),
        la(new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?interface\\s+${n}\\b`), 'interface'),
        la(new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?type\\s+${n}\\b`), 'type'),
        la(new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${n}\\b`), 'const'),
        la(new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:let|var)\\s+${n}\\b`), 'variable'),
        // Method declarations inside a class — heuristic: indent + name(.
        la(new RegExp(`(?:^|\\n)\\s+(?:public|private|protected|static|async)?\\s*${n}\\s*\\(`), 'function'),
      ];
      pushKind(all, kind, regexes);
      break;
    }
    case 'py': {
      const all: ReadonlyArray<KindRegex> = [
        la(new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?def\\s+${n}\\b`), 'function'),
        la(new RegExp(`(?:^|\\n)\\s*class\\s+${n}\\b`), 'class'),
        // Module-level / class-level assignment.
        la(new RegExp(`(?:^|\\n)\\s*${n}\\s*=`), 'variable'),
      ];
      pushKind(all, kind, regexes);
      break;
    }
    case 'go': {
      const all: ReadonlyArray<KindRegex> = [
        // Plain function: `func NAME(`.
        la(new RegExp(`(?:^|\\n)func\\s+${n}\\s*\\(`), 'function'),
        // Method on a receiver: `func (r Recv) NAME(`.
        la(new RegExp(`(?:^|\\n)func\\s*\\([^)]+\\)\\s+${n}\\s*\\(`), 'function'),
        la(new RegExp(`(?:^|\\n)type\\s+${n}\\b`), 'type'),
        la(new RegExp(`(?:^|\\n)\\s*(?:var|const)\\s+${n}\\b`), 'variable'),
      ];
      pushKind(all, kind, regexes);
      break;
    }
    case 'rs': {
      const all: ReadonlyArray<KindRegex> = [
        la(new RegExp(`(?:^|\\n)\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${n}\\b`), 'function'),
        la(new RegExp(`(?:^|\\n)\\s*(?:pub\\s+)?struct\\s+${n}\\b`), 'class'),
        la(new RegExp(`(?:^|\\n)\\s*(?:pub\\s+)?enum\\s+${n}\\b`), 'type'),
        la(new RegExp(`(?:^|\\n)\\s*(?:pub\\s+)?trait\\s+${n}\\b`), 'interface'),
        la(new RegExp(`(?:^|\\n)\\s*let\\s+(?:mut\\s+)?${n}\\b`), 'variable'),
        la(new RegExp(`(?:^|\\n)\\s*(?:pub\\s+)?const\\s+${n}\\b`), 'const'),
      ];
      pushKind(all, kind, regexes);
      break;
    }
    case 'java': {
      const all: ReadonlyArray<KindRegex> = [
        la(new RegExp(`(?:^|\\n)\\s*(?:public|private|protected)?\\s*(?:static\\s+)?(?:final\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`), 'class'),
        la(new RegExp(`(?:^|\\n)\\s*(?:public|private|protected)?\\s*interface\\s+${n}\\b`), 'interface'),
        // Method-ish: identifier followed by ( and a {. Best-effort.
        la(new RegExp(`(?:^|\\n)\\s+(?:public|private|protected|static|final|abstract|synchronized|native)?[^=;\\n]*?\\b${n}\\s*\\([^)]*\\)\\s*\\{`), 'function'),
      ];
      pushKind(all, kind, regexes);
      break;
    }
  }

  // Round out 'any' with the plain word-boundary regex so callers can
  // locate references in comments, imports, etc. (Lower priority — it
  // only contributes when no specific regex caught the line.)
  if (kind === 'any' || regexes.length === 0) {
    regexes.push(plain);
  }

  return regexes;
}

function pushKind(
  all: ReadonlyArray<KindRegex>,
  kind: string,
  out: KindRegex[],
): void {
  if (kind === 'any') {
    out.push(...all);
    return;
  }
  for (const item of all) {
    if (item.kind === kind) out.push(item);
  }
}

/**
 * Run every regex from `regexes` against `text`. We walk the file's
 * lines once and check each regex per line; matching by line keeps
 * the column/line bookkeeping simple and avoids cross-line matches we
 * don't want.
 */
function scanFile(
  relPath: string,
  text: string,
  regexes: ReadonlyArray<KindRegex>,
  needleName: string,
): SymbolMatch[] {
  if (regexes.length === 0) return [];

  // For per-line scanning each regex is normalised to operate on a
  // single line. Line-anchored regexes (`(?:^|\n)`-prefixed) get
  // re-anchored on `^`; free-floating regexes (the plain word-boundary
  // fallback) keep their original source.
  const perLine = regexes.map((r) => {
    if (r.lineAnchored) {
      const src = r.re.source.replace(/^\(\?:\^\|\\n\)/, '');
      return { re: new RegExp(`^${src}`), kind: r.kind };
    }
    return { re: new RegExp(r.re.source), kind: r.kind };
  });

  const matches: SymbolMatch[] = [];
  const lines = text.split('\n');
  const escName = escapeRegex(needleName);
  const nameLocator = new RegExp(`\\b${escName}\\b`);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    let hit = false;
    for (const { re } of perLine) {
      if (re.test(line)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    // Locate the column of the symbol name within the line for a
    // user-friendly cursor position.
    const nm = line.match(nameLocator);
    const column = nm && nm.index !== undefined ? nm.index : 0;
    matches.push({
      file: relPath,
      line: i + 1,
      column,
      preview: line.trimEnd(),
    });
    if (matches.length >= MAX_MATCHES) break;
  }
  return matches;
}

/**
 * Format the list of matches into the output string described in the
 * tool spec. The first line is a header summarising the count.
 */
function formatMatches(name: string, matches: ReadonlyArray<SymbolMatch>): string {
  if (matches.length === 0) {
    return `No occurrences of "${name}" found. Try broadening kind to 'any'.`;
  }
  const header = `Found ${matches.length}${matches.length >= MAX_MATCHES ? '+' : ''} occurrences of "${name}":`;
  const body = matches
    .map((m) => `  ${m.file}:${m.line}:${m.column}  — ${m.preview}`)
    .join('\n');
  return `${header}\n${body}`;
}

/**
 * Resolve `cwd` (always `ctx.projectRoot` for this tool — there is no
 * argument to override it; this keeps path-traversal exposure minimal).
 */
async function listProjectFiles(projectRoot: string): Promise<string[]> {
  const files = await fg('**/*', {
    cwd: projectRoot,
    ignore: [...DEFAULT_IGNORE],
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
  return files;
}

export async function findSymbol(
  args: FindSymbolArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = FindSymbolArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const { name, kind: rawKind } = parsed.data;
  const kind = rawKind ?? 'any';

  // Path-traversal guard: ensure the project root is an absolute path
  // we can actually scan. ToolContext invariants already enforce this
  // for every other tool, but we re-resolve defensively.
  const projectRoot = path.resolve(ctx.projectRoot);

  let allFiles: string[];
  try {
    allFiles = await listProjectFiles(projectRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `find_symbol failed to enumerate files: ${message}`,
    };
  }

  // Cap the file set early — large monorepos can have tens of
  // thousands of files; we don't want to read all of them.
  const truncatedFiles = allFiles.length > MAX_FILES;
  const files = truncatedFiles ? allFiles.slice(0, MAX_FILES) : allFiles;

  const matches: SymbolMatch[] = [];
  for (const rel of files) {
    if (matches.length >= MAX_MATCHES) break;
    const lang = languageFor(rel);
    const regexes = buildRegexes(name, lang, kind);
    if (regexes.length === 0) continue;

    const absolutePath = path.join(projectRoot, rel);
    let text: string;
    try {
      text = await fs.readFile(absolutePath, 'utf8');
    } catch {
      // Binary / permission-denied / vanished mid-walk — skip silently.
      continue;
    }
    // Cheap pre-filter: skip files that don't even contain the bare
    // identifier. Avoids running multiple regexes against unrelated text.
    if (!text.includes(name)) continue;

    const fileMatches = scanFile(rel, text, regexes, name);
    for (const m of fileMatches) {
      matches.push(m);
      if (matches.length >= MAX_MATCHES) break;
    }
  }

  let output = formatMatches(name, matches);
  if (truncatedFiles && matches.length < MAX_MATCHES) {
    output += `\n[file scan truncated at ${MAX_FILES}/${allFiles.length} files; consider narrowing kind or using glob_search]`;
  }
  if (matches.length >= MAX_MATCHES) {
    output += `\n[match cap reached: showing first ${MAX_MATCHES}; refine kind to narrow results]`;
  }

  return { success: true, output };
}
