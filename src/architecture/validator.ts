/**
 * Layering validator.
 *
 * `validateFile(filePath, archConfig, projectRoot)` — return every
 * violation the file commits against `archConfig.rule[*]`. Used by
 * the PreToolUse hook (per-file hot path; <50ms target) and the
 * `/arch check` command (project sweep).
 *
 * `validateProject(archConfig, projectRoot)` — sweep every `match`
 * candidate referenced by any rule, deduplicate by absolute path,
 * delegate to `validateFile`. Used by `/arch check`.
 *
 * Globbing strategy:
 *   - `match` and `forbid` are minimatch-style globs: `**`, `*`, `?`,
 *     extension groups `{ts,tsx}`. The same compiler runs both sides
 *     so author and consumer share semantics.
 *   - We compile once per (config, projectRoot) and cache. The cache
 *     key is the config object identity; new configs invalidate.
 */

import fg from 'fast-glob';
import path from 'node:path';
import { extractImports, extractImportsFromSource } from './import-extractor';
import type { ArchConfig, ArchRule, ArchViolation } from './types';

interface CompiledRule {
  readonly rule: ArchRule;
  readonly matchRegex: RegExp;
  readonly forbidRegexes: ReadonlyArray<{ pattern: string; regex: RegExp }>;
}

interface CompiledConfig {
  readonly rules: ReadonlyArray<CompiledRule>;
  readonly ignoreImportRegexes: ReadonlyArray<RegExp>;
}

const compileCache = new WeakMap<ArchConfig, CompiledConfig>();

/**
 * Compile (or reuse cached) regex-form of a config. Throws when a
 * pattern can't be compiled — surfaces in the loader/CLI rather than
 * the hot path.
 */
function compileConfig(config: ArchConfig): CompiledConfig {
  const cached = compileCache.get(config);
  if (cached !== undefined) return cached;

  const rules = config.rule.map<CompiledRule>((rule) => ({
    rule,
    matchRegex: globToRegex(rule.match),
    forbidRegexes: (rule.forbid ?? []).map((pattern) => ({
      pattern,
      regex: globToRegex(pattern),
    })),
  }));
  const ignoreImportRegexes = config.global.ignoreImports.map(
    (pattern) => new RegExp(pattern),
  );
  const compiled: CompiledConfig = { rules, ignoreImportRegexes };
  compileCache.set(config, compiled);
  return compiled;
}

/**
 * Validate a single file's imports against every rule whose `match`
 * glob accepts it. Returns the empty array when no rule matches OR
 * when every matching rule's `allowAll` is true.
 *
 * `filePath` is normalised to a project-relative POSIX path for glob
 * matching; the violation's `sourceFile` is the same form so output is
 * platform-stable.
 */
export function validateFile(
  filePath: string,
  archConfig: ArchConfig,
  projectRoot: string,
  precomputedContent?: string,
): ArchViolation[] {
  const compiled = compileConfig(archConfig);
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectRoot, filePath);
  const relPath = toPosixRelative(absolutePath, projectRoot);

  // Find every rule the file matches. allowAll wins as soon as one
  // permits — we still iterate to surface multi-rule diagnostics if
  // we ever extend the schema.
  const matching = compiled.rules.filter((r) => r.matchRegex.test(relPath));
  if (matching.length === 0) return [];
  if (matching.some((r) => r.rule.allowAll === true)) return [];

  // Cheap parse — single regex pass + per-import path resolution.
  const edges =
    precomputedContent !== undefined
      ? extractImportsFromSource(absolutePath, precomputedContent, projectRoot)
      : extractImports(absolutePath, projectRoot);
  if (edges.length === 0) return [];

  const violations: ArchViolation[] = [];
  for (const edge of edges) {
    // Honour `[global].ignoreImports` BEFORE per-rule checks. Match
    // against the raw specifier (what the user typed), not the
    // resolved path — that's how the user wrote the regex.
    if (compiled.ignoreImportRegexes.some((re) => re.test(edge.specifier))) {
      continue;
    }
    const targetRel =
      edge.resolvedAbsolute !== null
        ? toPosixRelative(edge.resolvedAbsolute, projectRoot)
        : null;
    for (const compiledRule of matching) {
      if (compiledRule.rule.allowAll === true) continue;
      for (const { pattern, regex } of compiledRule.forbidRegexes) {
        const matched =
          (targetRel !== null && regex.test(targetRel)) ||
          regex.test(edge.specifier);
        if (matched) {
          violations.push({
            ruleId: compiledRule.rule.id,
            sourceFile: relPath,
            importPath: edge.specifier,
            resolvedTarget: targetRel,
            line: edge.line,
            severity: compiledRule.rule.severity ?? 'error',
          });
          // One violation per (rule, import). Avoid double-listing the
          // same edge against multiple forbid patterns in the same rule.
          break;
        }
        // `pattern` retained on the compiled entry for future
        // diagnostics (e.g. surfacing which forbid line matched).
        void pattern;
      }
    }
  }
  return violations;
}

/** Result shape for project-wide sweeps. */
export interface ProjectValidationResult {
  readonly violations: ArchViolation[];
  readonly filesChecked: number;
}

/**
 * Project-wide sweep — enumerate every file that matches at least one
 * rule's `match` glob and validate. Files outside every rule's match
 * are not visited at all (no point reading them). Deterministic order
 * (lexical) so CLI output is stable.
 */
export async function validateProject(
  archConfig: ArchConfig,
  projectRoot: string,
): Promise<ProjectValidationResult> {
  const all = new Set<string>();
  for (const rule of archConfig.rule) {
    const matches = await fg(rule.match, {
      cwd: projectRoot,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: ['node_modules/**', '.git/**', 'dist/**', 'dist-web/**', 'build/**'],
      suppressErrors: true,
    });
    for (const rel of matches) {
      all.add(rel);
    }
  }
  const sorted = [...all].sort();
  const violations: ArchViolation[] = [];
  for (const rel of sorted) {
    const abs = path.resolve(projectRoot, rel);
    violations.push(...validateFile(abs, archConfig, projectRoot));
  }
  return { violations, filesChecked: sorted.length };
}

// ---------- helpers ----------

function toPosixRelative(absolutePath: string, projectRoot: string): string {
  const rel = path.relative(projectRoot, absolutePath);
  if (rel.length === 0) return '.';
  return rel.split(path.sep).join('/');
}

/**
 * Translate a minimatch-style glob into a `RegExp`. Subset covered:
 *   - `**`       any number of path segments (or none)
 *   - `*`        any chars within a segment (not `/`)
 *   - `?`        one char within a segment
 *   - `{a,b,c}`  alternation
 *   - regex metachars are escaped
 *
 * Anchored to start-of-string and end-of-string.
 */
function globToRegex(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] as string;
    const next = glob[i + 1];
    if (ch === '*' && next === '*') {
      // `**`. Consume optional trailing slash for `**/`.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
        continue;
      }
      re += '.*';
      i += 2;
      continue;
    }
    if (ch === '*') {
      re += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (ch === '{') {
      const close = glob.indexOf('}', i + 1);
      if (close === -1) {
        // unbalanced — escape literal
        re += '\\{';
        i++;
        continue;
      }
      const inside = glob.slice(i + 1, close);
      const alternatives = inside
        .split(',')
        .map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&'));
      re += `(?:${alternatives.join('|')})`;
      i = close + 1;
      continue;
    }
    if (
      ch === '.' || ch === '+' || ch === '^' || ch === '$' ||
      ch === '(' || ch === ')' || ch === '|' || ch === '[' ||
      ch === ']' || ch === '\\'
    ) {
      re += '\\' + ch;
      i++;
      continue;
    }
    re += ch;
    i++;
  }
  return new RegExp('^' + re + '$');
}
