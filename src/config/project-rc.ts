/**
 * Project-level `.localcoderc.toml` loader.
 *
 * Walks from `projectRoot` upward toward `/` collecting every
 * `.localcoderc.toml` along the way (innermost wins). Each file is parsed
 * as TOML; on parse failure the file is silently skipped (project-rc is
 * best-effort and must never block startup).
 *
 * Allowed override surface — a SAFELIST of fields that may be patched:
 *   - `model.current`
 *   - `backend.type`
 *   - `permissions.profile`
 *   - `outputStyle`
 *   - `context.maxTokens`
 *   - `statusline.template`
 *
 * Anything else in the file is silently ignored — we don't want a
 * `.localcoderc.toml` checked into a repo to be able to switch the user's
 * adapter to a hostile baseUrl invisibly. Future expansions live behind
 * an explicit user opt-in.
 *
 * YAML (`.localcoderc.yaml`) is intentionally NOT supported — no YAML
 * parser is bundled. If a `.localcoderc.yaml` is encountered it's
 * skipped with a stderr warning so users aren't silently confused.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';

import type { DeepPartial } from './types';
import type { AppConfig } from '@/types/global';

/**
 * Bare filename forms we consider. Order matters — earlier wins when
 * multiple are present in the same directory.
 */
const RC_FILENAMES = ['.localcoderc.toml', '.localcoderc'] as const;
const YAML_NAMES = ['.localcoderc.yaml', '.localcoderc.yml'] as const;

/**
 * Fields the project-RC may safely override on the merged AppConfig.
 * Keep narrow — broadening this list is a security surface.
 */
const ALLOWED_PATHS: readonly string[] = [
  'model.current',
  'backend.type',
  'permissions.profile',
  'outputStyle',
  'context.maxTokens',
  'statusline.template',
];

/** Realpath cache so repeated lookups inside one project are O(1). */
const cache = new Map<string, DeepPartial<AppConfig>>();

/**
 * Reset the loader cache. Test-only entry point — not exported through
 * any public barrel because production code should rely on the realpath
 * key being stable for the project's lifetime.
 */
export function resetProjectRcCache(): void {
  cache.clear();
}

/**
 * Walk from `projectRoot` upward, collecting each `.localcoderc.toml` and
 * deep-merging them so the INNERMOST file wins on conflict. Returns an
 * empty object when no RC file is found anywhere.
 *
 * Never throws — parse failures fall through as silent skips so a broken
 * RC never prevents the app from starting.
 */
export function loadProjectRc(projectRoot: string): DeepPartial<AppConfig> {
  let resolvedKey: string;
  try {
    resolvedKey = realpathSync(projectRoot);
  } catch {
    resolvedKey = path.resolve(projectRoot);
  }
  const cached = cache.get(resolvedKey);
  if (cached !== undefined) return cached;

  // Collect file paths from outermost to innermost. We'll merge in
  // outermost-first order so later (innermost) values overwrite.
  const paths = walkUp(resolvedKey);
  const filesOutermostFirst = collectRcFiles(paths).reverse();

  let merged: DeepPartial<AppConfig> = {};
  for (const file of filesOutermostFirst) {
    const parsed = readRcFile(file);
    if (parsed === null) continue;
    const safe = filterRcOverrides(parsed);
    merged = deepMergePartial(merged, safe);
  }

  cache.set(resolvedKey, merged);
  return merged;
}

/**
 * List directory paths from `start` up to the filesystem root.
 * Result includes `start` itself first, then each ancestor in turn.
 */
function walkUp(start: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(start);
  // Defensive cap — filesystem hierarchies on macOS / Linux rarely exceed
  // ~20 levels; if we somehow hit 64 we bail to avoid infinite loops on
  // pathological filesystems.
  for (let i = 0; i < 64; i += 1) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/**
 * Given an ordered list of directories (innermost first), return the
 * resolved paths of every RC file that exists, preserving innermost-first
 * order. Emits a stderr warning for unsupported YAML variants so users
 * notice without aborting startup.
 */
function collectRcFiles(dirs: readonly string[]): string[] {
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of RC_FILENAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) {
        found.push(candidate);
      }
    }
    for (const name of YAML_NAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) {
        process.stderr.write(
          `localcode: ${candidate} found but YAML is not supported; use .localcoderc.toml instead\n`,
        );
      }
    }
  }
  return found;
}

/**
 * Parse a single RC file. Returns `null` on any read / parse failure
 * (file vanished mid-walk, not a TOML table, etc).
 */
function readRcFile(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`localcode: failed to parse ${file}: ${msg}\n`);
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Strip everything except the explicit safelist from `raw`. Walks dotted
 * paths and produces a sparse `DeepPartial<AppConfig>`.
 */
export function filterRcOverrides(
  raw: Record<string, unknown>,
): DeepPartial<AppConfig> {
  const out: Record<string, unknown> = {};
  for (const dotted of ALLOWED_PATHS) {
    const value = getByPath(raw, dotted);
    if (value === undefined) continue;
    setByPath(out, dotted, value);
  }
  return out as DeepPartial<AppConfig>;
}

function getByPath(obj: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function setByPath(
  obj: Record<string, unknown>,
  dotted: string,
  value: unknown,
): void {
  const parts = dotted.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (key === undefined) return;
    const existing = cur[key];
    if (
      existing === null ||
      existing === undefined ||
      typeof existing !== 'object' ||
      Array.isArray(existing)
    ) {
      const next: Record<string, unknown> = {};
      cur[key] = next;
      cur = next;
    } else {
      cur = existing as Record<string, unknown>;
    }
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) cur[last] = value;
}

/**
 * Recursively deep-merge `patch` into `base`. Plain objects recurse;
 * arrays + scalars from `patch` replace those in `base`.
 *
 * Public for use by `ConfigManager.readForProject` so the RC payload can
 * be layered over the validated global config.
 */
export function deepMergePartial<T>(
  base: DeepPartial<T>,
  patch: DeepPartial<T>,
): DeepPartial<T> {
  if (!isPlainObject(patch) || !isPlainObject(base)) {
    return patch ?? base;
  }
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const patchVal = (patch as Record<string, unknown>)[key];
    if (patchVal === undefined) continue;
    const baseVal = out[key];
    if (isPlainObject(baseVal) && isPlainObject(patchVal)) {
      out[key] = deepMergePartial(
        baseVal as Record<string, unknown>,
        patchVal as Record<string, unknown>,
      );
    } else {
      out[key] = patchVal;
    }
  }
  return out as DeepPartial<T>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || proto === Object.prototype;
}
