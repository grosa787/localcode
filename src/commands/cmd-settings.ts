/**
 * /settings — view and edit generation parameters (FIX #35).
 *
 * Sources of truth (project takes precedence over global):
 *   - Global: `~/.localcode/config.toml` `[generation]`
 *   - Project: `<projectRoot>/.localcode/settings.json` `generation`
 *
 * Subcommand surface (Round-5 minimal scope):
 *
 *   /settings                 → open the SettingsOverlay when the host
 *                               supplies a `showOverlay` dispatcher;
 *                               otherwise prints the resolved snapshot.
 *   /settings show            → print current effective + global +
 *                               project values + the resolution source.
 *   /settings source          → alias for `show` (covers the
 *                               "where do these values come from?" case).
 *   /settings reset-project   → wipe all project-level overrides by
 *                               clearing the `generation` block in
 *                               `<projectRoot>/.localcode/settings.json`,
 *                               so the global config takes over again.
 *
 * No add/remove subcommands here: per-key editing is owned by the
 * SettingsOverlay (Agent 4 R5). This command is the keyboard-only
 * fallback + the way to clear project overrides quickly.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type {
  SlashCommand,
  CommandContext,
  GenerationConfig,
} from '@/types/global';
import type { ConfigManager } from '@/config/config-manager';

export interface SettingsDeps {
  configManager: ConfigManager;
  /**
   * Project root used to locate `<projectRoot>/.localcode/settings.json`.
   * Identical to `ctx.projectRoot` at runtime; passed in explicitly so
   * tests don't need to round-trip through the full CommandContext.
   */
  projectRoot: string;
}

const SETTINGS_NAME = 'settings';
const SETTINGS_DESCRIPTION =
  'View or edit generation parameters (temperature, top_p, repeat_penalty, max_tokens). Project settings override global.';
const SETTINGS_USAGE = '/settings [show | source | reset-project]';

export function createSettingsCommand(deps: SettingsDeps): SlashCommand {
  const { configManager, projectRoot } = deps;

  return {
    name: SETTINGS_NAME,
    description: SETTINGS_DESCRIPTION,
    usage: SETTINGS_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const verb = args.trim().toLowerCase();

      // No-arg → overlay when available; text fallback otherwise.
      if (verb.length === 0) {
        if (ctx.showOverlay !== undefined) {
          ctx.showOverlay('settings');
          return;
        }
        showText(configManager, projectRoot, ctx);
        return;
      }

      if (verb === 'show' || verb === 'source') {
        showText(configManager, projectRoot, ctx);
        return;
      }

      if (verb === 'reset-project' || verb === 'reset') {
        resetProject(configManager, projectRoot, ctx);
        return;
      }

      ctx.print(`Unknown subcommand: ${verb}. Usage: ${SETTINGS_USAGE}`);
    },
  };
}

// ---------- helpers ----------

/**
 * Print the resolved generation snapshot: the effective values, the
 * source tag, the global baseline, and the project-level overrides
 * (or "(no overrides)" when absent).
 *
 * Errors reading any layer are reported but do not abort — the user
 * still gets whatever rows we managed to fetch.
 */
function showText(
  configManager: ConfigManager,
  projectRoot: string,
  ctx: CommandContext,
): void {
  let resolved: ReturnType<ConfigManager['resolveGeneration']>;
  try {
    resolved = configManager.resolveGeneration(projectRoot);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to resolve generation settings: ${msg}`);
    return;
  }

  let global: GenerationConfig;
  try {
    global = configManager.read().generation;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to read global config: ${msg}`);
    return;
  }

  let project: Partial<GenerationConfig> | null = null;
  try {
    project = configManager.readProjectSettings(projectRoot);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`(Warning: failed to read project settings: ${msg})`);
    project = null;
  }

  ctx.print(`Source: ${resolved.source}`);
  ctx.print(
    `Effective: temperature=${resolved.generation.temperature}, top_p=${resolved.generation.topP}, repeat_penalty=${resolved.generation.repeatPenalty}, max_tokens=${resolved.generation.maxTokens}`,
  );
  ctx.print(
    `Global:    temperature=${global.temperature}, top_p=${global.topP}, repeat_penalty=${global.repeatPenalty}, max_tokens=${global.maxTokens}`,
  );

  if (project && hasAnyOverride(project)) {
    ctx.print(
      `Project:   temperature=${fmt(project.temperature)}, top_p=${fmt(project.topP)}, repeat_penalty=${fmt(project.repeatPenalty)}, max_tokens=${fmt(project.maxTokens)}`,
    );
  } else {
    ctx.print('Project:   (no overrides)');
  }
}

/**
 * Wipe project-level generation overrides so that the global config
 * takes over again. Removes the `generation` key entirely from
 * `<projectRoot>/.localcode/settings.json` (rather than writing an
 * empty `generation: {}` block) — this way `readProjectSettings`
 * returns `null` and `resolveGeneration` reports `source: 'global'`.
 *
 * Other top-level keys in `settings.json` (forward-compat slots) are
 * preserved verbatim. The `.localcode/` directory is created if
 * missing — same as `ConfigManager.writeProjectSettings`.
 */
function resetProject(
  configManager: ConfigManager,
  projectRoot: string,
  ctx: CommandContext,
): void {
  let hadOverrides = false;
  try {
    const existing = configManager.readProjectSettings(projectRoot);
    hadOverrides = existing !== null && hasAnyOverride(existing);
  } catch {
    // Treat read errors as "had something" so we still attempt the
    // write — the user explicitly asked to reset.
    hadOverrides = true;
  }

  try {
    removeGenerationBlock(projectRoot);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to reset project settings: ${msg}`);
    return;
  }

  if (hadOverrides) {
    ctx.print('✓ Project generation overrides cleared. Now using global settings.');
  } else {
    ctx.print('No project overrides were set; nothing to clear.');
  }
}

/**
 * Format a `number | undefined` field for display. `undefined` → `'—'`
 * to make it visually obvious that the project layer falls through to
 * the global value for that field.
 */
function fmt(value: number | undefined): string {
  return value === undefined ? '—' : String(value);
}

/**
 * Returns true iff at least one of the four generation fields is
 * explicitly set on the project layer.
 */
function hasAnyOverride(p: Partial<GenerationConfig>): boolean {
  return (
    p.temperature !== undefined ||
    p.topP !== undefined ||
    p.repeatPenalty !== undefined ||
    p.maxTokens !== undefined
  );
}

/**
 * Overwrite `<projectRoot>/.localcode/settings.json` so that the
 * `generation` key is fully removed. All other top-level keys are
 * preserved verbatim. If the file or directory doesn't exist yet,
 * the directory is created and a settings file with no `generation`
 * block is written (effectively a no-op for `readProjectSettings`,
 * which still returns `null` because there's no `generation` key).
 *
 * Atomic-ish: writes a sibling `.tmp` and renames it over the real
 * path (matches what `ConfigManager.writeProjectSettings` does).
 */
function removeGenerationBlock(projectRoot: string): void {
  const dir = path.join(projectRoot, '.localcode');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'settings.json');

  let existing: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed file — overwrite cleanly.
      existing = {};
    }
  }

  // Strip the `generation` key, preserve everything else.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (key === 'generation') continue;
    out[key] = value;
  }

  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  renameSync(tmp, p);
}
