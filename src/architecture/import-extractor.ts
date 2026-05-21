/**
 * Import extractor — pull import specifiers out of a TypeScript/JavaScript
 * source file and resolve them to absolute paths under `projectRoot`.
 *
 * Coverage:
 *   - `import X from 'spec'`
 *   - `import { Y } from 'spec'`
 *   - `import * as Z from 'spec'`
 *   - `import 'side-effect'`
 *   - `import type T from 'spec'`        (kept; layering rules apply
 *                                          regardless of type-only-ness)
 *   - `export ... from 'spec'`            (re-exports count as imports)
 *   - `await import('spec')` / `import('spec')` dynamic
 *
 * Out of scope (honest gap): template-literal dynamic imports such as
 *   `import(`./modules/${name}`)`
 * cannot be resolved statically — they are silently skipped (the
 * regex requires a plain quoted string literal). Document this in the
 * `/arch check` output so users aren't surprised.
 *
 * Resolution rules:
 *   1. tsconfig paths (`@/x` → `<projectRoot>/src/x`) — read once and
 *      cached per project root. Reads `<projectRoot>/tsconfig.json`,
 *      honours `compilerOptions.baseUrl` + `compilerOptions.paths`.
 *   2. Relative specifiers (`./foo`, `../bar`) resolve against the
 *      directory of `sourceFile`.
 *   3. The resolver tries the literal path first, then `.ts`, `.tsx`,
 *      `.js`, `.jsx`, then `/index.{ts,tsx,js,jsx}`. First hit wins.
 *   4. Bare specifiers (`zod`, `node:fs`, `bun:test`) resolve to `null`
 *      — the validator's `[global].ignoreImports` regex filters those.
 *
 * Hot-path constraint: extraction + resolution must stay under 50ms per
 * file. The regex tokeniser is single-pass and the path resolver does
 * at most ~8 stat calls per import. We avoid spinning up `ts-morph` /
 * the TypeScript compiler — overkill for a layering check and far too
 * slow for a PreToolUse hook.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ImportEdge } from './types';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'] as const;

/**
 * Cached tsconfig path map keyed by projectRoot. Cleared via
 * `_resetTsconfigCache()` between tests.
 */
interface TsconfigInfo {
  /** Absolute base dir for the path map (defaults to projectRoot). */
  readonly baseUrl: string;
  /**
   * Compiled path-alias entries. Order matters: we test in declaration
   * order so the user's tsconfig precedence is preserved.
   */
  readonly paths: ReadonlyArray<{
    /** Source pattern, e.g. `@/*`. */
    readonly key: string;
    /** Source prefix without the trailing `*`. */
    readonly prefix: string;
    /** Resolved target prefix (absolute, no trailing `*`). */
    readonly targetPrefix: string;
  }>;
}

const tsconfigCache = new Map<string, TsconfigInfo | null>();

/** Reset the tsconfig path cache. Tests call this between fixtures. */
export function _resetTsconfigCache(): void {
  tsconfigCache.clear();
}

/**
 * Load and compile the tsconfig path map at `<projectRoot>/tsconfig.json`.
 * Returns null when no tsconfig exists or it lacks `paths`. Cached.
 */
function loadTsconfigPaths(projectRoot: string): TsconfigInfo | null {
  if (tsconfigCache.has(projectRoot)) {
    return tsconfigCache.get(projectRoot) ?? null;
  }
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    tsconfigCache.set(projectRoot, null);
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(tsconfigPath, 'utf8');
  } catch {
    tsconfigCache.set(projectRoot, null);
    return null;
  }
  // tsconfig may contain JSON-with-comments. Strip them defensively
  // before JSON.parse — without this, a single `//` line breaks every
  // resolution downstream.
  const cleaned = stripJsonComments(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    tsconfigCache.set(projectRoot, null);
    return null;
  }
  const compilerOptions =
    isPlainObject(parsed) && isPlainObject(parsed['compilerOptions'])
      ? parsed['compilerOptions']
      : null;
  if (compilerOptions === null) {
    tsconfigCache.set(projectRoot, null);
    return null;
  }
  const rawBaseUrl =
    typeof compilerOptions['baseUrl'] === 'string'
      ? compilerOptions['baseUrl']
      : '.';
  const baseUrl = path.resolve(projectRoot, rawBaseUrl);

  const pathsRaw = compilerOptions['paths'];
  if (!isPlainObject(pathsRaw)) {
    const info: TsconfigInfo = { baseUrl, paths: [] };
    tsconfigCache.set(projectRoot, info);
    return info;
  }

  const compiled: Array<{ key: string; prefix: string; targetPrefix: string }> = [];
  for (const [key, value] of Object.entries(pathsRaw)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const firstTarget = value[0];
    if (typeof firstTarget !== 'string') continue;
    // Support `@/*` → `./src/*` style. We do NOT support the broader
    // tsconfig path-mapping with multiple `*` per pattern — it's vanishingly
    // rare and the harness's own tsconfig only uses the simple form.
    if (!key.endsWith('*')) {
      // Exact (non-wildcard) entry — encode as prefix with empty wildcard.
      compiled.push({
        key,
        prefix: key,
        targetPrefix: path.resolve(baseUrl, firstTarget),
      });
      continue;
    }
    const prefix = key.slice(0, -1); // drop trailing `*`
    const targetTrimmed = firstTarget.endsWith('*')
      ? firstTarget.slice(0, -1)
      : firstTarget;
    compiled.push({
      key,
      prefix,
      targetPrefix: path.resolve(baseUrl, targetTrimmed),
    });
  }
  const info: TsconfigInfo = { baseUrl, paths: compiled };
  tsconfigCache.set(projectRoot, info);
  return info;
}

function stripJsonComments(text: string): string {
  // Conservative comment stripper for tsconfig.json: handles // line
  // comments and /* block comments */ but skips comment-like sequences
  // inside string literals.
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = text[i] ?? '';
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Match every supported import shape and emit the (specifier, line)
 * tuples. We use a single combined regex with a global flag so the
 * tokeniser does one pass over the source. The line number is computed
 * lazily from byte offset to keep the hot path cheap.
 *
 * Captures (group indices, see SPECIFIER_GROUPS):
 *   1. `import ... from 'X'`
 *   2. `import 'X'`           (side-effect)
 *   3. `export ... from 'X'`
 *   4. `import('X')`          (dynamic)
 *   5. `require('X')`         (CJS — keep for JS files)
 */
const IMPORT_REGEX = new RegExp(
  [
    // import [type] X|{X}|* as X from 'spec'
    String.raw`import\s+(?:type\s+)?(?:[\w*${'$'}\s,{}]+?\s+from\s+)?["']([^"']+)["']`,
    // import('spec')        — dynamic import
    String.raw`import\s*\(\s*["']([^"']+)["']\s*\)`,
    // export ... from 'spec'
    String.raw`export\s+(?:type\s+)?[\w*${'$'}\s,{}]+\s+from\s+["']([^"']+)["']`,
    // require('spec')
    String.raw`require\s*\(\s*["']([^"']+)["']\s*\)`,
  ].join('|'),
  'g',
);

/**
 * Extract import edges from a source file. Reads the file (UTF-8),
 * tokenises, resolves each specifier, returns the resulting list.
 * Empty array when the file is missing / unreadable — the caller
 * should not treat read failure as a violation (a deleted file can
 * never violate layering rules).
 */
export function extractImports(
  filePath: string,
  projectRoot: string,
): ImportEdge[] {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  return extractImportsFromSource(filePath, source, projectRoot);
}

/**
 * Variant that takes the source text directly (no disk read). Used by
 * the PreToolUse hook which already has the new content in memory.
 */
export function extractImportsFromSource(
  filePath: string,
  source: string,
  projectRoot: string,
): ImportEdge[] {
  const tsconfig = loadTsconfigPaths(projectRoot);
  const out: ImportEdge[] = [];
  // Reset lastIndex defensively — IMPORT_REGEX is shared.
  IMPORT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_REGEX.exec(source)) !== null) {
    const specifier =
      match[1] ?? match[2] ?? match[3] ?? match[4] ?? null;
    if (specifier === null) continue;
    const line = lineNumberAt(source, match.index);
    const resolved = resolveSpecifier(
      specifier,
      filePath,
      projectRoot,
      tsconfig,
    );
    out.push({
      sourceFile: filePath,
      specifier,
      resolvedAbsolute: resolved,
      line,
    });
  }
  return out;
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/**
 * Resolve a specifier to an absolute project file path, or null when
 * it is a bare module name (npm package, node builtin) that does not
 * belong to the project tree.
 */
function resolveSpecifier(
  specifier: string,
  sourceFile: string,
  projectRoot: string,
  tsconfig: TsconfigInfo | null,
): string | null {
  // 1. tsconfig path aliases (longest prefix wins).
  if (tsconfig !== null) {
    let bestPrefix = '';
    let bestTarget = '';
    for (const entry of tsconfig.paths) {
      if (entry.prefix === '' && entry.key === specifier) {
        // Exact (non-wildcard) hit.
        return resolveWithExtensions(entry.targetPrefix);
      }
      if (entry.prefix.length > 0 && specifier.startsWith(entry.prefix)) {
        if (entry.prefix.length > bestPrefix.length) {
          bestPrefix = entry.prefix;
          bestTarget = entry.targetPrefix;
        }
      }
    }
    if (bestPrefix.length > 0) {
      const rest = specifier.slice(bestPrefix.length);
      const candidate = path.resolve(bestTarget, rest);
      const resolved = resolveWithExtensions(candidate);
      if (resolved !== null) return resolved;
      // Fall through — if the alias didn't resolve to a file, treat as
      // bare. Layering rules can still match on the raw specifier via
      // `forbid` patterns if needed.
      return null;
    }
  }

  // 2. Relative specifier.
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const dir = path.dirname(sourceFile);
    const candidate = path.resolve(dir, specifier);
    const resolved = resolveWithExtensions(candidate);
    if (resolved !== null) return resolved;
    return null;
  }

  // 3. Absolute path inside projectRoot.
  if (path.isAbsolute(specifier) && specifier.startsWith(projectRoot)) {
    return resolveWithExtensions(specifier);
  }

  // 4. Bare specifier (npm package, node:fs, bun:test, etc).
  return null;
}

/**
 * Try `candidate` as a file, then with each known source extension,
 * then as `<candidate>/index.<ext>`. Returns the first existing path
 * or null.
 */
function resolveWithExtensions(candidate: string): string | null {
  // Direct match (already has an extension).
  if (existsSync(candidate)) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) return candidate;
      if (stat.isDirectory()) {
        for (const ext of SOURCE_EXTENSIONS) {
          const indexed = path.join(candidate, `index${ext}`);
          if (existsSync(indexed)) return indexed;
        }
        return null;
      }
    } catch {
      // fall through to extension search
    }
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const withExt = `${candidate}${ext}`;
    if (existsSync(withExt)) return withExt;
  }
  return null;
}
