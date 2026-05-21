/**
 * Code style extractor (ROADMAP #7).
 *
 * Samples up to ~50 source files in a project and infers the prevailing
 * coding-style conventions:
 *   - indentation (tabs / 2 spaces / 4 spaces / mixed),
 *   - line endings (lf / crlf),
 *   - quote style (single / double / mixed) — JS/TS only,
 *   - semicolon style (always / never / mixed) — JS/TS only,
 *   - file/function/constant naming conventions,
 *   - test framework in use,
 *   - import style (relative / absolute / mixed),
 *   - type-declaration style (interface / type-alias / mixed) — TS only,
 *   - configured linter (eslint / biome / prettier / ruff / gofmt / none / multiple).
 *
 * Strategy is intentionally heuristic and dependency-free: regex-based
 * vote tallies over recently-modified source files. Each property uses
 * the same simple rule:
 *   - At least 3 files must agree → that's the style.
 *   - Otherwise, if the leading category covers >=60% of votes → use it.
 *   - Otherwise → `'mixed'`.
 *
 * The result is cheap to compute (a few hundred ms even on large repos)
 * and never throws — unreachable files are skipped silently.
 *
 * Note: nothing in this module mutates state. It is a pure async function
 * over the filesystem.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parseGitignore, shouldIgnore } from './gitignore-parser';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type IndentStyle = 'tabs' | '2-spaces' | '4-spaces' | 'mixed';
export type LineEndingStyle = 'lf' | 'crlf';
export type QuoteStyle = 'single' | 'double' | 'mixed';
export type SemicolonStyle = 'always' | 'never' | 'mixed';

export type FileNameStyle =
  | 'kebab-case'
  | 'camelCase'
  | 'PascalCase'
  | 'snake_case'
  | 'mixed';

export type FunctionNameStyle = 'camelCase' | 'snake_case' | 'mixed';

export type ConstantNameStyle = 'SCREAMING_SNAKE_CASE' | 'camelCase' | 'mixed';

export type TestFramework =
  | 'jest'
  | 'vitest'
  | 'bun:test'
  | 'mocha'
  | 'pytest'
  | 'go-test'
  | 'unknown';

export type ImportStyle = 'relative' | 'absolute' | 'mixed';

export type TypeStyle = 'interface' | 'type-alias' | 'mixed';

export type LinterStyle =
  | 'eslint'
  | 'biome'
  | 'prettier'
  | 'ruff'
  | 'gofmt'
  | 'none'
  | 'multiple';

export interface NamingConventions {
  files: FileNameStyle;
  functions: FunctionNameStyle;
  constants: ConstantNameStyle;
}

export interface ExtractedCodeStyle {
  indentation: IndentStyle;
  lineEndings: LineEndingStyle;
  quotes: QuoteStyle;
  semicolons: SemicolonStyle;
  namingConventions: NamingConventions;
  testFramework: TestFramework;
  importStyle: ImportStyle;
  typeStyle: TypeStyle;
  linterConfigured: LinterStyle;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** How many candidate source files we sample for line-level analysis. */
const MAX_SAMPLES = 50;
/** Maximum file size we'll read for sampling (bigger files = noisy + slow). */
const MAX_FILE_BYTES = 200_000;
/** Minimum files that must agree before a category wins outright. */
const STRONG_CONSENSUS = 3;
/** Fraction of votes the leading category needs to win when STRONG_CONSENSUS isn't met. */
const SOFT_CONSENSUS = 0.6;
/** Walk depth when collecting candidate source files. */
const MAX_WALK_DEPTH = 5;

/** Extensions we treat as JS/TS for the purposes of language-specific votes. */
const JS_TS_EXTS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
/** Extensions we treat as TS only (for type-style votes). */
const TS_ONLY_EXTS: ReadonlySet<string> = new Set(['.ts', '.tsx']);
/** Extensions we treat as Python (for naming + framework votes). */
const PY_EXTS: ReadonlySet<string> = new Set(['.py']);
/** Extensions we treat as Go. */
const GO_EXTS: ReadonlySet<string> = new Set(['.go']);
/** Extensions we treat as Rust. */
const RUST_EXTS: ReadonlySet<string> = new Set(['.rs']);
/** Extensions we treat as plain source code overall. */
const SOURCE_EXTS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.rb',
  '.php',
  '.cs',
  '.cpp',
  '.cc',
  '.hpp',
  '.h',
  '.c',
  '.swift',
  '.kt',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan `projectRoot` and infer prevailing code-style conventions. Always
 * returns a complete `ExtractedCodeStyle` — properties default to `'mixed'`,
 * `'unknown'`, or `'none'` when there is not enough signal to decide.
 */
export async function extractCodeStyle(
  projectRoot: string,
): Promise<ExtractedCodeStyle> {
  const absRoot = path.resolve(projectRoot);

  // Try to stat the project root; if it doesn't exist, return defaults.
  try {
    const st = await fs.stat(absRoot);
    if (!st.isDirectory()) return defaultStyle();
  } catch {
    return defaultStyle();
  }

  const patterns = parseGitignore(absRoot);

  // 1) collect candidate source files (relative path + abs + mtime).
  const candidates = await collectCandidates(absRoot, patterns);

  // 2) sort by mtime desc and slice to MAX_SAMPLES.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const samples = candidates.slice(0, MAX_SAMPLES);

  // 3) per-file analysis — accumulate votes.
  const votes: VoteTallies = createTallies();
  for (const cand of samples) {
    let raw: string;
    try {
      const buf = await fs.readFile(cand.absPath);
      if (buf.length > MAX_FILE_BYTES) continue; // skip huge files outright
      raw = buf.toString('utf8');
    } catch {
      continue;
    }
    analyseFile(cand, raw, votes);
  }

  // 4) inspect manifest hints for test framework + linter.
  const manifests = await readManifestHints(absRoot);

  // 5) combine.
  return {
    indentation: pickIndent(votes),
    lineEndings: pickLineEndings(votes),
    quotes: pickQuotes(votes),
    semicolons: pickSemicolons(votes),
    namingConventions: {
      files: pickFileNaming(votes),
      functions: pickFunctionNaming(votes),
      constants: pickConstantNaming(votes),
    },
    testFramework: pickTestFramework(votes, manifests),
    importStyle: pickImportStyle(votes),
    typeStyle: pickTypeStyle(votes),
    linterConfigured: pickLinter(manifests),
  };
}

// ---------------------------------------------------------------------------
// Default / fallback result
// ---------------------------------------------------------------------------

function defaultStyle(): ExtractedCodeStyle {
  return {
    indentation: 'mixed',
    lineEndings: 'lf',
    quotes: 'mixed',
    semicolons: 'mixed',
    namingConventions: {
      files: 'mixed',
      functions: 'mixed',
      constants: 'mixed',
    },
    testFramework: 'unknown',
    importStyle: 'mixed',
    typeStyle: 'mixed',
    linterConfigured: 'none',
  };
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

interface Candidate {
  relPath: string;
  absPath: string;
  ext: string;
  mtimeMs: number;
}

async function collectCandidates(
  absRoot: string,
  patterns: string[],
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  await walk(absRoot, '', 0, patterns, out);
  return out;
}

async function walk(
  absDir: string,
  relDir: string,
  depth: number,
  patterns: string[],
  out: Candidate[],
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  let entries: Array<{ name: string; isDirectory: boolean }>;
  try {
    const dirents = await fs.readdir(absDir, { withFileTypes: true });
    entries = dirents.map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
    }));
  } catch {
    return;
  }

  for (const entry of entries) {
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    if (shouldIgnore(relPath, patterns)) continue;
    const absPath = path.join(absDir, entry.name);

    if (entry.isDirectory) {
      await walk(absPath, relPath, depth + 1, patterns, out);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) continue;

    let mtimeMs = 0;
    try {
      const st = await fs.stat(absPath);
      mtimeMs = st.mtimeMs;
      if (st.size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    out.push({ relPath, absPath, ext, mtimeMs });
  }
}

// ---------------------------------------------------------------------------
// Vote tallies
// ---------------------------------------------------------------------------

interface VoteTallies {
  indent: Map<IndentStyle, number>;
  lineEndings: Map<LineEndingStyle, number>;
  quotes: Map<QuoteStyle, number>;
  semicolons: Map<SemicolonStyle, number>;
  fileNaming: Map<FileNameStyle, number>;
  functionNaming: Map<FunctionNameStyle, number>;
  constantNaming: Map<ConstantNameStyle, number>;
  importStyle: Map<ImportStyle, number>;
  typeStyle: Map<TypeStyle, number>;
  testFrameworkSrc: Map<TestFramework, number>;
}

function createTallies(): VoteTallies {
  return {
    indent: new Map(),
    lineEndings: new Map(),
    quotes: new Map(),
    semicolons: new Map(),
    fileNaming: new Map(),
    functionNaming: new Map(),
    constantNaming: new Map(),
    importStyle: new Map(),
    typeStyle: new Map(),
    testFrameworkSrc: new Map(),
  };
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

function analyseFile(
  cand: Candidate,
  raw: string,
  votes: VoteTallies,
): void {
  // line endings
  const crlfCount = countOccurrences(raw, '\r\n');
  const lfOnlyCount = countOccurrences(raw, '\n') - crlfCount;
  if (crlfCount > lfOnlyCount && crlfCount > 0) {
    bump(votes.lineEndings, 'crlf');
  } else if (lfOnlyCount > 0) {
    bump(votes.lineEndings, 'lf');
  }

  // indentation: count leading whitespace patterns at start of indented lines.
  const indent = inferFileIndent(raw);
  if (indent !== null) bump(votes.indent, indent);

  // file-name conventions: classify the basename without ext
  const base = path.basename(cand.relPath, cand.ext);
  const fileStyle = classifyFileName(base);
  if (fileStyle !== null) bump(votes.fileNaming, fileStyle);

  if (JS_TS_EXTS.has(cand.ext)) {
    analyseJsTs(cand, raw, votes);
  } else if (PY_EXTS.has(cand.ext)) {
    analysePython(raw, votes);
  } else if (GO_EXTS.has(cand.ext)) {
    analyseGo(raw, votes);
  } else if (RUST_EXTS.has(cand.ext)) {
    analyseRust(raw, votes);
  }
}

// ---------------------------------------------------------------------------
// Indentation
// ---------------------------------------------------------------------------

function inferFileIndent(raw: string): IndentStyle | null {
  const lines = raw.split('\n');
  let tabLines = 0;
  let twoSpaceLines = 0;
  let fourSpaceLines = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    const ch = line[0];
    if (ch === '\t') {
      tabLines += 1;
      continue;
    }
    if (ch !== ' ') continue;
    // Count leading spaces.
    let n = 0;
    while (n < line.length && line[n] === ' ') n += 1;
    if (n === 0) continue;
    // Heuristic: 2-space indentation has lines with 2/4/6/8 spaces, but very
    // commonly the smallest non-zero indent observed is the unit. We count
    // how many lines match exactly 2 spaces and how many match exactly 4
    // (these are typically the first-level indent in their respective styles).
    if (n === 2) twoSpaceLines += 1;
    else if (n === 4) fourSpaceLines += 1;
  }
  const total = tabLines + twoSpaceLines + fourSpaceLines;
  if (total < 3) return null;
  // Pick the dominant family.
  if (tabLines >= twoSpaceLines && tabLines >= fourSpaceLines && tabLines > 0) {
    return 'tabs';
  }
  if (twoSpaceLines > fourSpaceLines) return '2-spaces';
  if (fourSpaceLines > twoSpaceLines) return '4-spaces';
  return 'mixed';
}

// ---------------------------------------------------------------------------
// Naming classification
// ---------------------------------------------------------------------------

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const SNAKE_CASE_RE = /^[a-z0-9]+(_[a-z0-9]+)+$/;
const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;
const SCREAMING_RE = /^[A-Z][A-Z0-9_]*$/;

function classifyFileName(base: string): FileNameStyle | null {
  if (base.length === 0) return null;
  // Strip dotted suffixes (e.g. `foo.test`, `foo.config`).
  const head = base.split('.')[0] ?? base;
  if (head.length === 0) return null;
  if (head.includes('-') && KEBAB_CASE_RE.test(head)) return 'kebab-case';
  if (head.includes('_') && SNAKE_CASE_RE.test(head)) return 'snake_case';
  if (PASCAL_CASE_RE.test(head)) return 'PascalCase';
  if (CAMEL_CASE_RE.test(head)) {
    // Plain lowercase identifiers (e.g. `index`, `cli`) are technically
    // camelCase by this regex, but they don't carry meaningful style
    // information. Still vote 'camelCase' but with a weaker signal — we
    // treat them as a regular vote for simplicity. Tests on plain-lower
    // single-word filenames should not be common enough to skew results.
    return 'camelCase';
  }
  return null;
}

function classifyFunctionName(name: string): FunctionNameStyle | null {
  if (name.length === 0) return null;
  if (name.includes('_') && SNAKE_CASE_RE.test(name)) return 'snake_case';
  if (CAMEL_CASE_RE.test(name)) return 'camelCase';
  return null;
}

function classifyConstantName(name: string): ConstantNameStyle | null {
  if (name.length === 0) return null;
  if (SCREAMING_RE.test(name) && name.includes('_')) return 'SCREAMING_SNAKE_CASE';
  if (CAMEL_CASE_RE.test(name)) return 'camelCase';
  return null;
}

// ---------------------------------------------------------------------------
// JS/TS specifics
// ---------------------------------------------------------------------------

const JS_FUNCTION_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/gm;
const JS_CONST_RE = /^\s*(?:export\s+)?const\s+([a-zA-Z_$][\w$]*)\s*=/gm;
const JS_INTERFACE_RE = /^\s*(?:export\s+)?interface\s+[A-Z][\w$]*/gm;
const JS_TYPE_ALIAS_RE = /^\s*(?:export\s+)?type\s+[A-Z][\w$]*\s*=/gm;
const JS_IMPORT_RE = /^\s*import\s+[^'";]*\s+from\s+(['"])([^'"]+)\1/gm;
const JS_REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const JS_SINGLE_QUOTE_RE = /'(?:[^'\\\n]|\\.)*'/g;
const JS_DOUBLE_QUOTE_RE = /"(?:[^"\\\n]|\\.)*"/g;
const JS_SEMICOLON_LINE_RE = /;\s*(?:\/\/[^\n]*)?$/;
const JS_TEST_HARNESS_HINTS: ReadonlyArray<{ re: RegExp; framework: TestFramework }> = [
  { re: /from\s+['"]bun:test['"]/, framework: 'bun:test' },
  { re: /from\s+['"]vitest['"]/, framework: 'vitest' },
  { re: /from\s+['"]@jest\/globals['"]/, framework: 'jest' },
  { re: /\bjest\.\s*(?:fn|mock|spyOn)\s*\(/, framework: 'jest' },
  { re: /\bvi\.\s*(?:fn|mock|spyOn)\s*\(/, framework: 'vitest' },
  { re: /describe\s*\(\s*['"`][^'"`]+['"`]\s*,/, framework: 'mocha' }, // weak signal
];

function analyseJsTs(
  cand: Candidate,
  raw: string,
  votes: VoteTallies,
): void {
  // quotes — single vs double, *only* counting string literals, not JSX attrs.
  const single = countMatches(raw, JS_SINGLE_QUOTE_RE);
  const double = countMatches(raw, JS_DOUBLE_QUOTE_RE);
  if (single + double >= 5) {
    if (single > double * 2) bump(votes.quotes, 'single');
    else if (double > single * 2) bump(votes.quotes, 'double');
    else bump(votes.quotes, 'mixed');
  }

  // semicolons — sample lines that end with a meaningful statement.
  let endingWithSemi = 0;
  let endingWithoutSemi = 0;
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed.length === 0) continue;
    const last = trimmed[trimmed.length - 1];
    if (last === '{' || last === '}' || last === '(' || last === ')' || last === ',' || last === ':' || last === ';') {
      if (last === ';') endingWithSemi += 1;
      continue;
    }
    // Look for "statement-like" lines (start with a keyword or identifier).
    if (!/^[a-zA-Z_$@/]/.test(trimmed)) continue;
    if (/^(?:if|for|while|switch|else|try|catch|finally|class|interface|type|function|export)\b/.test(trimmed)) continue;
    if (JS_SEMICOLON_LINE_RE.test(trimmed)) {
      endingWithSemi += 1;
    } else if (last !== '/' && last !== '*' && last !== '>' && !/^\s*\/\//.test(trimmed)) {
      // Skip lines that look like JSX or comments.
      endingWithoutSemi += 1;
    }
  }
  if (endingWithSemi + endingWithoutSemi >= 5) {
    if (endingWithSemi > endingWithoutSemi * 3) bump(votes.semicolons, 'always');
    else if (endingWithoutSemi > endingWithSemi * 3) bump(votes.semicolons, 'never');
    else bump(votes.semicolons, 'mixed');
  }

  // function naming
  for (const m of raw.matchAll(JS_FUNCTION_RE)) {
    const name = m[1];
    if (typeof name !== 'string') continue;
    const style = classifyFunctionName(name);
    if (style !== null) bump(votes.functionNaming, style);
  }

  // constant naming
  for (const m of raw.matchAll(JS_CONST_RE)) {
    const name = m[1];
    if (typeof name !== 'string') continue;
    const style = classifyConstantName(name);
    if (style !== null) bump(votes.constantNaming, style);
  }

  // type style — only TS files vote here
  if (TS_ONLY_EXTS.has(cand.ext)) {
    const interfaceCount = countMatches(raw, JS_INTERFACE_RE);
    const typeAliasCount = countMatches(raw, JS_TYPE_ALIAS_RE);
    if (interfaceCount + typeAliasCount >= 2) {
      if (interfaceCount >= typeAliasCount * 2) bump(votes.typeStyle, 'interface');
      else if (typeAliasCount >= interfaceCount * 2) bump(votes.typeStyle, 'type-alias');
      else bump(votes.typeStyle, 'mixed');
    }
  }

  // imports
  let relativeImports = 0;
  let absoluteImports = 0;
  const collectImport = (specifier: string): void => {
    if (specifier.startsWith('.')) {
      relativeImports += 1;
    } else if (specifier.startsWith('/') || /^@?[a-zA-Z][\w@/-]*$/.test(specifier)) {
      absoluteImports += 1;
    }
  };
  for (const m of raw.matchAll(JS_IMPORT_RE)) {
    const spec = m[2];
    if (typeof spec === 'string') collectImport(spec);
  }
  for (const m of raw.matchAll(JS_REQUIRE_RE)) {
    const spec = m[2];
    if (typeof spec === 'string') collectImport(spec);
  }
  if (relativeImports + absoluteImports >= 3) {
    if (relativeImports > absoluteImports * 2) bump(votes.importStyle, 'relative');
    else if (absoluteImports > relativeImports * 2) bump(votes.importStyle, 'absolute');
    else bump(votes.importStyle, 'mixed');
  }

  // test framework hints (source-code level)
  for (const hint of JS_TEST_HARNESS_HINTS) {
    if (hint.re.test(raw)) {
      bump(votes.testFrameworkSrc, hint.framework);
      break; // only count one hint per file
    }
  }
}

// ---------------------------------------------------------------------------
// Python specifics
// ---------------------------------------------------------------------------

const PY_FUNCTION_RE = /^\s*def\s+([a-zA-Z_][\w]*)\s*\(/gm;
const PY_CONST_RE = /^([A-Z][A-Z0-9_]*)\s*=/gm;
const PY_VAR_RE = /^([a-z_][a-z0-9_]*)\s*=/gm;
const PY_IMPORT_RE = /^\s*(?:from|import)\s+([.\w]+)/gm;

function analysePython(raw: string, votes: VoteTallies): void {
  // function naming
  for (const m of raw.matchAll(PY_FUNCTION_RE)) {
    const name = m[1];
    if (typeof name !== 'string') continue;
    const style = classifyFunctionName(name);
    if (style !== null) bump(votes.functionNaming, style);
  }
  // constant + variable naming
  let screaming = 0;
  let nonScreaming = 0;
  for (const m of raw.matchAll(PY_CONST_RE)) {
    const name = m[1];
    if (typeof name === 'string' && SCREAMING_RE.test(name) && name.includes('_')) {
      screaming += 1;
    }
  }
  for (const m of raw.matchAll(PY_VAR_RE)) {
    const name = m[1];
    if (typeof name !== 'string') continue;
    const style = classifyConstantName(name);
    if (style !== null && style !== 'SCREAMING_SNAKE_CASE') nonScreaming += 1;
  }
  if (screaming + nonScreaming >= 2) {
    if (screaming > nonScreaming) bump(votes.constantNaming, 'SCREAMING_SNAKE_CASE');
    else bump(votes.constantNaming, 'camelCase');
  }
  // imports
  let relativeImports = 0;
  let absoluteImports = 0;
  for (const m of raw.matchAll(PY_IMPORT_RE)) {
    const spec = m[1];
    if (typeof spec !== 'string') continue;
    if (spec.startsWith('.')) relativeImports += 1;
    else absoluteImports += 1;
  }
  if (relativeImports + absoluteImports >= 3) {
    if (relativeImports > absoluteImports * 2) bump(votes.importStyle, 'relative');
    else if (absoluteImports > relativeImports * 2) bump(votes.importStyle, 'absolute');
    else bump(votes.importStyle, 'mixed');
  }
  // test framework
  if (/\bimport\s+pytest\b/.test(raw) || /\bdef\s+test_[a-z]/i.test(raw)) {
    bump(votes.testFrameworkSrc, 'pytest');
  }
}

// ---------------------------------------------------------------------------
// Go specifics
// ---------------------------------------------------------------------------

const GO_FUNCTION_RE = /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)\s*\(/gm;

function analyseGo(raw: string, votes: VoteTallies): void {
  for (const m of raw.matchAll(GO_FUNCTION_RE)) {
    const name = m[1];
    if (typeof name !== 'string') continue;
    const style = classifyFunctionName(name);
    if (style !== null) bump(votes.functionNaming, style);
  }
  if (/\btesting\.T\b/.test(raw) || /^\s*func\s+Test[A-Z]/m.test(raw)) {
    bump(votes.testFrameworkSrc, 'go-test');
  }
}

// ---------------------------------------------------------------------------
// Rust specifics
// ---------------------------------------------------------------------------

const RS_FUNCTION_RE = /^\s*(?:pub\s+(?:\([^)]*\)\s+)?)?fn\s+([a-zA-Z_][\w]*)\s*[(<]/gm;

function analyseRust(raw: string, votes: VoteTallies): void {
  for (const m of raw.matchAll(RS_FUNCTION_RE)) {
    const name = m[1];
    if (typeof name !== 'string') continue;
    const style = classifyFunctionName(name);
    if (style !== null) bump(votes.functionNaming, style);
  }
}

// ---------------------------------------------------------------------------
// Manifest hints (test framework, linter)
// ---------------------------------------------------------------------------

interface ManifestHints {
  testFramework: TestFramework | null;
  linter: LinterStyle;
}

async function readManifestHints(absRoot: string): Promise<ManifestHints> {
  const linters: Set<Exclude<LinterStyle, 'none' | 'multiple'>> = new Set();
  let testFramework: TestFramework | null = null;

  // package.json — primary source for JS/TS test framework + linter info.
  const pkgPath = path.join(absRoot, 'package.json');
  const pkgJson = await readJsonSafe(pkgPath);
  if (pkgJson !== null && typeof pkgJson === 'object') {
    const deps = collectDeps(pkgJson);
    if (deps.has('vitest')) testFramework = 'vitest';
    else if (deps.has('jest')) testFramework = 'jest';
    else if (deps.has('mocha')) testFramework = 'mocha';
    // bun:test is built into bun — detect via bunfig.toml below.

    if (deps.has('eslint') || deps.has('@eslint/js') || deps.has('@typescript-eslint/eslint-plugin')) {
      linters.add('eslint');
    }
    if (deps.has('@biomejs/biome')) linters.add('biome');
    if (deps.has('prettier')) linters.add('prettier');
  }

  // Bun-test detection: bunfig.toml mentioning [test] OR test scripts using `bun test`.
  if (await fileExists(path.join(absRoot, 'bunfig.toml'))) {
    if (testFramework === null) testFramework = 'bun:test';
  }
  if (
    pkgJson !== null &&
    typeof pkgJson === 'object' &&
    typeof (pkgJson as { scripts?: unknown }).scripts === 'object'
  ) {
    const scripts = (pkgJson as { scripts: Record<string, unknown> }).scripts;
    const testScript = scripts['test'];
    if (typeof testScript === 'string' && testScript.includes('bun test')) {
      if (testFramework === null) testFramework = 'bun:test';
    }
  }

  // Standalone linter config files.
  if (
    (await fileExists(path.join(absRoot, '.eslintrc'))) ||
    (await fileExists(path.join(absRoot, '.eslintrc.js'))) ||
    (await fileExists(path.join(absRoot, '.eslintrc.json'))) ||
    (await fileExists(path.join(absRoot, 'eslint.config.js'))) ||
    (await fileExists(path.join(absRoot, 'eslint.config.ts'))) ||
    (await fileExists(path.join(absRoot, 'eslint.config.mjs')))
  ) {
    linters.add('eslint');
  }
  if (
    (await fileExists(path.join(absRoot, 'biome.json'))) ||
    (await fileExists(path.join(absRoot, 'biome.jsonc')))
  ) {
    linters.add('biome');
  }
  if (
    (await fileExists(path.join(absRoot, '.prettierrc'))) ||
    (await fileExists(path.join(absRoot, '.prettierrc.json'))) ||
    (await fileExists(path.join(absRoot, '.prettierrc.js'))) ||
    (await fileExists(path.join(absRoot, 'prettier.config.js')))
  ) {
    linters.add('prettier');
  }

  // Python: ruff
  if (
    (await fileExists(path.join(absRoot, 'ruff.toml'))) ||
    (await fileExists(path.join(absRoot, '.ruff.toml')))
  ) {
    linters.add('ruff');
  } else {
    const pyproject = await readToml(path.join(absRoot, 'pyproject.toml'));
    if (pyproject !== null && pyproject.includes('[tool.ruff')) {
      linters.add('ruff');
    }
  }

  // Pytest (Python)
  if (testFramework === null) {
    if (
      (await fileExists(path.join(absRoot, 'pytest.ini'))) ||
      (await fileExists(path.join(absRoot, 'conftest.py'))) ||
      (await fileExists(path.join(absRoot, 'pyproject.toml')))
    ) {
      const pyproject = await readToml(path.join(absRoot, 'pyproject.toml'));
      if (
        (pyproject !== null && pyproject.includes('[tool.pytest')) ||
        (await fileExists(path.join(absRoot, 'pytest.ini')))
      ) {
        testFramework = 'pytest';
      }
    }
  }

  // Go: go.mod implies gofmt, and `_test.go` files imply go-test.
  if (await fileExists(path.join(absRoot, 'go.mod'))) {
    linters.add('gofmt');
    if (testFramework === null) testFramework = 'go-test';
  }

  // Combine linters.
  let linterStyle: LinterStyle;
  if (linters.size === 0) linterStyle = 'none';
  else if (linters.size === 1) {
    const only = [...linters][0];
    linterStyle = only ?? 'none';
  } else linterStyle = 'multiple';

  return { testFramework, linter: linterStyle };
}

function collectDeps(pkg: object): Set<string> {
  const out = new Set<string>();
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const sec of sections) {
    const block = (pkg as Record<string, unknown>)[sec];
    if (block !== null && typeof block === 'object') {
      for (const k of Object.keys(block)) out.add(k);
    }
  }
  return out;
}

async function readJsonSafe(filePath: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function readToml(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Picking winners from votes
// ---------------------------------------------------------------------------

function pickWinner<K extends string>(
  map: Map<K, number>,
  fallback: K,
): K | null {
  if (map.size === 0) return null;
  let total = 0;
  let topKey: K | null = null;
  let topCount = -1;
  for (const [k, v] of map) {
    total += v;
    if (v > topCount) {
      topCount = v;
      topKey = k;
    }
  }
  if (topKey === null) return fallback;
  if (topCount >= STRONG_CONSENSUS) return topKey;
  if (total > 0 && topCount / total >= SOFT_CONSENSUS) return topKey;
  return null;
}

function pickIndent(votes: VoteTallies): IndentStyle {
  return pickWinner(votes.indent, 'mixed') ?? 'mixed';
}

function pickLineEndings(votes: VoteTallies): LineEndingStyle {
  return pickWinner(votes.lineEndings, 'lf') ?? 'lf';
}

function pickQuotes(votes: VoteTallies): QuoteStyle {
  return pickWinner(votes.quotes, 'mixed') ?? 'mixed';
}

function pickSemicolons(votes: VoteTallies): SemicolonStyle {
  return pickWinner(votes.semicolons, 'mixed') ?? 'mixed';
}

function pickFileNaming(votes: VoteTallies): FileNameStyle {
  return pickWinner(votes.fileNaming, 'mixed') ?? 'mixed';
}

function pickFunctionNaming(votes: VoteTallies): FunctionNameStyle {
  return pickWinner(votes.functionNaming, 'mixed') ?? 'mixed';
}

function pickConstantNaming(votes: VoteTallies): ConstantNameStyle {
  return pickWinner(votes.constantNaming, 'mixed') ?? 'mixed';
}

function pickImportStyle(votes: VoteTallies): ImportStyle {
  return pickWinner(votes.importStyle, 'mixed') ?? 'mixed';
}

function pickTypeStyle(votes: VoteTallies): TypeStyle {
  return pickWinner(votes.typeStyle, 'mixed') ?? 'mixed';
}

function pickTestFramework(
  votes: VoteTallies,
  manifests: ManifestHints,
): TestFramework {
  // Manifest hints win — they are dispositive.
  if (manifests.testFramework !== null) return manifests.testFramework;
  // Otherwise, look at source-code hints.
  return pickWinner(votes.testFrameworkSrc, 'unknown') ?? 'unknown';
}

function pickLinter(manifests: ManifestHints): LinterStyle {
  return manifests.linter;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return count;
    count += 1;
    from = idx + needle.length;
  }
}

function countMatches(haystack: string, regex: RegExp): number {
  // Reset stateful regex for safety.
  if (regex.global || regex.sticky) {
    regex.lastIndex = 0;
  }
  let count = 0;
  if (regex.global) {
    for (const _ of haystack.matchAll(regex)) count += 1;
  } else {
    if (regex.test(haystack)) count = 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Markdown rendering helper (used by buildInitPrompt)
// ---------------------------------------------------------------------------

/**
 * Render an `ExtractedCodeStyle` as a Markdown section suitable for embedding
 * in LOCALCODE.md or a system-prompt project-conventions block.
 */
export function renderCodeStyleMarkdown(style: ExtractedCodeStyle): string {
  const lines: string[] = [];
  lines.push('## Project Conventions (auto-detected, DO NOT VIOLATE)');
  lines.push(`- Indentation: ${style.indentation}`);
  lines.push(`- Line endings: ${style.lineEndings}`);
  lines.push(`- Quotes: ${style.quotes}`);
  lines.push(`- Semicolons: ${style.semicolons}`);
  lines.push(
    `- Naming: files ${style.namingConventions.files}, functions ${style.namingConventions.functions}, constants ${style.namingConventions.constants}`,
  );
  lines.push(`- Test framework: ${style.testFramework}`);
  lines.push(`- Import style: ${style.importStyle}`);
  lines.push(`- Type style: ${style.typeStyle}`);
  lines.push(`- Linter: ${style.linterConfigured}`);
  return lines.join('\n');
}
