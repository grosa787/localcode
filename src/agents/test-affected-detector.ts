/**
 * Test-affected detector — given a list of file paths that changed in
 * this turn, return the test files most likely to exercise them.
 *
 * Heuristics (ranked highest → lowest):
 *
 *   1. **Self**: the changed file itself is already a test file
 *      (`*.test.ts(x)` / `*.spec.ts(x)` or anywhere under a top-level
 *      `tests/` / `__tests__/` directory). Rank 0.
 *
 *   2. **Direct sibling**: a file matching one of the conventional
 *      sibling layouts:
 *        `src/foo/bar.ts`    ↔  `tests/foo/bar.test.ts`
 *        `src/foo/bar.tsx`   ↔  `tests/foo/bar.test.tsx`
 *        `src/foo/bar.ts`    ↔  `src/foo/bar.test.ts`
 *        `src/foo/bar.ts`    ↔  `src/foo/__tests__/bar.test.ts`
 *        `src/foo/bar.ts`    ↔  `__tests__/bar.test.ts`
 *      Rank 1 — these are the fast path.
 *
 *   3. **Import-grep**: any test file whose first 200 lines mention
 *      the changed file by name (basename without extension, or the
 *      full project-relative path) in a `from '…'` or `require('…')`
 *      clause. Rank 2 — broader net, catches integration tests that
 *      import a moved file.
 *
 *   4. **Naming-convention match**: any test file whose basename
 *      (minus `.test.ts(x)` / `.spec.ts(x)`) equals the changed file's
 *      basename without extension. Rank 3 — last resort for
 *      poly-located test layouts.
 *
 * The function is filesystem-bound (no AST parse, no babel/typescript
 * deps). It walks `tests/` and `src/` once per invocation; small to
 * medium projects (<5000 files) finish in <100ms.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';

// ---------- Public types ----------

/** Single ranked match returned by `findAffectedTests`. */
export interface AffectedTest {
  /** Absolute path on disk. */
  readonly filePath: string;
  /**
   * Heuristic rank (smaller = more likely to be the right test). Stable
   * with the order documented at the module top so callers can sort
   * deterministically.
   */
  readonly rank: number;
  /** Short label describing why this file was picked. */
  readonly reason:
    | 'self'
    | 'sibling'
    | 'import-grep'
    | 'naming-convention';
}

// ---------- Helpers ----------

const TEST_EXT_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const SCAN_LINE_BUDGET = 200;

function isTestFile(absPath: string): boolean {
  const norm = absPath.replace(/\\/g, '/');
  if (TEST_EXT_PATTERN.test(norm)) return true;
  if (norm.includes('/__tests__/')) return true;
  if (norm.startsWith('tests/') || norm.includes('/tests/')) return true;
  return false;
}

function stripTestSuffix(fileName: string): string {
  return fileName.replace(TEST_EXT_PATTERN, '');
}

function basenameNoExt(filePath: string): string {
  const base = path.basename(filePath);
  // Strip every dot-suffix from the right so `bar.test.ts` → `bar`.
  return base.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/i, '');
}

/**
 * Walk a directory tree, calling `onFile` for every regular file. Cheap
 * recursive implementation (no externs). Skips `node_modules`,
 * `dist`, `dist-web`, `coverage`, and dot-directories so a typical repo
 * scan finishes quickly.
 */
async function walk(
  root: string,
  onFile: (absPath: string) => void,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'dist-web' ||
        entry.name === 'coverage' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      await walk(full, onFile);
      continue;
    }
    if (entry.isFile()) {
      onFile(full);
    }
  }
}

/**
 * Read up to `SCAN_LINE_BUDGET` lines from a file. Returns an empty
 * string on read failure (deleted file, permission error, …) so the
 * caller can continue without try/catch noise.
 */
async function readHead(filePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split('\n');
    if (lines.length <= SCAN_LINE_BUDGET) return raw;
    return lines.slice(0, SCAN_LINE_BUDGET).join('\n');
  } catch {
    return '';
  }
}

/**
 * Resolve a possibly-relative path against the project root. Idempotent
 * for absolute paths.
 */
function toAbs(projectRoot: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
}

function toRelative(projectRoot: string, abs: string): string {
  const rel = path.relative(projectRoot, abs);
  // `path.relative` may return absolute paths on Windows when the two
  // arguments don't share a root; defensively keep the original then.
  if (rel.startsWith('..')) return abs;
  return rel.replace(/\\/g, '/');
}

/**
 * Build the candidate "direct sibling" paths for a changed src file.
 * Returns a list of conventional locations to probe with `fs.stat`.
 */
function siblingCandidates(
  projectRoot: string,
  relSrcPath: string,
): readonly string[] {
  // Normalise to POSIX slashes for matching.
  const rel = relSrcPath.replace(/\\/g, '/');
  const ext = path.extname(rel); // .ts / .tsx
  if (ext.length === 0) return [];
  const dir = path.dirname(rel); // src/foo  (or '.')
  const baseNoExt = path.basename(rel, ext); // bar
  const candidates = new Set<string>();

  // Mirror to top-level tests/.
  if (rel.startsWith('src/')) {
    const mirror = `tests/${dir.slice('src/'.length)}/${baseNoExt}.test${ext}`;
    candidates.add(path.posix.normalize(mirror));
    candidates.add(
      path.posix.normalize(
        `tests/${dir.slice('src/'.length)}/${baseNoExt}.spec${ext}`,
      ),
    );
  }

  // Co-located test in same dir.
  candidates.add(path.posix.normalize(`${dir}/${baseNoExt}.test${ext}`));
  candidates.add(path.posix.normalize(`${dir}/${baseNoExt}.spec${ext}`));

  // `__tests__` sibling under same dir.
  candidates.add(
    path.posix.normalize(`${dir}/__tests__/${baseNoExt}.test${ext}`),
  );
  candidates.add(
    path.posix.normalize(`${dir}/__tests__/${baseNoExt}.spec${ext}`),
  );

  // Top-level `__tests__` dir at repo root.
  candidates.add(path.posix.normalize(`__tests__/${baseNoExt}.test${ext}`));

  return Array.from(candidates).map((c) => path.join(projectRoot, c));
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    const st = await fs.stat(absPath);
    return st.isFile();
  } catch {
    return false;
  }
}

// ---------- Public API ----------

export interface FindAffectedTestsOptions {
  /** Cap on the total returned items. Default 25. */
  readonly maxResults?: number;
  /**
   * When true the function returns even when no rank-1/2/3 match found
   * — useful for tests that want to confirm an empty result. Default true.
   */
  readonly includeEmptyMatches?: boolean;
}

/**
 * Return a ranked list of test files affected by the changed paths.
 *
 * Inputs:
 *   - `changedFilePaths` — project-relative or absolute paths of files
 *     that were just edited (typically the `path` arg of `write_file` /
 *     `edit_file` / `multi_edit` tool calls).
 *   - `projectRoot` — absolute path of the workspace root used as the
 *     anchor for relative paths.
 *
 * The output is de-duplicated by absolute path and sorted by
 * `(rank, filePath)` so the order is stable across invocations.
 */
export async function findAffectedTests(
  changedFilePaths: readonly string[],
  projectRoot: string,
  options?: FindAffectedTestsOptions,
): Promise<readonly AffectedTest[]> {
  const limit = options?.maxResults ?? 25;
  if (changedFilePaths.length === 0) return [];

  // Resolve inputs to absolute paths and split into "is itself a test"
  // vs "needs sibling/grep" sets.
  const absInputs = changedFilePaths.map((p) => toAbs(projectRoot, p));
  const selfTests: string[] = [];
  const productionFiles: string[] = [];
  for (const abs of absInputs) {
    const rel = toRelative(projectRoot, abs);
    if (isTestFile(rel)) {
      selfTests.push(abs);
    } else {
      productionFiles.push(abs);
    }
  }

  const matches = new Map<string, AffectedTest>();

  const upsert = (m: AffectedTest): void => {
    const existing = matches.get(m.filePath);
    if (existing === undefined || existing.rank > m.rank) {
      matches.set(m.filePath, m);
    }
  };

  // Rank 0 — the changed file IS a test.
  for (const abs of selfTests) {
    upsert({ filePath: abs, rank: 0, reason: 'self' });
  }

  // Rank 1 — direct sibling lookup. One stat call per candidate.
  for (const abs of productionFiles) {
    const rel = toRelative(projectRoot, abs);
    for (const sibling of siblingCandidates(projectRoot, rel)) {
      if (await fileExists(sibling)) {
        upsert({ filePath: sibling, rank: 1, reason: 'sibling' });
      }
    }
  }

  // Ranks 2 + 3 — scan `tests/` (and `__tests__/`) for grep/naming.
  // We collect candidate test files once, then evaluate each against
  // every changed production file.
  const testFiles: string[] = [];
  await walk(path.join(projectRoot, 'tests'), (abs) => {
    if (TEST_EXT_PATTERN.test(abs)) testFiles.push(abs);
  });
  await walk(path.join(projectRoot, '__tests__'), (abs) => {
    if (TEST_EXT_PATTERN.test(abs)) testFiles.push(abs);
  });
  // Also include any co-located *.test.* under src/.
  await walk(path.join(projectRoot, 'src'), (abs) => {
    if (TEST_EXT_PATTERN.test(abs)) testFiles.push(abs);
  });

  // De-dupe.
  const uniqueTestFiles = Array.from(new Set(testFiles));

  // Pre-compute name + relative-path tokens for each changed file so we
  // can scan a test once and check against every input.
  const productionTokens = productionFiles.map((abs) => {
    const rel = toRelative(projectRoot, abs);
    const noExt = rel.replace(/\.[^.]+$/, '');
    return {
      abs,
      rel,
      relNoExt: noExt,
      baseNoExt: basenameNoExt(abs),
    };
  });

  for (const testAbs of uniqueTestFiles) {
    // Skip files we already matched at rank 0/1 — the strict-min upsert
    // already protects but skipping saves a file read.
    const already = matches.get(testAbs);
    if (already !== undefined && already.rank <= 1) continue;

    let head = '';
    let needsHead = true;

    for (const tok of productionTokens) {
      // Naming-convention check first (cheap string compare).
      const testBase = basenameNoExt(testAbs);
      if (testBase === tok.baseNoExt) {
        upsert({ filePath: testAbs, rank: 3, reason: 'naming-convention' });
      }

      // Import-grep check — only read the head once per test file.
      if (needsHead) {
        head = await readHead(testAbs);
        needsHead = false;
      }
      if (head.length === 0) continue;

      // Match a quoted occurrence of either the basename-no-ext or the
      // project-relative no-extension path. We don't try to recover the
      // exact import specifier (could be `@/foo/bar`, `./bar`, etc.) —
      // matching the basename or the relative path catches both forms.
      const baseHit =
        tok.baseNoExt.length > 0 &&
        (head.includes(`'${tok.baseNoExt}'`) ||
          head.includes(`"${tok.baseNoExt}"`) ||
          head.includes(`/${tok.baseNoExt}'`) ||
          head.includes(`/${tok.baseNoExt}"`));
      const relHit =
        tok.relNoExt.length > 0 &&
        (head.includes(tok.relNoExt) ||
          head.includes(tok.relNoExt.replace(/^src\//, '@/')));
      if (baseHit || relHit) {
        upsert({ filePath: testAbs, rank: 2, reason: 'import-grep' });
      }
    }
  }

  // Sort by (rank, filePath) for stable output.
  const sorted = Array.from(matches.values()).sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.filePath.localeCompare(b.filePath);
  });

  if (
    sorted.length === 0 &&
    options?.includeEmptyMatches === false
  ) {
    return [];
  }
  return sorted.slice(0, limit);
}

/**
 * Build the shell command to run the affected tests with the
 * project-configured runner. `template` is a printf-style string with a
 * single `{files}` placeholder. When the template lacks the placeholder
 * the file list is appended at the end.
 *
 * Examples:
 *   `bun test {files}`               → `bun test tests/foo/bar.test.ts`
 *   `npx vitest run {files}`         → `npx vitest run tests/foo.test.ts`
 *   `pnpm jest --` (no placeholder)  → `pnpm jest -- tests/foo.test.ts`
 */
export function buildTestCommand(
  template: string,
  testFiles: readonly string[],
  projectRoot: string,
): string {
  const relFiles = testFiles
    .map((abs) => toRelative(projectRoot, abs))
    .map((rel) => (/\s/.test(rel) ? `'${rel}'` : rel));
  const joined = relFiles.join(' ');
  if (template.includes('{files}')) {
    return template.replace(/\{files\}/g, joined);
  }
  if (joined.length === 0) return template;
  return `${template.replace(/\s+$/, '')} ${joined}`;
}

/** Default test command used when the project config doesn't specify one. */
export const DEFAULT_TEST_COMMAND = 'bun test {files}';

/**
 * Read the `testCommand` (or snake_case `test_command`) field from a
 * project's `.localcode/settings.json`. Returns the default template
 * when the file is missing / unreadable / lacks the key.
 *
 * Tolerant by design: malformed JSON / wrong-shape values fall back to
 * the default so a broken file never blocks the button from working.
 */
export async function readProjectTestCommand(
  projectRoot: string,
): Promise<string> {
  const settingsPath = path.join(projectRoot, '.localcode', 'settings.json');
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      return DEFAULT_TEST_COMMAND;
    }
    const obj = parsed as Record<string, unknown>;
    const camel = obj.testCommand;
    if (typeof camel === 'string' && camel.length > 0) return camel;
    const snake = obj.test_command;
    if (typeof snake === 'string' && snake.length > 0) return snake;
    return DEFAULT_TEST_COMMAND;
  } catch {
    return DEFAULT_TEST_COMMAND;
  }
}
