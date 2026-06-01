/**
 * ConfigManager — read / write / update the TOML-backed app config.
 *
 * File lives at `~/.localcode/config.toml` by default; the constructor
 * accepts an override path for tests.
 *
 * - `read()` : parse TOML -> validate with Zod -> typed `Config`.
 * - `write(cfg)` : validate -> serialize to TOML -> atomic rename write.
 * - `update(partial)` : deep-merge patch into existing config, then validate+write.
 *
 * All failures throw a custom error class with a human-friendly message
 * (never a raw Zod dump). Callers only need `instanceof ConfigReadError`
 * / `ConfigValidationError` / `ConfigWriteError` to branch on the
 * failure mode.
 *
 * ## Unknown-section preservation
 *
 * `update(partial)` is the user-facing mutation entry point. It must
 * NEVER drop top-level sections the user (or a future version of the
 * app) added to the on-disk TOML — silently losing `[my-custom]` or a
 * future `[experimental]` block would be a data-corruption bug.
 *
 * Implementation: every `update` call re-reads the raw TOML once
 * (independent of Zod validation), then merges the patch into the raw
 * object, validates the merged-then-typed projection against
 * `ConfigSchema`, and writes the raw merged object (with unknown
 * sections preserved verbatim) back to disk. Atomicity guarantees
 * (tmp + rename) are unchanged.
 *
 * On parse-failure (corrupt TOML on disk), `update` refuses to write,
 * preserves the original file, and surfaces a `ConfigReadError`. The
 * user must repair the file by hand — silently overwriting a corrupt
 * config could destroy the only good copy of an `apiKey` /
 * `[agents]` block the user typed in by hand.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z, type ZodError } from 'zod';
import { ConfigSchema, type Config, type DeepPartial } from './types';
import { getDefaultConfig } from './defaults';
import type { GenerationConfig, Backend } from '@/types/global';
// PROJECT-RC-SECTION — `.localcoderc.toml` loader, walks the dir tree
// upward and deep-merges allowed overrides on top of the global config.
import { loadProjectRc, deepMergePartial } from './project-rc';
// PROJECT-RC-SECTION-END

// ---------- Errors ----------

export class ConfigReadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ConfigReadError';
  }
}

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: ZodError['issues'],
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export class ConfigWriteError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ConfigWriteError';
  }
}

// ---------- Helpers ----------

/**
 * Human-readable summary of a Zod error — e.g.
 *   "backend.type: invalid_enum_value, onboarding.completed: required"
 */
function describeIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const p = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${p}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Deep-merge `patch` into `base`. Plain objects recurse; arrays + scalars
 * from `patch` replace those in `base`. Avoids pulling in lodash.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  // Only treat literal/plain object-shaped values as mergeable.
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || proto === Object.prototype;
}

export function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  // Primitive / array / null `patch` → replace entirely.
  if (!isPlainObject(patch) || !isPlainObject(base)) {
    // We keep the original base if patch is `undefined` but that's
    // already filtered out at the record-level below.
    return (patch as unknown as T) ?? base;
  }

  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const patchVal = (patch as Record<string, unknown>)[key];
    if (patchVal === undefined) continue;

    const baseVal = out[key];
    if (isPlainObject(baseVal) && isPlainObject(patchVal)) {
      // Recurse; the cast is safe because we've narrowed both sides.
      out[key] = deepMerge(
        baseVal as unknown as Record<string, unknown>,
        patchVal as DeepPartial<Record<string, unknown>>,
      );
    } else {
      out[key] = patchVal;
    }
  }
  return out as T;
}

/**
 * Merge a typed `partial` patch into a raw TOML object so unknown
 * top-level sections are preserved verbatim.
 *
 * Differs from `deepMerge` in two ways:
 *   1. Unknown top-level keys present only in `raw` (e.g. `[my-custom]`)
 *      are passed through untouched — they aren't part of the patch's
 *      type, but we keep them on disk anyway.
 *   2. Recurses one level into known sections so partial updates of
 *      `[backend]` / `[model]` / etc. don't overwrite sibling fields.
 */
function deepMergeRawForUpdate(
  raw: Record<string, unknown>,
  patch: DeepPartial<Config>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (!isPlainObject(patch)) return out;
  for (const key of Object.keys(patch)) {
    const patchVal = (patch as Record<string, unknown>)[key];
    if (patchVal === undefined) continue;
    const rawVal = out[key];
    if (isPlainObject(rawVal) && isPlainObject(patchVal)) {
      out[key] = deepMerge(
        rawVal as Record<string, unknown>,
        patchVal as DeepPartial<Record<string, unknown>>,
      );
    } else {
      out[key] = patchVal as unknown;
    }
  }
  return out;
}

// ---------- ConfigManager ----------

export class ConfigManager {
  private readonly filePath: string;

  constructor(overridePath?: string) {
    this.filePath =
      overridePath !== undefined
        ? overridePath
        : path.join(homedir(), '.localcode', 'config.toml');
  }

  /** Absolute filesystem path of the underlying config file. */
  get path(): string {
    return this.filePath;
  }

  /** Whether the config file currently exists on disk. */
  exists(): boolean {
    try {
      return existsSync(this.filePath);
    } catch {
      return false;
    }
  }

  /**
   * Read + validate the config file.
   *
   * Throws `ConfigReadError` if the file is missing or unreadable,
   * or `ConfigValidationError` if TOML parses but fails Zod validation.
   *
   * IMPORTANT: this method NEVER silently falls back to defaults on
   * parse / validation failure — that would risk overwriting the
   * user's hand-edited config the next time anything calls `write` /
   * `update`. Callers that want a default fallback (e.g. the
   * onboarding flow) must explicitly catch and recover.
   */
  read(): Config {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new ConfigReadError(
        `Failed to read config at ${this.filePath}: ${msg}`,
        cause,
      );
    }

    let parsed: unknown;
    try {
      parsed = parseToml(raw);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new ConfigReadError(
        `Failed to parse TOML at ${this.filePath}: ${msg}`,
        cause,
      );
    }

    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigValidationError(
        `Invalid config at ${this.filePath}: ${describeIssues(result.error)}`,
        result.error.issues,
        result.error,
      );
    }
    return result.data;
  }

  /**
   * Read the config, AUTO-CREATING a default file when it is MISSING.
   *
   * This is the self-healing entry point for startup paths that must
   * have *some* config to proceed (e.g. the app's bootstrap effect on a
   * fresh machine where `~/.localcode/config.toml` does not exist yet).
   * The written default has `onboarding.completed = false` and no
   * `locale`, so the caller still routes the user through the language
   * picker + onboarding — auto-creation prevents the hard "cannot read
   * config.toml" crash without skipping first-run setup.
   *
   * IMPORTANT: this ONLY creates on a genuinely absent file. A file
   * that EXISTS but is corrupt / invalid still throws (via `read()`),
   * preserving the invariant that we never silently clobber a user's
   * hand-edited-but-broken config — repairing that is onboarding's /
   * `update()`'s job, which the caller can fall back to explicitly.
   *
   * If the default cannot be persisted (e.g. a read-only HOME), the
   * in-memory defaults are still returned so the app can boot; the next
   * `write` / `update` will surface the write failure to the user.
   */
  readOrCreate(defaultBackend: Backend = 'ollama'): Config {
    if (this.exists()) {
      // File present → read normally. Corrupt/invalid files throw here
      // (never auto-overwritten); only a missing file is auto-created.
      return this.read();
    }
    const defaults = getDefaultConfig(defaultBackend);
    try {
      this.write(defaults);
    } catch {
      // Best-effort persist — return in-memory defaults regardless so a
      // read-only HOME doesn't block startup.
    }
    return defaults;
  }

  /**
   * Read the raw TOML object (no Zod stripping). Used by `update()` to
   * preserve unknown top-level sections that the schema doesn't
   * recognise (e.g. user-added `[my-custom]` blocks or future
   * `[experimental]` features).
   *
   * Throws `ConfigReadError` for missing / unreadable / unparseable
   * files. Returns a plain object reference; callers may mutate it
   * before re-serialising.
   */
  private readRaw(): Record<string, unknown> {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new ConfigReadError(
        `Failed to read config at ${this.filePath}: ${msg}`,
        cause,
      );
    }
    let parsed: unknown;
    try {
      parsed = parseToml(raw);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new ConfigReadError(
        `Failed to parse TOML at ${this.filePath}: ${msg}`,
        cause,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new ConfigReadError(
        `Config at ${this.filePath} is not a TOML table`,
      );
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * Validate + atomically write the full config to disk.
   *
   * Creates the parent directory if missing. Writes to a sibling
   * `.tmp` file first, then renames over the real path to minimize the
   * window for partial writes.
   */
  write(config: Config): void {
    // Validate first — never persist a bad config.
    const validation = ConfigSchema.safeParse(config);
    if (!validation.success) {
      throw new ConfigValidationError(
        `Refusing to write invalid config: ${describeIssues(validation.error)}`,
        validation.error.issues,
        validation.error,
      );
    }

    // Best-effort: when an existing file is parseable, preserve any
    // unknown top-level keys (e.g. `[my-custom]` blocks the user added
    // by hand, or sections introduced by a newer build) by overlaying
    // the validated data onto the raw object. If the existing file
    // is missing / corrupt we still write — `write` is the
    // first-write / full-overwrite entry point and historically had
    // no preservation behaviour.
    let payload: Record<string, unknown> = validation.data as unknown as Record<
      string,
      unknown
    >;
    if (this.exists()) {
      try {
        const rawCurrent = this.readRaw();
        const merged: Record<string, unknown> = { ...rawCurrent };
        for (const [key, value] of Object.entries(payload)) {
          merged[key] = value;
        }
        payload = merged;
      } catch {
        // Corrupt / unreadable existing file — fall back to writing
        // the validated-only payload. Unknown sections in the broken
        // file are unrecoverable, but we don't refuse the write here:
        // doing so would block onboarding from ever rescuing a bad
        // file. `update()` is the path that DOES refuse on parse
        // failure.
      }
    }

    let serialized: string;
    try {
      // smol-toml requires a plain object (TomlPrimitive tree).
      serialized = stringifyToml(payload);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new ConfigWriteError(
        `Failed to serialize config to TOML: ${msg}`,
        cause,
      );
    }

    const parent = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.tmp`;

    try {
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new ConfigWriteError(
        `Failed to create config directory ${parent}: ${msg}`,
        cause,
      );
    }

    try {
      writeFileSync(tmpPath, serialized, 'utf8');
      renameSync(tmpPath, this.filePath);
    } catch (cause) {
      // Best-effort cleanup of the orphaned temp file.
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // swallow — reporting the original error is more useful.
      }
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new ConfigWriteError(
        `Failed to write config to ${this.filePath}: ${msg}`,
        cause,
      );
    }

    // Security H2 — restrict permissions to user-rw only so a config
    // containing `apiKey` isn't world-readable. POSIX-only; chmod on
    // Windows is a best-effort no-op and we swallow any platform error.
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // ignore — best-effort
    }
  }

  /**
   * Read, deep-merge `partial`, validate, write, and return the merged
   * result. The partial is validated loosely (as a deep-partial) before
   * merge, and the merged result is validated strictly before write.
   *
   * Preserves UNKNOWN top-level sections (e.g. `[my-custom]`,
   * `[experimental]`) that aren't in `ConfigSchema` so user-added or
   * future-version data survives every round-trip. Done by parsing the
   * existing TOML twice — once typed (Zod) for known-field merging,
   * once raw (object form) so unknown keys can be re-emitted verbatim.
   *
   * On a parse / read failure we abort BEFORE writing — silently
   * overwriting a corrupt config could destroy the only good copy of
   * an `apiKey` / `[agents]` block the user typed in by hand. The
   * caller (UI / CLI) surfaces the resulting `ConfigReadError` to the
   * user so they can repair the file.
   */
  update(partial: DeepPartial<Config>): Config {
    // Reject obviously wrong shapes at the edges — this is cheap and
    // gives friendlier errors than waiting for the final validation.
    // We accept `{}` and any recursive subset; no `.strict()` here.
    const patchSchema = z.record(z.string(), z.unknown()).optional();
    const patchCheck = patchSchema.safeParse(partial);
    if (!patchCheck.success) {
      throw new ConfigValidationError(
        `Invalid patch object: ${describeIssues(patchCheck.error)}`,
        patchCheck.error.issues,
        patchCheck.error,
      );
    }

    // First-time setup path — file doesn't exist yet. Build a typed
    // config from the patch alone and write it; nothing to preserve.
    if (!this.exists()) {
      // Caller is expected to have supplied a sufficiently complete
      // patch (or this is the onboarding scaffold). Validation in
      // `write()` will surface any missing required fields.
      const merged = deepMerge({} as Config, partial);
      this.write(merged);
      return merged;
    }

    // Two parallel reads:
    //   - `typedCurrent` (via `read()`) gives us the Zod-validated
    //     view of the known fields, with defaults filled in.
    //   - `rawCurrent` is the verbatim TOML object including any
    //     unknown top-level keys (`[diagnostics]`, `[my-custom]`,
    //     etc.) that Zod would otherwise strip.
    // Both throw `ConfigReadError` on parse failure — we re-throw to
    // the caller WITHOUT overwriting the on-disk file, so a corrupt
    // config never silently resets.
    const typedCurrent = this.read();
    const rawCurrent = this.readRaw();
    const mergedTyped = deepMerge(typedCurrent, partial);

    // Apply the patch to the raw object (so known sections reflect
    // the user's update) while leaving every other top-level key —
    // known but unmodified, OR unknown — exactly as it was on disk.
    // We only overwrite top-level keys that the patch actually
    // touches; deepMerge handles the recursion for known-but-modified
    // sections.
    const rawMerged = deepMergeRawForUpdate(rawCurrent, partial);

    // Validate the typed projection of the merged config — every
    // known field still satisfies the schema. We do NOT validate the
    // raw object directly because Zod's `strip` mode would drop the
    // unknown sections we're trying to preserve.
    const validation = ConfigSchema.safeParse(mergedTyped);
    if (!validation.success) {
      throw new ConfigValidationError(
        `Refusing to write invalid config: ${describeIssues(validation.error)}`,
        validation.error.issues,
        validation.error,
      );
    }

    // Serialise the raw object — keeps unknown sections intact.
    this.writeRaw(rawMerged);
    return mergedTyped;
  }

  /**
   * Atomically write a raw TOML object (preserves unknown top-level
   * keys). Internal — `update()` is the user-facing entry point.
   *
   * Splits validation from serialisation so unknown sections survive:
   * the caller has already validated the typed projection separately.
   */
  private writeRaw(rawConfig: Record<string, unknown>): void {
    let serialized: string;
    try {
      serialized = stringifyToml(rawConfig);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new ConfigWriteError(
        `Failed to serialize config to TOML: ${msg}`,
        cause,
      );
    }

    const parent = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.tmp`;

    try {
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new ConfigWriteError(
        `Failed to create config directory ${parent}: ${msg}`,
        cause,
      );
    }

    try {
      writeFileSync(tmpPath, serialized, 'utf8');
      renameSync(tmpPath, this.filePath);
    } catch (cause) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // swallow — reporting the original error is more useful.
      }
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new ConfigWriteError(
        `Failed to write config to ${this.filePath}: ${msg}`,
        cause,
      );
    }

    // Security H2 — mirror `write()`: lock the on-disk file to user-rw
    // only after every successful update. Best-effort on Windows.
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // ignore
    }
  }

  // PROJECT-RC-SECTION
  /**
   * Read the global config and overlay any `.localcoderc.toml` overrides
   * discovered by walking upward from `projectRoot`. Only fields on the
   * `ALLOWED_PATHS` safelist in `project-rc.ts` are honoured — broader
   * overrides are silently dropped so a project's `.localcoderc.toml`
   * cannot, for example, swap the user's backend baseUrl invisibly.
   *
   * Same error contract as `read()` — surfaces `ConfigReadError` /
   * `ConfigValidationError` from the global path. RC parse failures are
   * swallowed (logged to stderr) so a broken `.localcoderc.toml` never
   * blocks startup; the global config is used as-is in that case.
   *
   * On a clean run (no RC files found anywhere) this returns the exact
   * same Config object as `read()` would.
   */
  readForProject(projectRoot: string): Config {
    const base = this.read();
    const rc = loadProjectRc(projectRoot);
    if (Object.keys(rc).length === 0) return base;
    const merged = deepMergePartial(base as DeepPartial<Config>, rc);
    // Revalidate after merge — the safelist already constrains the
    // shape, but Zod is the canonical contract for downstream consumers.
    // On validation failure (e.g. an out-of-range enum value in the RC)
    // we fall back to the global config rather than blocking startup.
    const validation = ConfigSchema.safeParse(merged);
    if (!validation.success) {
      process.stderr.write(
        `localcode: .localcoderc.toml ignored — merged config failed validation: ${describeIssues(validation.error)}\n`,
      );
      return base;
    }
    return validation.data;
  }
  // PROJECT-RC-SECTION-END

  // ---------- Per-project settings.json (FIX #35) ----------

  /**
   * Read `<projectRoot>/.localcode/settings.json` and return any
   * `generation` overrides as a partial `GenerationConfig` (camelCase).
   *
   * On disk the keys are snake_case (`top_p`, `repeat_penalty`,
   * `max_tokens`) per the user-facing spec; this method maps them to
   * camelCase and drops anything that isn't a finite number.
   *
   * Tolerant by design: if the file doesn't exist, isn't valid JSON,
   * isn't an object, or lacks a `generation` block, returns `null` —
   * never throws. The caller falls back to global config.
   */
  readProjectSettings(projectRoot: string): Partial<GenerationConfig> | null {
    const p = path.join(projectRoot, '.localcode', 'settings.json');
    if (!existsSync(p)) return null;
    try {
      const raw = readFileSync(p, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const gen = (parsed as { generation?: unknown }).generation;
      if (!gen || typeof gen !== 'object') return null;
      const g = gen as Record<string, unknown>;
      const out: Partial<GenerationConfig> = {};
      if (typeof g.temperature === 'number') out.temperature = g.temperature;
      if (typeof g.top_p === 'number') out.topP = g.top_p;
      if (typeof g.repeat_penalty === 'number') out.repeatPenalty = g.repeat_penalty;
      if (typeof g.max_tokens === 'number') out.maxTokens = g.max_tokens;
      return out;
    } catch {
      // Malformed JSON / unreadable file → fall back to global silently.
      return null;
    }
  }

  /**
   * Write `<projectRoot>/.localcode/settings.json`, merging the given
   * partial generation config into any existing `generation` block.
   *
   * - Creates `<projectRoot>/.localcode/` if missing (recursive mkdir).
   * - Preserves unknown top-level keys (forward-compat for future
   *   per-project settings such as `model_overrides`).
   * - Preserves any existing `generation` keys not present in the
   *   patch (so a write of `{ repeatPenalty: 1.2 }` does NOT clobber
   *   a previously-set `temperature`).
   * - Atomic on-disk update: writes a sibling `.tmp` file first, then
   *   `rename(2)`s over the real path.
   */
  writeProjectSettings(projectRoot: string, settings: Partial<GenerationConfig>): void {
    const dir = path.join(projectRoot, '.localcode');
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'settings.json');

    // Read existing top-level object (if any) so unrelated keys are
    // preserved verbatim.
    let existing: Record<string, unknown> = {};
    if (existsSync(p)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed existing file — overwrite cleanly.
        existing = {};
      }
    }

    const existingGenRaw = existing.generation;
    const existingGen: Record<string, unknown> =
      existingGenRaw && typeof existingGenRaw === 'object' && !Array.isArray(existingGenRaw)
        ? (existingGenRaw as Record<string, unknown>)
        : {};

    const merged: Record<string, unknown> = { ...existingGen };
    if (settings.temperature !== undefined) merged.temperature = settings.temperature;
    if (settings.topP !== undefined) merged.top_p = settings.topP;
    if (settings.repeatPenalty !== undefined) merged.repeat_penalty = settings.repeatPenalty;
    if (settings.maxTokens !== undefined) merged.max_tokens = settings.maxTokens;

    const out: Record<string, unknown> = { ...existing, generation: merged };
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
    renameSync(tmp, p);
  }

  /**
   * Resolve the effective generation config for a project — the
   * project-level overrides (if any) layered on top of the global
   * `[generation]` section.
   *
   * Returns the merged config plus a `source` tag:
   *   - `'global'`  → no project file (or no `generation` block).
   *   - `'project'` → every field is overridden at the project level.
   *   - `'mixed'`   → some fields project-local, some fall through to global.
   *
   * The merge is field-by-field: undefined fields in the project layer
   * leave the global value intact.
   */
  resolveGeneration(projectRoot: string): {
    generation: GenerationConfig;
    source: 'project' | 'global' | 'mixed';
  } {
    const global = this.read().generation;
    const project = this.readProjectSettings(projectRoot);
    if (!project) return { generation: global, source: 'global' };

    const merged: GenerationConfig = {
      temperature: project.temperature ?? global.temperature,
      topP: project.topP ?? global.topP,
      repeatPenalty: project.repeatPenalty ?? global.repeatPenalty,
      maxTokens: project.maxTokens ?? global.maxTokens,
    };

    const fullOverride =
      project.temperature !== undefined &&
      project.topP !== undefined &&
      project.repeatPenalty !== undefined &&
      project.maxTokens !== undefined;

    return { generation: merged, source: fullOverride ? 'project' : 'mixed' };
  }
}
