/**
 * LOCALCODE.md generation and persistence.
 *
 * This module:
 *   - Builds the LLM prompt that asks the model to produce a structured
 *     LOCALCODE.md for the current project (`buildInitPrompt`).
 *   - Writes the result into `<projectRoot>/.localcode/LOCALCODE.md`,
 *     creating the directory layout and updating `.gitignore` as needed
 *     (`writeLocalcodeMd`).
 *   - Reads an existing LOCALCODE.md for an in-place update flow
 *     (`readLocalcodeMd`).
 *   - Provides a cheap existence check for the `/context` command
 *     (`getLocalcodeMdStatus`).
 *   - Scaffolds the `.localcode/` skeleton (directory, skills/ subdir,
 *     stub LOCALCODE.md, .gitignore entry) on first launch in any project
 *     (`ensureLocalcodeScaffold`). Idempotent.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LOCALCODE_INLINE_LIMIT } from '@/llm/context-manager';

import type { ScanResult, KeyFile } from './project-scanner';
import { renderCodeStyleMarkdown } from './code-style-extractor';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCALCODE_DIR = '.localcode';
const LOCALCODE_MD_FILE = 'LOCALCODE.md';
const SETTINGS_JSON_FILE = 'settings.json';
const SKILLS_DIR = 'skills';
const GITIGNORE_FILE = '.gitignore';
const GITIGNORE_ENTRY = `${LOCALCODE_DIR}/`;

/**
 * Minimal placeholder body written into a freshly-scaffolded
 * `.localcode/LOCALCODE.md`. Hints the user toward `/init` for an
 * auto-generated version, but is never overwritten if the file already
 * exists.
 */
const STUB_LOCALCODE_MD = `# Project Context

This file gives LocalCode context about your project. The AI model reads it to understand your stack, conventions, and goals.

## How to fill this out

- Run \`/init\` in LocalCode to auto-scan the project and generate this file.
- Or edit it manually with whatever context you want the model to have.
- If this file is large, the model lazy-loads it via \`read_file\` when needed.

## Project overview
(Briefly describe what this project does.)

## Tech stack
(List main languages, frameworks, libraries.)

## Conventions
(Coding style, file layout, testing approach, etc.)

## Common tasks
(Build, test, run commands; deployment notes.)
`;

/** Map extension → code-fence language tag for the key-file section. */
const FENCE_LANGUAGES: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.toml': 'toml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.h': 'cpp',
  '.c': 'c',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.sh': 'bash',
  '.sql': 'sql',
  '.html': 'html',
  '.css': 'css',
  '.xml': 'xml',
  '.gradle': 'groovy',
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the one-shot user prompt sent to the LLM to produce LOCALCODE.md.
 *
 * Layout (per master prompt spec):
 *
 *   Analyze this project and create a structured LOCALCODE.md file.
 *
 *   Project structure:
 *   {tree}
 *
 *   Key files content:
 *   ### <path>
 *   ```lang
 *   <content>
 *   ```
 *
 *   {if existing:
 *     Update the existing LOCALCODE.md:
 *     {existing}
 *   }
 *
 *   Generate LOCALCODE.md with sections:
 *   ## Project Overview
 *   ## Tech Stack
 *   ## Architecture
 *   ## Key Files
 *   ## Development Conventions
 *   ## Common Tasks
 *
 *   Respond with only the markdown file content, no preamble.
 */
export function buildInitPrompt(
  scan: ScanResult,
  existing: string | null,
): string {
  const parts: string[] = [];

  parts.push('Analyze this project and create a structured LOCALCODE.md file.');
  parts.push('');
  parts.push('Project structure:');
  parts.push(scan.tree);
  parts.push('');
  parts.push('Key files content:');
  parts.push(renderKeyFiles(scan.keyFiles));

  // Auto-detected code style (ROADMAP #7). Inject as a project-conventions
  // block the model MUST respect. Only emit when the scanner populated it.
  if (scan.codeStyle !== undefined) {
    parts.push('');
    parts.push(renderCodeStyleMarkdown(scan.codeStyle));
  }

  if (existing !== null && existing.trim().length > 0) {
    parts.push('');
    parts.push(`Update the existing LOCALCODE.md:\n${existing}`);
  }

  parts.push('');
  parts.push('Generate LOCALCODE.md with sections:');
  parts.push('## Project Overview');
  parts.push('## Tech Stack');
  parts.push('## Architecture');
  parts.push('## Key Files');
  parts.push('## Development Conventions');
  parts.push('## Common Tasks');
  parts.push('');
  parts.push(
    'IMPORTANT: include a "## Project Conventions (auto-detected, DO NOT VIOLATE)" section with the indentation, quote style, naming conventions, test framework, and import-style values shown above. The model must respect these conventions in all subsequent code generation.',
  );
  parts.push('');
  parts.push('Respond with only the markdown file content, no preamble.');

  return parts.join('\n');
}

function renderKeyFiles(keyFiles: KeyFile[]): string {
  if (keyFiles.length === 0) {
    return '(no key files detected)';
  }
  const blocks: string[] = [];
  for (const kf of keyFiles) {
    const ext = path.extname(kf.path).toLowerCase();
    const lang = FENCE_LANGUAGES[ext] ?? languageFromBasename(kf.path);
    blocks.push(`### ${kf.path}\n\`\`\`${lang}\n${kf.content}\n\`\`\``);
  }
  return blocks.join('\n\n');
}

/**
 * Fallback fence language when the file has no extension we recognise
 * (e.g. `Dockerfile`, `Gemfile`, `Makefile`).
 */
function languageFromBasename(relPath: string): string {
  const base = path.basename(relPath).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'gemfile') return 'ruby';
  if (base === 'makefile') return 'makefile';
  return '';
}

// ---------------------------------------------------------------------------
// Filesystem operations
// ---------------------------------------------------------------------------

/**
 * Persist the generated LOCALCODE.md at `<projectRoot>/.localcode/LOCALCODE.md`.
 *
 * Side effects (all idempotent):
 *   - Creates `.localcode/` if missing.
 *   - Creates `.localcode/skills/` if missing (Agent 6's default skills dir
 *     *is* `~/.localcode/skills/` but we still scaffold a per-project one
 *     so users can drop project-scoped skills into it later).
 *   - Appends `.localcode/` to `.gitignore` if not already present; creates
 *     the file if it doesn't exist.
 *
 * Throws on unrecoverable I/O errors (disk full, permission denied, …).
 */
export function writeLocalcodeMd(
  projectRoot: string,
  content: string,
): void {
  const absRoot = path.resolve(projectRoot);
  const localcodeDir = path.join(absRoot, LOCALCODE_DIR);
  const skillsDir = path.join(localcodeDir, SKILLS_DIR);
  const mdPath = path.join(localcodeDir, LOCALCODE_MD_FILE);

  if (!existsSync(localcodeDir)) {
    mkdirSync(localcodeDir, { recursive: true });
  }
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  writeFileSync(mdPath, normaliseTrailingNewline(content), 'utf-8');
  ensureGitignoreEntry(absRoot);
}

/**
 * Return the contents of `<projectRoot>/.localcode/LOCALCODE.md`, or
 * `null` if the file is missing. Throws only on genuine I/O errors (e.g.
 * permission denied on an existing file).
 */
export function readLocalcodeMd(projectRoot: string): string | null {
  const absRoot = path.resolve(projectRoot);
  const mdPath = path.join(absRoot, LOCALCODE_DIR, LOCALCODE_MD_FILE);
  if (!existsSync(mdPath)) return null;
  return readFileSync(mdPath, 'utf-8');
}

/**
 * Lightweight status check for `/context` — no file read, just existence.
 */
export function getLocalcodeMdStatus(
  projectRoot: string,
): { exists: boolean; path: string } {
  const absRoot = path.resolve(projectRoot);
  const mdPath = path.join(absRoot, LOCALCODE_DIR, LOCALCODE_MD_FILE);
  return { exists: existsSync(mdPath), path: mdPath };
}

// ---------------------------------------------------------------------------
// Hierarchy loader
// ---------------------------------------------------------------------------

/**
 * Per-directory entry produced by the upward walk. Outermost (global) first,
 * innermost (project root) last — same order as Claude Code's CLAUDE.md walk.
 */
interface HierarchyFile {
  /** Absolute path on disk. */
  absPath: string;
  /** Display label used as the section header in inlined output. */
  label: string;
  /** Raw file contents at the time of read. */
  content: string;
}

/**
 * Result of `loadHierarchy`.
 *
 * Exactly one of `inline` / `pointers` is populated (or both omitted when no
 * LOCALCODE.md is found anywhere).
 *
 * - `inline`: concatenated body suitable for direct injection into the system
 *   prompt. Always present when joined size <= `LOCALCODE_INLINE_LIMIT`.
 * - `pointers`: absolute paths to each LOCALCODE.md that was found. Used by
 *   the system-prompt renderer to tell the model to `read_file` on demand.
 * - `size`: total joined character count (including separators). The
 *   inline-vs-pointer decision is based on this number.
 */
export interface LocalcodeMdHierarchyResult {
  inline?: string;
  pointers?: string[];
  /** Joined size in characters (sum of contents + separator overhead). */
  size: number;
}

/**
 * Walk from `projectRoot` upward, collecting every `.localcode/LOCALCODE.md`
 * we encounter, then prepend the global `~/.localcode/LOCALCODE.md` (if any)
 * as the deepest "parent". Concatenate outermost → innermost so that the
 * model sees broader rules first and progressively narrower / overriding
 * rules nearer the project root.
 *
 * Walk terminates at the user's `$HOME` directory (we never read parents of
 * `$HOME`, matching Claude Code's behaviour) or at the filesystem root when
 * `projectRoot` is outside `$HOME`.
 *
 * Symlinks: we never follow symlinked directories upward — `path.dirname`
 * already gives us the lexical parent, so loop avoidance is automatic. We
 * additionally `lstatSync` each `.localcode/LOCALCODE.md` and skip symlinked
 * files for safety (the resolve target may live outside the walk).
 *
 * Race safety: if a file vanishes between `existsSync` and `readFileSync`
 * we swallow the error and continue. The hierarchy is best-effort context,
 * not a hard requirement.
 *
 * Size accounting: when the joined size fits in `LOCALCODE_INLINE_LIMIT`
 * we return `inline`. Otherwise we drop the body entirely and return
 * `pointers` so the system-prompt renderer can emit a "lazy-load via
 * read_file" hint. Mixed mode is intentionally avoided — keeping the
 * decision binary makes the system prompt byte-stable across runs.
 */
export function loadHierarchy(projectRoot: string): LocalcodeMdHierarchyResult {
  const absRoot = path.resolve(projectRoot);
  const homeDir = path.resolve(os.homedir());

  // Collect from project root up. Order at collection time = innermost first.
  const collected: HierarchyFile[] = [];
  const seen = new Set<string>();

  let current = absRoot;
  // Cap the walk at a generous ceiling to defend against pathological
  // filesystems (network mounts, broken realpath, etc.). Real projects
  // never have nesting close to this.
  let depth = 0;
  const MAX_DEPTH = 64;
  while (depth < MAX_DEPTH) {
    depth += 1;
    if (seen.has(current)) break; // already visited (shouldn't happen lexically)
    seen.add(current);

    tryCollectAt(current, collected);

    // Stop at $HOME — do not climb above the user's home directory.
    if (current === homeDir) break;
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }

  // Global ~/.localcode/LOCALCODE.md is the deepest "parent" — append last
  // (since we collected innermost-first, it ends up at the end of the
  // collected array, and we reverse below so it lands first in output).
  // Skip if the project root is itself $HOME — we already grabbed it.
  if (absRoot !== homeDir && !seen.has(homeDir)) {
    tryCollectAt(homeDir, collected);
  }

  if (collected.length === 0) {
    return { size: 0 };
  }

  // Reverse so outermost (global / closest-to-/) comes first.
  collected.reverse();

  // Compute joined size to decide inline vs pointer.
  const SEPARATOR_TEMPLATE = '\n\n---\n\n# \n\n';
  let estimatedSize = 0;
  for (const file of collected) {
    estimatedSize += file.label.length + SEPARATOR_TEMPLATE.length + file.content.length;
  }

  // Pointer fallback when joined body would blow the inline budget.
  // The renderer is responsible for keeping the pointer list cheap and
  // byte-stable across turns.
  if (estimatedSize > LOCALCODE_INLINE_LIMIT) {
    return {
      pointers: collected.map((f) => f.absPath),
      size: estimatedSize,
    };
  }

  const parts: string[] = [];
  for (const file of collected) {
    parts.push(`\n\n---\n\n# ${file.label}\n\n${file.content.trim()}`);
  }
  // Trim the leading separator the loop unconditionally added.
  const joined = parts.join('').replace(/^\n\n---\n\n/, '');
  return { inline: joined, size: joined.length };
}

/**
 * Read `.localcode/LOCALCODE.md` at `dir` (no recursion) and push a
 * `HierarchyFile` entry into `acc` when present. Silent on every failure
 * mode (missing dir, symlinked file, transient I/O error) — see
 * `loadHierarchy` race-safety notes.
 */
function tryCollectAt(dir: string, acc: HierarchyFile[]): void {
  const mdPath = path.join(dir, LOCALCODE_DIR, LOCALCODE_MD_FILE);
  // Guard with lstat to skip symlinked files (preventing reads outside the
  // intended walk via crafted links).
  let stat;
  try {
    stat = lstatSync(mdPath);
  } catch {
    return; // missing or unreadable
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isFile()) return;

  let content: string;
  try {
    content = readFileSync(mdPath, 'utf-8');
  } catch {
    return; // race: file vanished between lstat and read
  }
  if (content.trim().length === 0) return; // empty file — ignore

  const label = labelFor(dir, mdPath);
  acc.push({ absPath: mdPath, label, content });
}

/**
 * Display label for a hierarchy entry — used as the "# <label>" header in
 * the inlined output. We prefer a tilde-prefixed path for files inside
 * `$HOME` (compact + recognisable) and an absolute path otherwise.
 */
function labelFor(dir: string, absPath: string): string {
  const home = os.homedir();
  if (absPath.startsWith(home + path.sep) || absPath === home) {
    return '~' + absPath.slice(home.length);
  }
  // Use the dir-relative form for non-home paths — keeps headers short
  // while still uniquely identifying the source.
  void dir;
  return absPath;
}

// ---------------------------------------------------------------------------
// First-launch scaffold
// ---------------------------------------------------------------------------

/**
 * Result of `ensureLocalcodeScaffold`. The caller (boot path) uses this to
 * decide whether to show a one-shot "we just set up `.localcode/` for you"
 * banner.
 */
export interface ScaffoldResult {
  /** `true` if anything was newly created on disk; `false` for the no-op
   *  fast path. */
  created: boolean;
  /** Absolute, resolved project root. */
  projectRoot: string;
  /** Absolute paths to the canonical scaffold artefacts (whether they
   *  existed before this call or not). */
  paths: {
    dir: string;
    skillsDir: string;
    localcodeMd: string;
    settingsJson: string;
  };
  /** Project-relative names of files / dirs that this call actually created
   *  (purely for the banner UX — modifying `.gitignore` is not listed). */
  newlyCreatedFiles: string[];
}

/**
 * Ensure the `.localcode/` skeleton exists at `projectRoot`. Idempotent and
 * cheap on the fast path: subsequent calls only stat a handful of paths.
 *
 * Creates (only when missing):
 *   - `<projectRoot>/.localcode/`
 *   - `<projectRoot>/.localcode/skills/`
 *   - `<projectRoot>/.localcode/LOCALCODE.md` — minimal stub pointing the
 *     user at `/init`. Never overwritten if the file already exists, even
 *     if it is empty.
 *
 * Side-effect on `.gitignore` (only if the file already exists at the
 * project root): appends `.localcode/` if neither `.localcode/` nor
 * `.localcode` is already listed (uncommented, non-negated). The
 * `.gitignore` itself is *not* auto-created in non-git projects — that
 * would be too presumptuous.
 *
 * Notably *not* created: `.localcode/settings.json`. Its absence is the
 * default state; it is materialised on first call to the project-settings
 * writer. Pre-creating it would silently flip the project into the
 * "settings present" branch of generation merging.
 *
 * Throws:
 *   - If `projectRoot` does not exist or is not a directory.
 *   - If a filesystem operation fails for reasons other than "already
 *     exists" (e.g. EACCES on a read-only root).
 */
export function ensureLocalcodeScaffold(projectRoot: string): ScaffoldResult {
  const absRoot = path.resolve(projectRoot);

  // Validate the root up-front so callers get a single, clear error rather
  // than an opaque ENOENT/ENOTDIR from mkdir/appendFile later on.
  let rootStat;
  try {
    rootStat = statSync(absRoot);
  } catch {
    throw new Error(
      `Cannot scaffold .localcode/: project root does not exist: ${absRoot}`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new Error(
      `Cannot scaffold .localcode/: project root is not a directory: ${absRoot}`,
    );
  }

  const dir = path.join(absRoot, LOCALCODE_DIR);
  const skillsDir = path.join(dir, SKILLS_DIR);
  const localcodeMd = path.join(dir, LOCALCODE_MD_FILE);
  const settingsJson = path.join(dir, SETTINGS_JSON_FILE);

  const newlyCreatedFiles: string[] = [];

  try {
    // .localcode/
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      newlyCreatedFiles.push(`${LOCALCODE_DIR}/`);
    }

    // .localcode/skills/
    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
      newlyCreatedFiles.push(`${LOCALCODE_DIR}/${SKILLS_DIR}/`);
    }

    // .localcode/LOCALCODE.md — never overwrite an existing file, even
    // if it is empty. The stub is just a hint toward `/init`.
    if (!existsSync(localcodeMd)) {
      writeFileSync(localcodeMd, STUB_LOCALCODE_MD, 'utf-8');
      newlyCreatedFiles.push(`${LOCALCODE_DIR}/${LOCALCODE_MD_FILE}`);
    }

    // .gitignore — append-only, idempotent. Skip silently if the project
    // has no .gitignore (don't auto-create one in non-git projects).
    appendGitignoreEntryIfPresent(absRoot);
  } catch (err) {
    if (isPermissionError(err)) {
      throw new Error(
        `Cannot scaffold .localcode/ in ${absRoot}: permission denied. ` +
          `Check that the project root is writable.`,
      );
    }
    throw err;
  }

  return {
    created: newlyCreatedFiles.length > 0,
    projectRoot: absRoot,
    paths: { dir, skillsDir, localcodeMd, settingsJson },
    newlyCreatedFiles,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseTrailingNewline(content: string): string {
  if (content.length === 0) return '\n';
  return content.endsWith('\n') ? content : `${content}\n`;
}

function ensureGitignoreEntry(absRoot: string): void {
  const gitignorePath = path.join(absRoot, GITIGNORE_FILE);

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${GITIGNORE_ENTRY}\n`, 'utf-8');
    return;
  }

  let existing: string;
  try {
    existing = readFileSync(gitignorePath, 'utf-8');
  } catch {
    // If we can't read it, don't try to append — rethrow so the caller knows.
    throw new Error(`Failed to read ${gitignorePath}`);
  }

  if (hasGitignoreEntry(existing)) return;

  const prefix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
  appendFileSync(gitignorePath, `${prefix}${GITIGNORE_ENTRY}\n`, 'utf-8');
}

function hasGitignoreEntry(contents: string): boolean {
  const target = GITIGNORE_ENTRY;
  const targetNoSlash = target.replace(/\/+$/, '');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('!')) continue;
    const stripped = line.replace(/\/+$/, '');
    if (stripped === targetNoSlash) return true;
  }
  return false;
}

/**
 * Append `.localcode/` to an existing `.gitignore` (idempotent). Unlike
 * `ensureGitignoreEntry` (used by the `/init` write path), this variant
 * deliberately does *not* create the file if it is missing — scaffolding
 * a `.gitignore` in a non-git project is too presumptuous.
 */
function appendGitignoreEntryIfPresent(absRoot: string): void {
  const gitignorePath = path.join(absRoot, GITIGNORE_FILE);
  if (!existsSync(gitignorePath)) return;

  const content = readFileSync(gitignorePath, 'utf-8');
  if (hasGitignoreEntry(content)) return;

  const prefix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
  appendFileSync(gitignorePath, `${prefix}${GITIGNORE_ENTRY}\n`, 'utf-8');
}

function isPermissionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}
