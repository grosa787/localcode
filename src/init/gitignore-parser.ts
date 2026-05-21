/**
 * .gitignore parsing and matching.
 *
 * Supports a deliberately minimal but correct subset of gitignore syntax:
 *   - Comment lines (# ...) and blank lines are skipped.
 *   - Negation patterns (!...) are recognised but IGNORED (out of scope).
 *   - Directory patterns (foo/) match any path segment equal to foo.
 *   - Leading-slash patterns (/foo) are anchored at the project root.
 *   - Star glob patterns (foo.ext with star) match any segment ending with .ext.
 *   - Double-star patterns (star-star slash foo, foo slash star-star) match anywhere.
 *   - Plain patterns (foo) match any path segment equal to foo.
 *
 * Always appends a built-in set of excludes so callers don't need to
 * duplicate them. Safe to run on repos that don't contain a .gitignore.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Excludes we always apply, regardless of what's in `.gitignore`. */
const ALWAYS_IGNORE: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  '.localcode',
  '*.lock',
  '*.log',
  '.DS_Store',
];

/**
 * Reads `<projectRoot>/.gitignore` (if present) and returns the cleaned
 * list of patterns with built-in excludes appended.
 *
 * - Comments (`#...`) and blank lines stripped.
 * - Negation lines (`!...`) silently dropped (not supported).
 * - Duplicates within the file are allowed; built-ins are deduped against
 *   whatever's already in the file.
 * - Never throws — a missing or unreadable file returns just the built-ins.
 */
export function parseGitignore(projectRoot: string): string[] {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const patterns: string[] = [];

  if (existsSync(gitignorePath)) {
    try {
      const raw = readFileSync(gitignorePath, 'utf-8');
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        if (trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('!')) continue; // negations out of scope
        patterns.push(trimmed);
      }
    } catch {
      // Best-effort: fall back to built-ins only.
    }
  }

  // Append built-ins that aren't already present.
  const seen = new Set(patterns);
  for (const builtin of ALWAYS_IGNORE) {
    if (!seen.has(builtin)) {
      patterns.push(builtin);
      seen.add(builtin);
    }
  }

  return patterns;
}

/**
 * Checks whether a relative path (forward-slash separated, relative to
 * the project root, no leading slash) should be ignored.
 *
 * Behaviour per supported pattern style:
 *
 *   - Trailing-slash directory pattern matches any path segment equal to the dir name.
 *   - Leading-slash pattern is anchored at the project root.
 *   - Star-glob within a segment matches any segment matching the glob.
 *   - Double-star in a pattern matches anywhere in the tree.
 *   - Plain pattern matches any segment equal to the pattern text.
 *
 *  Guards against empty inputs and Windows-style paths by normalising
 *  separators up front.
 */
export function shouldIgnore(relPath: string, patterns: string[]): boolean {
  if (relPath.length === 0) return false;

  // Normalise: no leading slash, forward slashes, no trailing slash.
  const normalised = relPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  if (normalised.length === 0) return false;

  const segments = normalised.split('/');

  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern.length === 0) continue;
    if (pattern.startsWith('!')) continue; // negations unsupported
    if (matchesPattern(pattern, normalised, segments)) {
      return true;
    }
  }
  return false;
}

function matchesPattern(
  pattern: string,
  normalised: string,
  segments: string[],
): boolean {
  // Directory-only pattern: trailing slash means "match this directory name
  // anywhere" — including descendants.
  if (pattern.endsWith('/')) {
    const dirName = pattern.slice(0, -1);
    if (dirName.length === 0) return false;

    // Anchored directory pattern: `/foo/` is treated like `/foo`.
    if (dirName.startsWith('/')) {
      return matchesAnchored(dirName.slice(1), segments);
    }
    return segments.some((seg) => segmentMatches(dirName, seg));
  }

  // Anchored pattern: leading slash means "from project root".
  if (pattern.startsWith('/')) {
    return matchesAnchored(pattern.slice(1), segments);
  }

  // Double-star patterns.
  if (pattern.includes('**')) {
    return matchesDoubleStar(pattern, segments);
  }

  // Patterns containing a path separator — only match the full path or a
  // prefix of it (treat them as anchored-ish but allow anywhere-in-tree).
  if (pattern.includes('/')) {
    return matchesWithSlash(pattern, normalised, segments);
  }

  // Plain pattern: match any segment, with optional glob `*`.
  return segments.some((seg) => segmentMatches(pattern, seg));
}

/**
 * Anchored match. The pattern (without its leading `/`) must line up
 * with the first segments of the path.
 */
function matchesAnchored(pattern: string, segments: string[]): boolean {
  if (pattern.length === 0) return false;
  const patternSegs = pattern.split('/').filter((s) => s.length > 0);
  if (patternSegs.length === 0) return false;
  if (patternSegs.length > segments.length) return false;

  for (let i = 0; i < patternSegs.length; i += 1) {
    const patSeg = patternSegs[i];
    const pathSeg = segments[i];
    if (patSeg === undefined || pathSeg === undefined) return false;
    if (patSeg === '**') continue;
    if (!segmentMatches(patSeg, pathSeg)) return false;
  }
  return true;
}

/**
 * Handle patterns that contain double-star segments. Leading double-star
 * means "anywhere to the left"; trailing double-star means "anywhere to
 * the right". A single double-star segment anywhere is treated the same
 * as leading-or-trailing depending on position.
 */
function matchesDoubleStar(pattern: string, segments: string[]): boolean {
  const parts = pattern.split('/');

  // Trim leading/trailing `**` — they mean "anywhere".
  const first = parts[0];
  const last = parts[parts.length - 1];
  const leadingStar = first === '**';
  const trailingStar = last === '**';

  const core = parts.filter((p) => p !== '**');
  if (core.length === 0) return true; // pattern was just `**` — matches all

  // Sliding window over segments.
  for (let start = 0; start <= segments.length - core.length; start += 1) {
    let ok = true;
    for (let i = 0; i < core.length; i += 1) {
      const patSeg = core[i];
      const pathSeg = segments[start + i];
      if (patSeg === undefined || pathSeg === undefined) {
        ok = false;
        break;
      }
      if (!segmentMatches(patSeg, pathSeg)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    if (!leadingStar && start !== 0) continue;
    if (!trailingStar && start + core.length !== segments.length) continue;
    return true;
  }
  return false;
}

/**
 * Patterns like "foo/bar" (no leading slash, no double-star). Match
 * anywhere in the tree as long as consecutive segments align.
 */
function matchesWithSlash(
  pattern: string,
  normalised: string,
  segments: string[],
): boolean {
  const patternSegs = pattern.split('/').filter((s) => s.length > 0);
  if (patternSegs.length === 0) return false;
  if (patternSegs.length > segments.length) {
    // Last-chance: maybe it matches the whole path as-is.
    return segmentMatches(pattern, normalised);
  }
  for (let start = 0; start <= segments.length - patternSegs.length; start += 1) {
    let ok = true;
    for (let i = 0; i < patternSegs.length; i += 1) {
      const patSeg = patternSegs[i];
      const pathSeg = segments[start + i];
      if (patSeg === undefined || pathSeg === undefined) {
        ok = false;
        break;
      }
      if (!segmentMatches(patSeg, pathSeg)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Compare a pattern segment to a path segment.
 *
 * Supports `*` as a wildcard within a single segment (does not cross `/`).
 * A pattern without `*` is compared as an exact string match.
 */
function segmentMatches(pattern: string, segment: string): boolean {
  if (pattern === segment) return true;
  if (!pattern.includes('*')) return false;
  const regex = globSegmentToRegExp(pattern);
  return regex.test(segment);
}

/**
 * Convert a segment-level glob (with `*` but no `/` or `**`) into a
 * RegExp anchored at both ends.
 */
function globSegmentToRegExp(pattern: string): RegExp {
  let re = '^';
  for (const char of pattern) {
    if (char === '*') {
      re += '[^/]*';
    } else if (/[.+?^${}()|[\]\\]/.test(char)) {
      re += `\\${char}`;
    } else {
      re += char;
    }
  }
  re += '$';
  return new RegExp(re);
}

// ---------------------------------------------------------------------------
// Smoke test — `bun src/init/gitignore-parser.ts`.
// ---------------------------------------------------------------------------

/* c8 ignore start */
if ((import.meta as { main?: boolean }).main === true) {
  const cases: Array<{ rel: string; patterns: string[]; expect: boolean }> = [
    { rel: 'node_modules/foo/index.js', patterns: ['node_modules'], expect: true },
    { rel: 'src/index.ts', patterns: ['node_modules'], expect: false },
    { rel: 'dist/cli.js', patterns: ['dist/'], expect: true },
    { rel: 'foo', patterns: ['/foo'], expect: true },
    { rel: 'src/foo', patterns: ['/foo'], expect: false },
    { rel: 'a/b/c.log', patterns: ['*.log'], expect: true },
    { rel: 'bun.lock', patterns: ['*.lock'], expect: true },
    { rel: 'deep/nested/path/foo', patterns: ['**/foo'], expect: true },
    { rel: 'foo/bar/baz', patterns: ['foo/**'], expect: true },
    { rel: '.DS_Store', patterns: ['.DS_Store'], expect: true },
    { rel: 'sub/.DS_Store', patterns: ['.DS_Store'], expect: true },
    { rel: 'README.md', patterns: ['node_modules', 'dist'], expect: false },
    { rel: '.localcode/LOCALCODE.md', patterns: ['.localcode'], expect: true },
    { rel: 'logs/server.log', patterns: ['*.log'], expect: true },
    { rel: '', patterns: ['foo'], expect: false },
  ];

  let failed = 0;
  for (const c of cases) {
    const actual = shouldIgnore(c.rel, c.patterns);
    const ok = actual === c.expect;
    if (!ok) failed += 1;
    const status = ok ? 'PASS' : 'FAIL';
    // eslint-disable-next-line no-console
    console.log(
      `${status} shouldIgnore(${JSON.stringify(c.rel)}, ${JSON.stringify(
        c.patterns,
      )}) → ${String(actual)} (expected ${String(c.expect)})`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n${cases.length - failed}/${cases.length} smoke tests passed.`,
  );

  const parsed = parseGitignore(process.cwd());
  // eslint-disable-next-line no-console
  console.log(`parseGitignore(cwd) → ${parsed.length} patterns.`);

  if (failed > 0) process.exit(1);
}
/* c8 ignore stop */
