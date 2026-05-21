/**
 * SkillsManager — CRUD + active-state tracking for user skills.
 *
 * Skills live as markdown files under TWO locations:
 *   1. Project-local: `<projectRoot>/.localcode/skills/*.md` (highest priority).
 *   2. Global:        `~/.localcode/skills/*.md`              (fallback).
 *
 * When a skill ID exists in both places, project-local wins — it shadows
 * the global copy. Each returned `Skill` carries a `source` tag
 * (`'project' | 'global'`) so the UI can indicate where the skill lives.
 *
 * Active state is persisted in `skills-active.json`:
 *   - Preferred: `<projectRoot>/.localcode/skills-active.json`
 *   - Fallback:  `~/.localcode/skills-active.json` (when no project root).
 *
 * We deliberately DO NOT put this in the TOML config (via ConfigManager)
 * to avoid schema churn across agents; skills come and go, config schema
 * stays stable.
 *
 * Backwards compatibility:
 *   - The legacy constructor signature `new SkillsManager(dir, configManager)`
 *     still works: when a string is passed as the first argument we treat it
 *     as the ONLY skills directory (sole source, no project/global split).
 *     This keeps the existing tests and app.tsx wiring green until Agent 8
 *     migrates them.
 *
 * All filesystem access goes through `fs/promises` and is wrapped in
 * try/catch; failures surface as `SkillsError`.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  copyFile as fsCopyFile,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  rename as fsRename,
  stat as fsStat,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import type { Skill, SkillSource } from '@/types/global';
import type { ConfigManager } from '@/config/config-manager';
import { parseSkillFile, SkillParseError } from '@/skills/skill-parser';

// ---------- Errors ----------

export class SkillsError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SkillsError';
  }
}

// ---------- Constants ----------

const SKILL_EXTENSION = '.md';
const JOINER = '\n\n---\n\n';

// ---------- Helpers ----------

function globalSkillsDir(): string {
  return path.join(homedir(), '.localcode', 'skills');
}

function globalActiveFile(): string {
  return path.join(homedir(), '.localcode', 'skills-active.json');
}

function projectSkillsDir(projectRoot: string): string {
  return path.join(projectRoot, '.localcode', 'skills');
}

function projectActiveFile(projectRoot: string): string {
  return path.join(projectRoot, '.localcode', 'skills-active.json');
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsStat(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fsMkdir(dir, { recursive: true });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new SkillsError(`Failed to create skills dir ${dir}: ${msg}`, cause);
  }
}

function toMdFilename(filename: string): string {
  const trimmed = filename.trim();
  if (trimmed.length === 0) {
    throw new SkillsError('Skill filename cannot be empty');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new SkillsError(
      `Skill filename must not contain path separators: ${trimmed}`,
    );
  }
  return trimmed.toLowerCase().endsWith(SKILL_EXTENSION)
    ? trimmed
    : `${trimmed}${SKILL_EXTENSION}`;
}

function idFromFilename(filename: string): string {
  return filename.toLowerCase().endsWith(SKILL_EXTENSION)
    ? filename.slice(0, -SKILL_EXTENSION.length)
    : filename;
}

// ---------- Constructor options ----------

/**
 * Options bag for the new two-source constructor. Prefer this over the
 * legacy positional form.
 *
 * Either `projectRoot` or `globalDir` must be provided (both allowed).
 * If neither is provided, we default to the global-only layout under
 * `~/.localcode/skills/` for backward compatibility.
 */
export interface SkillsManagerOptions {
  /** Project root used to resolve `.localcode/skills/`. */
  projectRoot?: string;
  /** Override for the global skills directory. Defaults to `~/.localcode/skills/`. */
  globalDir?: string;
  /** Optional override for the active-state JSON file. */
  activeFile?: string;
  /** Config manager — accepted for future use; not read today. */
  configManager?: ConfigManager;
}

/** Scope hint for add/addFromText — where to write the new skill. */
export type SkillScope = 'project' | 'global';

// ---------- SkillsManager ----------

export class SkillsManager {
  private readonly projectDir: string | null;
  private readonly globalDir: string;
  private readonly activeFile: string;
  /**
   * `configManager` is accepted for future extensibility; not used today
   * because active skills live in a sidecar JSON file. Kept on the type to
   * avoid churn when Agent 8 wires things together.
   */
  private readonly configManager: ConfigManager | undefined;
  private activeSet: Set<string> | null = null;
  private initialized = false;

  /**
   * Two constructor shapes for maximum compatibility:
   *   - `new SkillsManager({ projectRoot, globalDir?, configManager? })`
   *     → real two-source behaviour.
   *   - `new SkillsManager(dir, configManager?)`  (legacy positional)
   *     → sole-source (treated as the global dir; no project split).
   *     Existing tests + app.tsx keep working unchanged.
   *   - `new SkillsManager()` → global-only defaults.
   */
  constructor(
    optsOrDir?: SkillsManagerOptions | string,
    legacyConfigManager?: ConfigManager,
  ) {
    if (typeof optsOrDir === 'string') {
      // Legacy path. Sole source, no project split.
      this.projectDir = null;
      this.globalDir = optsOrDir;
      // Active file lives next to the skills dir, not at the canonical
      // ~/.localcode location, so tests that use a tmp dir stay isolated.
      this.activeFile = path.join(
        path.dirname(optsOrDir),
        'skills-active.json',
      );
      this.configManager = legacyConfigManager;
      return;
    }

    const opts: SkillsManagerOptions = optsOrDir ?? {};
    this.projectDir =
      typeof opts.projectRoot === 'string' && opts.projectRoot.length > 0
        ? projectSkillsDir(opts.projectRoot)
        : null;
    this.globalDir = opts.globalDir ?? globalSkillsDir();

    // Active-state file. Prefer per-project when a project root is
    // supplied; fall back to the global location. Callers that need an
    // explicit override can pass `activeFile`.
    if (typeof opts.activeFile === 'string' && opts.activeFile.length > 0) {
      this.activeFile = opts.activeFile;
    } else if (
      typeof opts.projectRoot === 'string' &&
      opts.projectRoot.length > 0
    ) {
      this.activeFile = projectActiveFile(opts.projectRoot);
    } else {
      this.activeFile = globalActiveFile();
    }

    this.configManager = opts.configManager;
  }

  /**
   * Absolute path to the *writable* default directory. For the two-source
   * layout this is the project-local dir (if configured) — which matches
   * the /new-skill overlay's default write target. Falls back to the
   * global dir otherwise. Back-compat: legacy sole-source mode returns
   * the only directory.
   */
  get directory(): string {
    return this.projectDir ?? this.globalDir;
  }

  /** Absolute path to the project-local skills dir (if configured). */
  get projectDirectory(): string | null {
    return this.projectDir;
  }

  /** Absolute path to the global skills dir. */
  get globalDirectory(): string {
    return this.globalDir;
  }

  /** Absolute path to the sidecar JSON that tracks active skill IDs. */
  get activeStatePath(): string {
    return this.activeFile;
  }

  /**
   * Ensure the writable skills directory exists and the in-memory active
   * set is loaded. Safe to call multiple times; only runs work the first
   * time.
   *
   * NB we only pre-create the *writable* default dir (project-local when
   * configured, else the global dir). The opposite dir is read-only from
   * this manager's perspective and is touched only if it already exists.
   */
  private async init(): Promise<void> {
    if (this.initialized) return;
    await ensureDir(this.directory);
    this.activeSet = await this.loadActiveSet();
    this.initialized = true;
  }

  private async loadActiveSet(): Promise<Set<string>> {
    try {
      if (!(await pathExists(this.activeFile))) {
        return new Set();
      }
      const raw = await fsReadFile(this.activeFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      const ids: string[] = [];
      for (const entry of parsed) {
        if (typeof entry === 'string' && entry.length > 0) {
          ids.push(entry);
        }
      }
      return new Set(ids);
    } catch {
      // Corrupt / unreadable — start fresh rather than crash.
      return new Set();
    }
  }

  private async persistActiveSet(set: Set<string>): Promise<void> {
    const parent = path.dirname(this.activeFile);
    await ensureDir(parent);

    const payload = JSON.stringify([...set].sort(), null, 2);
    const tmp = `${this.activeFile}.tmp`;
    try {
      await fsWriteFile(tmp, payload, 'utf8');
      await fsRename(tmp, this.activeFile);
    } catch (cause) {
      // Best-effort cleanup of orphan temp file.
      try {
        if (await pathExists(tmp)) await fsUnlink(tmp);
      } catch {
        // swallow
      }
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SkillsError(
        `Failed to persist active skills state to ${this.activeFile}: ${msg}`,
        cause,
      );
    }
  }

  /**
   * Read every `*.md` file in `dir` and return skills tagged with
   * `source`. Returns an empty array (not an error) when `dir` is missing.
   */
  private async readDir(
    dir: string,
    source: SkillSource,
  ): Promise<Skill[]> {
    if (!(await pathExists(dir))) return [];
    let entries: string[];
    try {
      entries = await fsReaddir(dir);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SkillsError(
        `Failed to read skills dir ${dir}: ${msg}`,
        cause,
      );
    }

    const mdFiles = entries.filter((e) =>
      e.toLowerCase().endsWith(SKILL_EXTENSION),
    );
    const skills: Skill[] = [];
    for (const file of mdFiles) {
      const abs = path.join(dir, file);
      try {
        const skill = await parseSkillFile(abs);
        skills.push({ ...skill, source });
      } catch (cause) {
        // Skip broken files silently; a busted skill shouldn't nuke
        // the entire list. Non-parse errors bubble up.
        if (!(cause instanceof SkillParseError)) {
          throw cause;
        }
      }
    }
    return skills;
  }

  /**
   * List every skill file in the configured sources, marking `active`
   * based on the in-memory active set and tagging each with `source`.
   *
   * Resolution rule: project-local skills shadow global skills with the
   * same id. Global entries whose ids match a project-local entry are
   * dropped from the result.
   *
   * Files that fail to parse are skipped silently — a broken skill
   * shouldn't nuke the whole list.
   */
  async list(): Promise<Skill[]> {
    await this.init();
    const active = this.activeSet ?? new Set<string>();

    // Collect project-local first (so they win on id conflict).
    const projectSkills =
      this.projectDir !== null
        ? await this.readDir(this.projectDir, 'project')
        : [];
    const globalSkills = await this.readDir(this.globalDir, 'global');

    const byId = new Map<string, Skill>();
    for (const s of projectSkills) {
      byId.set(s.id, { ...s, active: active.has(s.id) });
    }
    for (const s of globalSkills) {
      if (byId.has(s.id)) continue; // project-local wins
      byId.set(s.id, { ...s, active: active.has(s.id) });
    }

    const skills = [...byId.values()];
    // Deterministic sort by id for stable UI ordering.
    skills.sort((a, b) => a.id.localeCompare(b.id));
    return skills;
  }

  /**
   * Copy a skill file into the skills directory from some arbitrary
   * source location. Refuses to overwrite an existing skill of the same
   * filename — rename the file first if that's the intent.
   *
   * Optional `{ scope }` picks a destination directory:
   *   - `'project'` → `<projectRoot>/.localcode/skills/` (default when
   *                    a project dir is configured).
   *   - `'global'`  → `~/.localcode/skills/`.
   */
  async add(
    filePath: string,
    options: { scope?: SkillScope } = {},
  ): Promise<Skill> {
    await this.init();
    const source = path.resolve(filePath);

    if (!(await pathExists(source))) {
      throw new SkillsError(`Source file does not exist: ${source}`);
    }

    const { dir: targetDir, source: sourceTag } = this.resolveWriteTarget(
      options.scope,
    );
    await ensureDir(targetDir);

    const base = path.basename(source);
    const target = path.join(targetDir, base);
    if (await pathExists(target)) {
      throw new SkillsError(
        `Skill already exists at ${target}. Remove it first or rename the source file.`,
      );
    }

    try {
      await fsCopyFile(source, target);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SkillsError(
        `Failed to copy skill from ${source} to ${target}: ${msg}`,
        cause,
      );
    }

    const parsed = await parseSkillFile(target);
    const active = this.activeSet ?? new Set<string>();
    return { ...parsed, active: active.has(parsed.id), source: sourceTag };
  }

  /**
   * Write an inline skill definition to the skills directory. Accepts
   * filenames with or without `.md` — the extension is added if missing.
   *
   * Optional `{ scope }` picks the destination (see `add`).
   */
  async addFromText(
    filename: string,
    content: string,
    options: { scope?: SkillScope } = {},
  ): Promise<Skill> {
    await this.init();
    const safeName = toMdFilename(filename);
    const { dir: targetDir, source: sourceTag } = this.resolveWriteTarget(
      options.scope,
    );
    await ensureDir(targetDir);

    const target = path.join(targetDir, safeName);
    if (await pathExists(target)) {
      throw new SkillsError(
        `Skill already exists at ${target}. Delete it first or use a different name.`,
      );
    }

    try {
      await fsWriteFile(target, content, 'utf8');
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SkillsError(
        `Failed to write skill to ${target}: ${msg}`,
        cause,
      );
    }

    const parsed = await parseSkillFile(target);
    const active = this.activeSet ?? new Set<string>();
    return { ...parsed, active: active.has(parsed.id), source: sourceTag };
  }

  // SKILL-WRITE-SECTION
  /**
   * Upsert a skill: create or overwrite the markdown file at the
   * chosen scope. Unlike `addFromText`, this DOES overwrite an
   * existing skill — used by the wizard editor on Save.
   *
   * Writes are atomic via `tmp → rename`. Returns the parsed skill
   * with `active`/`source` populated.
   */
  async writeSkill(
    id: string,
    content: string,
    options: { scope?: SkillScope } = {},
  ): Promise<Skill> {
    await this.init();
    if (!id || id.length === 0) {
      throw new SkillsError('Skill id cannot be empty');
    }
    const safeName = toMdFilename(id);
    const { dir: targetDir, source: sourceTag } = this.resolveWriteTarget(
      options.scope,
    );
    await ensureDir(targetDir);

    const target = path.join(targetDir, safeName);
    const tmp = `${target}.tmp`;
    try {
      await fsWriteFile(tmp, content, 'utf8');
      await fsRename(tmp, target);
    } catch (cause) {
      try {
        if (await pathExists(tmp)) await fsUnlink(tmp);
      } catch {
        // swallow
      }
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SkillsError(
        `Failed to write skill to ${target}: ${msg}`,
        cause,
      );
    }

    const parsed = await parseSkillFile(target);
    const active = this.activeSet ?? new Set<string>();
    return { ...parsed, active: active.has(parsed.id), source: sourceTag };
  }
  // SKILL-WRITE-SECTION-END

  /**
   * Flip a skill's membership in the active set and persist the change.
   * Throws if the skill file doesn't exist in either source.
   */
  async toggle(id: string): Promise<void> {
    await this.init();
    if (!id || id.length === 0) {
      throw new SkillsError('Skill id cannot be empty');
    }

    // Verify the skill actually exists in at least one source.
    const file = await this.findSkillFile(id);
    if (file === null) {
      throw new SkillsError(`Skill not found: ${id}`);
    }

    const set = this.activeSet ?? new Set<string>();
    if (set.has(id)) {
      set.delete(id);
    } else {
      set.add(id);
    }
    this.activeSet = set;
    await this.persistActiveSet(set);
  }

  /**
   * Remove a skill's markdown file and drop it from the active set.
   * Deletes from the highest-priority source that has it (project-local
   * before global). Errors if the skill is missing from both sources.
   */
  async delete(id: string): Promise<void> {
    await this.init();
    if (!id || id.length === 0) {
      throw new SkillsError('Skill id cannot be empty');
    }
    const file = await this.findSkillFile(id);
    if (file === null) {
      throw new SkillsError(`Skill not found: ${id}`);
    }

    try {
      await fsUnlink(file);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new SkillsError(`Failed to delete ${file}: ${msg}`, cause);
    }

    const set = this.activeSet ?? new Set<string>();
    if (set.has(id)) {
      set.delete(id);
      this.activeSet = set;
      await this.persistActiveSet(set);
    }
  }

  /** Return only the currently-active skills. */
  async getActiveSkills(): Promise<Skill[]> {
    const all = await this.list();
    return all.filter((s) => s.active);
  }

  /**
   * Resolve which skills should be active for a SINGLE turn based on the
   * user's message. Implements the `@-mention` skill feature.
   *
   * Behavior:
   *   - If `userMessage` contains one or more `@skillname` mentions →
   *     return ONLY those skills (intersected with skills that exist).
   *     Mentions override the global "all active skills" set for the turn.
   *   - If no mentions → fall back to `getActiveSkills()` (default
   *     behavior, no change to the existing prompt).
   *   - Mentions are matched against skill `id` (filename without `.md`).
   *   - Mentions are case-insensitive: `@Frontend` matches `frontend`.
   *
   * Mention regex: `/(?:^|\s)@([a-z0-9][a-z0-9_-]*)\b/gi`
   *   - The leading `(?:^|\s)` lookbehind-equivalent prevents false
   *     positives inside email addresses (`user@example.com`) and other
   *     `@`-suffixed tokens — only `@` preceded by start-of-string or
   *     whitespace counts.
   *   - The body `[a-z0-9_-]` excludes `.`, so even if somehow the
   *     leading anchor passed, the match would stop before a TLD.
   *   - `@@frontend` is rejected: the first `@` is preceded by start
   *     and tries to match `@frontend` but the leading-`@` body char
   *     class doesn't accept `@`, and the second `@` is preceded by
   *     `@` (non-whitespace) so it never anchors.
   *
   * Resolution scope: explicit mentions are checked against the FULL
   * skill list (project + global, NOT just the currently-active set).
   * Mentioning a skill is itself an opt-in — users shouldn't have to
   * also toggle it in the manager UI.
   *
   * Returns:
   *   - `skills`           Skills to include in this turn's prompt.
   *   - `mentioned`        Lower-cased, deduped list of mention names
   *                        as parsed from the message (whether they
   *                        resolved or not).
   *   - `unknownMentions`  Mention names that did NOT match any skill;
   *                        callers can surface these as a UI warning
   *                        ("no skill named `foo`").
   */
  async getSkillsForTurn(userMessage: string): Promise<{
    skills: Skill[];
    mentioned: string[];
    unknownMentions: string[];
  }> {
    // Extract `@mention` tokens. Lower-case + dedupe in insertion order
    // so the returned arrays are stable regardless of how many times a
    // user repeats a mention.
    const re = /(?:^|\s)@([a-z0-9][a-z0-9_-]*)\b/gi;
    const mentioned: string[] = [];
    const matches = userMessage.matchAll(re);
    for (const m of matches) {
      const captured = m[1];
      if (typeof captured !== 'string' || captured.length === 0) continue;
      const name = captured.toLowerCase();
      if (!mentioned.includes(name)) mentioned.push(name);
    }

    if (mentioned.length === 0) {
      // No mentions — fall back to the default active set so existing
      // behaviour is preserved when the user isn't using the feature.
      const skills = await this.getActiveSkills();
      return { skills, mentioned: [], unknownMentions: [] };
    }

    // Resolve mentions against the FULL skill list (not just active).
    // Mentioning a skill explicitly opts it in for this turn even if
    // it's toggled off in the manager.
    const all = await this.list();
    const matched: Skill[] = [];
    const unknownMentions: string[] = [];
    for (const name of mentioned) {
      const skill = all.find((s) => s.id.toLowerCase() === name);
      if (skill !== undefined) {
        matched.push(skill);
      } else {
        unknownMentions.push(name);
      }
    }

    return { skills: matched, mentioned, unknownMentions };
  }

  /**
   * Concatenate all active skills' content joined by a clear separator.
   * Used by `ContextManager.buildSystemPrompt` to embed skills in the
   * system prompt of every request.
   */
  async buildSkillsPrompt(): Promise<string> {
    const active = await this.getActiveSkills();
    const pieces = active
      .map((s) => s.content.trim())
      .filter((c) => c.length > 0);
    return pieces.join(JOINER);
  }

  /**
   * Public alias for `buildSkillsPrompt` — concatenates the content of
   * every currently-active skill, joined by `\n\n---\n\n`. Returns an
   * empty string when no skills are active. Intended to be injected
   * directly into the system prompt of an outgoing LLM request so the
   * model picks up the skill instructions on every turn.
   *
   * Matches the contract in ROADMAP / Agent E spec:
   *   `getActiveSkillsContent(): Promise<string>`
   */
  async getActiveSkillsContent(): Promise<string> {
    return this.buildSkillsPrompt();
  }

  // ---------- Internals ----------

  /**
   * Pick a write directory for new skills. `scope` defaults to `'project'`
   * when a project dir is configured, otherwise `'global'`.
   */
  private resolveWriteTarget(scope?: SkillScope): {
    dir: string;
    source: SkillSource;
  } {
    const chosen: SkillScope =
      scope ?? (this.projectDir !== null ? 'project' : 'global');
    if (chosen === 'project') {
      if (this.projectDir === null) {
        throw new SkillsError(
          'Cannot write project-scoped skill: no project root configured. Pass projectRoot to SkillsManager or use scope: "global".',
        );
      }
      return { dir: this.projectDir, source: 'project' };
    }
    return { dir: this.globalDir, source: 'global' };
  }

  /**
   * Resolve a skill id to its absolute file path. Prefers the project-local
   * directory (if configured) and falls back to the global directory.
   * Returns `null` when neither source has a matching file.
   */
  private async findSkillFile(id: string): Promise<string | null> {
    if (this.projectDir !== null) {
      const projectFile = path.join(this.projectDir, `${id}${SKILL_EXTENSION}`);
      if (await pathExists(projectFile)) return projectFile;
    }
    const globalFile = path.join(this.globalDir, `${id}${SKILL_EXTENSION}`);
    if (await pathExists(globalFile)) return globalFile;
    return null;
  }
}

// ---------- Helpers for tests / callers that want a known-good id ----------

/**
 * Reverse mapping from filename → skill id. Exported so UI code that
 * received a raw filename (e.g. via drag/drop or path completion) can
 * get the canonical id without duplicating the logic.
 */
export function skillIdFromFilename(filename: string): string {
  return idFromFilename(path.basename(filename));
}
