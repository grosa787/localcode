/**
 * Sensitive-files gate.
 *
 * `~/.localcode/sensitive-files.toml` (global) and
 * `<projectRoot>/.localcode/sensitive-files.toml` (project) declare path
 * patterns that ALWAYS require user approval — even under permissive
 * profiles (`dontAsk`, `bypassPermissions`) and even when a per-tool
 * `autoApproveTools` allow-list would otherwise let the call through.
 *
 * The module ships a built-in defaults catalog so users get baseline
 * protection without writing any config (env files, secrets, ssh keys,
 * AWS credentials, private keys, etc.).
 *
 * Layering: defaults  ◀  global overlay  ◀  project overlay.
 * Overlay = "extend", never "replace". Duplicates dedupe on `pattern`
 * (later overlay's `reason` wins so users can re-document defaults
 * without losing them).
 *
 * Glob subset:
 *   - "**"        any number of path segments (or none)
 *   - "*"         any chars within a segment (not "/")
 *   - "?"         one char within a segment
 *   - "{a,b,c}"   alternation
 *   - leading "." IS matched (env / dotfiles need this)
 *
 * Patterns are matched against THREE forms of the path:
 *   1. The project-relative POSIX path (no leading "/").
 *   2. The absolute POSIX path.
 *   3. The basename only — so ".env*" catches "path/to/.env.local".
 * Pattern matches succeed when ANY form matches. This avoids the
 * surprise of a "** + /x" user pattern failing because the user only
 * remembered the basename form.
 *
 * Case-sensitivity: matches respect platform conventions — case-
 * insensitive on darwin/win32 (the local filesystems are CI), strict on
 * linux. This mirrors how the on-disk file actually resolves.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

// ---------- Public types ----------

export interface SensitivePattern {
  readonly pattern: string;
  readonly reason: string;
  /** Where this rule originated. Helpful for `/sensitive list` output. */
  readonly source: 'default' | 'global' | 'project';
}

export interface SensitiveConfig {
  /** Patterns in deterministic order: defaults first, then global, then project. */
  readonly patterns: readonly SensitivePattern[];
}

export type SensitiveMatch =
  | { sensitive: true; pattern: string; reason: string; source: SensitivePattern['source'] }
  | { sensitive: false };

// ---------- Defaults ----------

/**
 * Built-in catalog. Active even when no config file exists. Reasons
 * intentionally short — they're surfaced in approval prompts.
 *
 * Patterns are deliberately conservative: a developer who genuinely
 * wants to bypass should add an explicit override path under a non-
 * sensitive location, not weaken the catalog.
 */
export const DEFAULT_SENSITIVE_PATTERNS: readonly { pattern: string; reason: string }[] = [
  { pattern: '**/.env', reason: 'Environment variables often contain secrets' },
  { pattern: '**/.env.*', reason: 'Environment variables often contain secrets' },
  { pattern: '.env', reason: 'Environment variables often contain secrets' },
  { pattern: '.env.*', reason: 'Environment variables often contain secrets' },
  { pattern: '**/secrets/**', reason: 'Anything under a `secrets/` directory' },
  { pattern: '**/*.pem', reason: 'Private keys' },
  { pattern: '**/*.key', reason: 'Private keys' },
  { pattern: '**/credentials*', reason: 'Credentials files' },
  { pattern: '**/.aws/**', reason: 'AWS credentials' },
  { pattern: '**/.ssh/**', reason: 'SSH keys' },
  { pattern: '**/id_rsa*', reason: 'SSH private key' },
  { pattern: '**/id_ed25519*', reason: 'SSH private key' },
  { pattern: '**/id_ecdsa*', reason: 'SSH private key' },
  { pattern: '**/*.pfx', reason: 'PKCS#12 certificate bundle' },
  { pattern: '**/*.p12', reason: 'PKCS#12 certificate bundle' },
  { pattern: '**/.netrc', reason: 'Network credentials' },
  { pattern: '**/.npmrc', reason: 'May contain auth tokens' },
  { pattern: '**/.pypirc', reason: 'May contain PyPI auth tokens' },
];

// ---------- TOML schema ----------

const SensitiveEntrySchema = z.object({
  pattern: z.string().min(1, 'pattern must be a non-empty string'),
  reason: z.string().optional(),
});

const SensitiveFileSchema = z
  .object({
    sensitive: z.array(SensitiveEntrySchema).default([]),
  })
  .default({ sensitive: [] });

// ---------- Path resolution ----------

/** Resolve the canonical sensitive-files.toml path for a project root. */
export function projectSensitiveFilesPath(projectRoot: string): string {
  return path.join(projectRoot, '.localcode', 'sensitive-files.toml');
}

/** Resolve the canonical sensitive-files.toml path for a home directory. */
export function globalSensitiveFilesPath(homeDir: string): string {
  return path.join(homeDir, '.localcode', 'sensitive-files.toml');
}

// ---------- Loader ----------

/**
 * Load + merge defaults, global, and project sensitive-files configs.
 *
 *   - Defaults always active.
 *   - Global file missing → silently skipped.
 *   - Project file missing → silently skipped.
 *   - Parse or Zod failure → that overlay is skipped with a console.warn;
 *     the rest of the layering still loads. We intentionally do NOT
 *     throw — a broken user-edit shouldn't disable the baseline.
 *
 * Dedupe rule: when two layers declare the same `pattern`, the later
 * layer (project ▶ global ▶ default) wins on `reason`, but the entry's
 * `source` reflects the strongest layer present so list/check commands
 * can show users where to edit.
 */
export function loadSensitiveFiles(projectRoot: string, homeDir?: string): SensitiveConfig {
  const home = homeDir ?? os.homedir();
  const collected: SensitivePattern[] = [];
  const indexByPattern = new Map<string, number>();

  const push = (entry: { pattern: string; reason?: string }, source: SensitivePattern['source'], defaultReason: string): void => {
    const reason = (entry.reason !== undefined && entry.reason.length > 0)
      ? entry.reason
      : defaultReason;
    const existing = indexByPattern.get(entry.pattern);
    if (existing === undefined) {
      indexByPattern.set(entry.pattern, collected.length);
      collected.push({ pattern: entry.pattern, reason, source });
      return;
    }
    // Overlay wins on reason, and we upgrade the source field so /sensitive list
    // can tell users where to edit the active row.
    collected[existing] = { pattern: entry.pattern, reason, source };
  };

  for (const def of DEFAULT_SENSITIVE_PATTERNS) {
    push(def, 'default', def.reason);
  }

  const globalEntries = readOverlay(globalSensitiveFilesPath(home));
  for (const e of globalEntries) {
    push(e, 'global', e.reason ?? '(no reason provided)');
  }

  const projectEntries = readOverlay(projectSensitiveFilesPath(projectRoot));
  for (const e of projectEntries) {
    push(e, 'project', e.reason ?? '(no reason provided)');
  }

  return { patterns: collected };
}

/** Parse a single overlay file. Returns [] when missing or invalid. */
function readOverlay(filePath: string): Array<{ pattern: string; reason?: string }> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (cause) {
    const errno = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (errno === 'ENOENT') return [];
    // eslint-disable-next-line no-console
    console.warn(`[sensitive-files] failed to read ${filePath}: ${describe(cause)}`);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.warn(`[sensitive-files] failed to parse ${filePath}: ${describe(cause)}`);
    return [];
  }
  const result = SensitiveFileSchema.safeParse(parsed);
  if (!result.success) {
    // eslint-disable-next-line no-console
    console.warn(
      `[sensitive-files] schema validation for ${filePath} failed: ${result.error.issues.map((i) => i.message).join('; ')}`,
    );
    return [];
  }
  return result.data.sensitive.map((e) => {
    const out: { pattern: string; reason?: string } = { pattern: e.pattern };
    if (e.reason !== undefined) out.reason = e.reason;
    return out;
  });
}

// ---------- Matcher ----------

/**
 * Compile a single glob into a RegExp. Mirrors the subset documented at
 * the top of this module. Anchored to start AND end.
 */
function globToRegex(glob: string, caseInsensitive: boolean): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] as string;
    const next = glob[i + 1];
    if (ch === '*' && next === '*') {
      // `**/`
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
  return new RegExp('^' + re + '$', caseInsensitive ? 'i' : '');
}

/**
 * Decide whether a tool's target path is sensitive under the supplied
 * config. Returns the first match (defaults first → project last) so
 * the surfaced reason is deterministic.
 *
 * `absolutePath` MUST be absolute. `projectRoot` MUST be absolute. Both
 * are normalised to POSIX-style slashes before matching.
 */
export function isSensitivePath(
  absolutePath: string,
  projectRoot: string,
  config: SensitiveConfig,
): SensitiveMatch {
  if (config.patterns.length === 0) return { sensitive: false };

  const abs = toPosix(absolutePath);
  const root = toPosix(projectRoot);
  // Project-relative path. May start with `../` if path is outside root;
  // we still try matching against the absolute form in that case.
  const rel = computeRelative(abs, root);
  const base = basenameOf(abs);
  const candidates = [rel, abs, base];

  const caseInsensitive = platformIsCaseInsensitive();
  for (const entry of config.patterns) {
    const re = globToRegex(entry.pattern, caseInsensitive);
    for (const candidate of candidates) {
      if (candidate.length === 0) continue;
      if (re.test(candidate)) {
        return {
          sensitive: true,
          pattern: entry.pattern,
          reason: entry.reason,
          source: entry.source,
        };
      }
    }
  }
  return { sensitive: false };
}

function toPosix(p: string): string {
  // Normalise both forward and back slashes; trim trailing slashes so
  // `secrets/` matches `secrets`.
  const normalised = p.replace(/\\+/g, '/');
  if (normalised.length > 1 && normalised.endsWith('/')) return normalised.slice(0, -1);
  return normalised;
}

function computeRelative(abs: string, root: string): string {
  if (root.length === 0) return abs;
  // Bare equality
  if (abs === root) return '';
  // Strip the root prefix when present
  const withSlash = root.endsWith('/') ? root : root + '/';
  if (abs.startsWith(withSlash)) {
    return abs.slice(withSlash.length);
  }
  // Path outside the project root — fall back to the absolute form by
  // returning an empty string; the caller's candidate list still has
  // `abs` available.
  return '';
}

function basenameOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

function platformIsCaseInsensitive(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

// ---------- Tool argument extraction ----------

/**
 * Best-effort extraction of file paths from a tool call's argument
 * record. Returns `[]` when no usable path is present. Plural form to
 * accommodate `multi_edit` (single path) and `run_command` (heuristic —
 * may scan multiple referenced files).
 *
 * Heuristics per tool:
 *   - `read_file`, `write_file`, `edit_file`, `multi_edit`,
 *     `list_dir`, `lint_file`, `find_symbol`, `notebook_read`,
 *     `notebook_edit`            → `args.path`
 *   - `glob_search`              → `args.pattern` is a glob, NOT a path;
 *                                  we do NOT inspect it.
 *   - `run_command`              → token-scan `args.command` for tokens
 *                                  that look like paths (`/`-bearing,
 *                                  `~/...`, or known dotfile basenames
 *                                  with extensions). Honest gap: this
 *                                  is a HEURISTIC and will both
 *                                  false-positive (e.g. an unrelated
 *                                  `/etc/hosts` substring inside an
 *                                  echo string) and false-negative
 *                                  (e.g. shell expansions). The
 *                                  conservative choice is to err on the
 *                                  side of more prompts — false
 *                                  positives are merely annoying;
 *                                  false negatives could leak secrets.
 *
 * `projectRoot` is used to resolve relative paths to absolute form.
 */
export function extractToolPaths(
  toolName: string,
  args: Record<string, unknown>,
  projectRoot: string,
): readonly string[] {
  const collected: string[] = [];

  const pushFromArg = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    collected.push(absolutise(trimmed, projectRoot));
  };

  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'multi_edit':
    case 'list_dir':
    case 'lint_file':
    case 'find_symbol':
    case 'notebook_read':
    case 'notebook_edit':
    case 'read_pdf':
      pushFromArg(args['path']);
      // `find_symbol` also accepts `file` in some shapes — be liberal.
      pushFromArg((args as { file?: unknown }).file);
      break;
    case 'glob_search':
      // `pattern` is a glob, not a literal file. Skip — the matched
      // files (if any) are NOT created by the search itself, and a glob
      // returns only paths that already exist; reads happen via
      // separate `read_file` calls that go through this gate.
      break;
    case 'run_command':
      collected.push(...scanCommandForPaths(args['command'], projectRoot));
      // `cwd` is a directory the command will execute under — if that
      // directory itself is sensitive, prompt.
      pushFromArg(args['cwd']);
      break;
    default:
      // Unknown tool — be defensive: any `path`-ish string field gets
      // checked. Cheap and false-positives are tolerable.
      pushFromArg(args['path']);
      pushFromArg((args as { file?: unknown }).file);
      break;
  }

  return collected;
}

function absolutise(rawPath: string, projectRoot: string): string {
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  if (rawPath === '~') {
    return os.homedir();
  }
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(projectRoot, rawPath);
}

/**
 * Token-scan a shell command string and surface every token that looks
 * like it could be a path. Conservative — see the `extractToolPaths`
 * docstring for the rationale.
 */
function scanCommandForPaths(
  command: unknown,
  projectRoot: string,
): readonly string[] {
  if (typeof command !== 'string') return [];
  const tokens = command.split(/[\s;|&<>(){}]+/);
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length === 0) continue;
    // Strip simple shell quoting.
    const stripped = stripQuotes(t);
    if (stripped.length === 0) continue;
    if (looksLikePath(stripped)) {
      out.push(absolutise(stripped, projectRoot));
    }
  }
  return out;
}

function stripQuotes(token: string): string {
  if (token.length < 2) return token;
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * True when the token has a path-ish shape. Intentionally NOT a strict
 * filesystem check (we never stat) — the check is purely lexical so a
 * single sensitive file referenced in a `cat` command still flags the
 * approval prompt.
 */
function looksLikePath(token: string): boolean {
  if (token.startsWith('~/') || token === '~') return true;
  if (token.startsWith('/')) return true;
  if (token.startsWith('./') || token.startsWith('../')) return true;
  if (token.includes('/')) return true;
  // Standalone dotfiles with a name pattern (e.g. `.env`, `.npmrc`).
  if (token.startsWith('.') && token.length > 1 && !token.startsWith('..')) {
    return true;
  }
  // Bare filenames with a recognised extension.
  if (/\.[A-Za-z0-9]{1,6}$/.test(token) && !token.includes(' ')) {
    return true;
  }
  return false;
}
