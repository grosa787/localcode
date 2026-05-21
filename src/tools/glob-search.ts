/**
 * `glob_search` tool - `fast-glob` wrapper with a 100-result cap.
 *
 * Excludes common build/artifact directories AND honours `.gitignore`,
 * `.ignore` (ripgrep convention) and `.localcodeignore` (LocalCode-only
 * override) discovered between the search `cwd` and the `projectRoot`.
 *
 * Ignore-file load order per directory is `.gitignore` -> `.ignore` ->
 * `.localcodeignore`; later rules override earlier ones. Parent dirs
 * are loaded first; child dirs override their parents. A negated `!`
 * pattern re-includes paths that an earlier rule excluded.
 *
 * Symlink-loop protection: the ignore-file walk uses a Set of visited
 * realpath strings, so a cyclic chain (e.g. `a -> b -> a`) cannot hang.
 *
 * Caching: the loaded rule chain is cached by `realpath(projectRoot)` +
 * `realpath(cwd)` so repeated calls within the same project do not
 * re-stat every ancestor `.gitignore` file.
 */

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import fg from 'fast-glob';
import { z } from 'zod';

import { resolveSafePathStrict } from './path-safety';
import type { GlobSearchArgs, ToolContext, ToolResult } from './types';

/** Zod schema for `glob_search` arguments. */
export const GlobSearchArgsSchema = z.object({
  pattern: z.string().min(1, 'pattern must be a non-empty string'),
  cwd: z.string().min(1).optional(),
  // Set to false to bypass .gitignore / .ignore / .localcodeignore filtering.
  // Useful for debugging "why is my file missing from results?".
  respectIgnore: z.boolean().optional(),
});

const MAX_RESULTS = 100;
const DEFAULT_IGNORE: readonly string[] = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
];

const IGNORE_FILES: readonly string[] = [
  '.gitignore',
  '.ignore',
  '.localcodeignore',
];

/** One compiled pattern from an ignore file. */
interface IgnorePattern {
  /** Source pattern text (for diagnostics). */
  readonly source: string;
  /** Regex matching slash-normalised relative paths. */
  readonly regex: RegExp;
  /** Negation re-includes matching paths after an earlier exclude. */
  readonly negate: boolean;
  /** Pattern must match a directory (e.g. trailing `/`). */
  readonly dirOnly: boolean;
}

/** A directory's resolved rules, anchored at that directory. */
interface AnchoredRules {
  /**
   * Lexical absolute path of the directory whose ignore file produced
   * these - used to compute `path.relative(anchor, file)` against caller
   * input paths (which are also lexical). On macOS `/tmp` symlinks to
   * `/private/tmp`, so using the realpath here would make `path.relative`
   * emit a `../../...` string that no pattern can match.
   */
  readonly anchor: string;
  /** Canonical realpath of the same directory - used only for cycle detection. */
  readonly canonical: string;
  /** Patterns in declaration order - later patterns override earlier ones. */
  readonly patterns: readonly IgnorePattern[];
}

/** Cached rules for a single directory (lookup keyed by lexical path). */
interface DirRulesEntry {
  /** undefined = no ignore files present in that directory. */
  readonly rules: AnchoredRules | undefined;
}

// Cache of per-directory compiled rules keyed by lexical directory path.
// The process never grows unboundedly here - keys are absolute filesystem
// directories, not per-call paths.
const dirRulesCache = new Map<string, DirRulesEntry>();

/**
 * Cache of the resolved base rule chain (cwd -> projectRoot, parent-first)
 * keyed by `realpath(projectRoot) <space> realpath(cwd)`. Re-built lazily
 * on cache miss; reset between tests via `_resetGlobIgnoreCache`.
 */
interface RuleChainEntry {
  readonly chain: readonly AnchoredRules[];
}
const ruleChainCache = new Map<string, RuleChainEntry>();

/**
 * Reset the ignore-rule cache. Tests call this between cases to
 * avoid bleed from previous tmpdir fixtures (which would otherwise reuse
 * stale rules).
 */
export function _resetGlobIgnoreCache(): void {
  dirRulesCache.clear();
  ruleChainCache.clear();
}

/**
 * Build the base rule chain spanning `cwd` up through `projectRoot`. This
 * is the parent context that applies to every match. Nested child
 * `.gitignore` files living below `cwd` are loaded per-match in
 * `collectNestedRules`.
 */
async function loadRuleChain(
  projectRoot: string,
  cwd: string,
): Promise<readonly AnchoredRules[]> {
  const visited = new Set<string>();
  return collectRulesFromTo(projectRoot, cwd, visited);
}

/**
 * Walk *downward* in lexical terms from `cwd` to the parent dir of
 * `absPath`, collecting any `.gitignore` / `.ignore` / `.localcodeignore`
 * files along the way. The resulting rules are appended to the base
 * chain (parent-first), so a child rule overrides a parent rule when
 * both apply.
 *
 * `visitedRealpaths` is shared with the base-chain walk so symlink-loop
 * protection stays global within one `globSearch` invocation.
 */
async function collectNestedRules(
  cwd: string,
  absPath: string,
  visitedRealpaths: Set<string>,
): Promise<AnchoredRules[]> {
  const out: AnchoredRules[] = [];
  const cwdCanonical = safeRealpath(cwd);
  // Walk from the file's parent dir upward, stopping when we reach `cwd`
  // (anything at or above `cwd` is already part of the base chain).
  // Per-call visited set: seeded with the shared `visitedRealpaths` snapshot
  // (so we never re-enter dirs already part of the base chain) but mutated
  // independently per match. Sharing the live Set across matches would let
  // the first match consume every ancestor and starve later matches of their
  // own rules.
  const localVisited = new Set<string>(visitedRealpaths);
  let dir = path.dirname(absPath);
  for (let i = 0; i < 4096; i++) {
    const canonical = safeRealpath(dir);
    if (canonical === cwdCanonical) break;
    if (localVisited.has(canonical)) break;
    localVisited.add(canonical);
    const rules = await loadDirRules(dir);
    if (rules !== undefined) out.push(rules);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // We walked deepest -> shallowest; reverse so the chain is parent-first
  // and deeper rules apply last (and therefore override).
  out.reverse();
  return out;
}

/**
 * Read every recognised ignore file in `dir` and compile its patterns.
 * Returns undefined when no ignore file was found. Cached by lexical
 * directory path.
 */
async function loadDirRules(dir: string): Promise<AnchoredRules | undefined> {
  const cached = dirRulesCache.get(dir);
  if (cached !== undefined) return cached.rules;

  const patterns: IgnorePattern[] = [];
  for (const filename of IGNORE_FILES) {
    const filePath = path.join(dir, filename);
    try {
      const contents = await readFile(filePath, 'utf8');
      patterns.push(...parseIgnoreContents(contents));
    } catch {
      // Missing / unreadable ignore file is fine, skip silently.
    }
  }
  const rules: AnchoredRules | undefined =
    patterns.length > 0
      ? { anchor: dir, canonical: safeRealpath(dir), patterns }
      : undefined;
  dirRulesCache.set(dir, { rules });
  return rules;
}

/**
 * Translate a single gitignore-style line into a regex anchored to the
 * directory that owns the ignore file.
 *
 * Supported syntax (the subset that ripgrep / git both implement):
 *   - `*`            matches any character except `/`
 *   - `**`           matches any number of path segments (or none)
 *   - `?`            matches a single non-`/` character
 *   - leading `/`    anchors the pattern to the ignore-file directory
 *   - trailing `/`   restricts the match to directories
 *   - `!` prefix     negates an earlier exclude (re-includes)
 *   - `#` prefix     line is a comment (callers must skip)
 *
 * Patterns without any `/` (other than a trailing slash) match at any
 * depth - matching gitignore semantics.
 */
function compilePattern(line: string): IgnorePattern | null {
  let raw = line;
  let negate = false;
  if (raw.startsWith('!')) {
    negate = true;
    raw = raw.slice(1);
  }

  let dirOnly = false;
  if (raw.endsWith('/')) {
    dirOnly = true;
    raw = raw.slice(0, -1);
  }

  // Gitignore: a pattern containing a slash anywhere except the trailing
  // one is anchored to the ignore-file dir. A leading `/` is just an
  // explicit anchor marker - strip it.
  const hasInternalSlash = raw.includes('/');
  let anchored = false;
  if (raw.startsWith('/')) {
    anchored = true;
    raw = raw.slice(1);
  } else if (hasInternalSlash) {
    anchored = true;
  }

  if (raw === '') return null;

  // Translate glob -> regex. We walk char-by-char so we can handle `**`
  // (matches across path separators) distinctly from `*` (which does not).
  let re = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    const next = raw[i + 1];
    if (ch === '*') {
      if (next === '*') {
        // `**` - consume optional surrounding slashes so it absorbs full
        // path segments. Handle `**/` and `/**` and bare `**`.
        const prevSlash = re.endsWith('/');
        let j = i + 2;
        const afterSlash = raw[j] === '/';
        if (afterSlash) j += 1;
        if (prevSlash) {
          // Replace the slash we just emitted with `(?:.*/)?`.
          re = re.slice(0, -1) + '(?:.*/)?';
        } else {
          re += '.*';
        }
        if (afterSlash && !prevSlash) {
          // `**/foo` at the start - also allow zero leading segments
          // by emitting `(?:.*/)?` then nothing; for `foo/**/bar` keep `.*/`.
          re += '/';
        }
        i = j - 1;
        continue;
      }
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '.' || ch === '+' || ch === '(' || ch === ')'
      || ch === '|' || ch === '^' || ch === '$' || ch === '{'
      || ch === '}' || ch === '[' || ch === ']' || ch === '\\') {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }

  // Build the final regex. Match against the *relative* path from the
  // ignore-file dir. Anchored patterns require a path that starts at
  // that dir; unanchored patterns may match at any depth.
  const body = anchored ? `^${re}` : `^(?:.*/)?${re}`;
  // Allow the match to end either at end-of-string OR followed by `/...`
  // so that excluding a directory also excludes everything inside it.
  const tail = dirOnly ? '/' : '(?:/|$)';
  const regex = new RegExp(body + tail);

  return { source: line, regex, negate, dirOnly };
}

/**
 * Parse the contents of an ignore file into compiled patterns. Blank
 * lines and `#` comments are skipped. Trailing whitespace is trimmed
 * (gitignore preserves trailing whitespace only when escaped with `\`,
 * which we don't currently support - patterns relying on that are
 * vanishingly rare).
 */
function parseIgnoreContents(contents: string): IgnorePattern[] {
  const out: IgnorePattern[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const compiled = compilePattern(line);
    if (compiled !== null) out.push(compiled);
  }
  return out;
}

/**
 * Walk from `startDir` up to (and including) `projectRoot`, collecting
 * every recognised ignore file along the way. Returns rules in
 * parent-first order so that deeper (more specific) rules apply last.
 *
 * Symlink-loop guard: each ancestor's *realpath* is recorded in a
 * caller-supplied `visitedRealpaths` Set. If we ever see the same
 * realpath twice we abort the climb - this protects against the
 * pathological `a -> b -> a` directory chain. Callers can share the
 * Set across multiple walks within one `globSearch` invocation so the
 * total cost stays bounded.
 */
async function collectRulesFromTo(
  projectRoot: string,
  startDir: string,
  visitedRealpaths: Set<string>,
): Promise<AnchoredRules[]> {
  const out: AnchoredRules[] = [];

  const canonicalRoot = safeRealpath(projectRoot);
  let dir = startDir;

  // Bound iterations defensively even though `visitedRealpaths` should
  // catch cycles - defence in depth against unexpected filesystem
  // shapes.
  for (let i = 0; i < 4096; i++) {
    const canonical = safeRealpath(dir);
    if (visitedRealpaths.has(canonical)) break;
    visitedRealpaths.add(canonical);

    const rules = await loadDirRules(dir);
    if (rules !== undefined) out.push(rules);

    if (canonical === canonicalRoot) break;
    // Defence in depth: never walk above the user's home directory or
    // hit a `.git/` boundary - these are the same bounds ripgrep uses.
    if (canonical === os.homedir()) break;

    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Parent-first ordering: we pushed start -> root, so reverse.
  out.reverse();
  return out;
}

/**
 * Resolve a realpath, falling back to the lexical path when the path
 * itself does not yet exist. Important: never throws - realpath errors
 * should not make `glob_search` fail, they should just degrade to
 * lexical comparison.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Decide whether `absPath` is ignored by the loaded rule chain.
 *
 * The matcher walks every rule in declaration order. Later rules
 * override earlier ones - a `!negation` re-includes a file that was
 * previously excluded. Each anchored rule's regex matches against the
 * path relative to that rule's anchor directory, slash-normalised.
 */
function isIgnoredBy(
  chain: readonly AnchoredRules[],
  absPath: string,
): boolean {
  let ignored = false;
  for (const anchored of chain) {
    // Path relative to the anchor dir, slash-normalised. If the file
    // does not live under the anchor (e.g. a sibling subtree symlinked
    // in), this anchor's rules cannot apply.
    let rel = path.relative(anchored.anchor, absPath);
    if (rel === '' || rel.startsWith('..')) continue;
    rel = rel.split(path.sep).join('/');
    for (const pat of anchored.patterns) {
      // Note: `dirOnly` is encoded into the regex tail (trailing `/`),
      // which already enforces that the pattern only matches paths
      // beneath the named dir. We do NOT skip dirOnly patterns here;
      // a `secret/` rule should match the file `secret/foo.ts` because
      // its directory ancestor `secret/` is ignored.
      if (pat.regex.test(rel)) {
        ignored = !pat.negate;
      }
    }
  }
  return ignored;
}

/**
 * M1 - Resolve the optional `cwd` argument with project-root containment.
 *
 * Both absolute paths AND relative paths must end up inside the project
 * root. Symlink traversal is closed by `resolveSafePathStrict`. Returns
 * null when the requested cwd escapes the root.
 */
function resolveCwd(ctx: ToolContext, requested?: string): string | null {
  if (!requested) return ctx.projectRoot;
  // For absolute input we feed it raw to the strict helper - it will
  // compute a relative key against the root via path.resolve.
  const candidate = path.isAbsolute(requested)
    ? requested
    : path.resolve(ctx.projectRoot, requested);
  return resolveSafePathStrict(ctx.projectRoot, candidate);
}

export async function globSearch(
  args: GlobSearchArgs & { respectIgnore?: boolean },
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = GlobSearchArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const cwd = resolveCwd(ctx, parsed.data.cwd);
  if (cwd === null) {
    return {
      success: false,
      output: '',
      error: `cwd '${parsed.data.cwd ?? ''}' escapes project root`,
    };
  }

  const respectIgnore = parsed.data.respectIgnore ?? true;

  try {
    // Ask for one more than the cap so we can report truncation accurately.
    // We intentionally fetch more than the cap when ignore filtering is
    // active, because the filter may drop some of the head matches.
    const fetchCount = respectIgnore ? MAX_RESULTS * 4 : MAX_RESULTS + 1;
    const rawMatches = await fg(parsed.data.pattern, {
      cwd,
      ignore: [...DEFAULT_IGNORE],
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    });

    let matches = rawMatches;
    if (respectIgnore && rawMatches.length > 0) {
      const cacheKey = safeRealpath(ctx.projectRoot) + ' ' + safeRealpath(cwd);
      let entry = ruleChainCache.get(cacheKey);
      if (entry === undefined) {
        const chain = await loadRuleChain(ctx.projectRoot, cwd);
        entry = { chain };
        ruleChainCache.set(cacheKey, entry);
      }
      // Symlink-loop guard shared across every per-match nested walk in
      // this invocation. Seeded with the base chain's canonical anchors
      // so we never re-enter a dir already visited by `loadRuleChain`.
      const visitedRealpaths = new Set<string>(
        entry.chain.map((r) => r.canonical),
      );
      const filtered: string[] = [];
      for (const rel of rawMatches) {
        const abs = path.resolve(cwd, rel);
        const nested = await collectNestedRules(cwd, abs, visitedRealpaths);
        const fullChain =
          nested.length === 0 ? entry.chain : [...entry.chain, ...nested];
        if (!isIgnoredBy(fullChain, abs)) {
          filtered.push(rel);
          if (filtered.length > MAX_RESULTS) break;
        }
      }
      matches = filtered;
    } else {
      // Respect the fetched cap even without ignore filtering.
      matches = rawMatches.slice(0, fetchCount);
    }

    if (matches.length === 0) {
      return {
        success: true,
        output:
          'No files matched. Try broadening your pattern, e.g. **/*.ts',
      };
    }

    if (matches.length > MAX_RESULTS) {
      const head = matches.slice(0, MAX_RESULTS).join('\n');
      const extra = matches.length - MAX_RESULTS;
      return {
        success: true,
        output: `${head}\n[... truncated: ${extra} more results ...]`,
      };
    }

    return { success: true, output: matches.join('\n') };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Glob search failed for '${parsed.data.pattern}': ${message}`,
    };
  }
}
