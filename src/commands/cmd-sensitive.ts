/**
 * /sensitive — inspect and manage the sensitive-files catalog.
 *
 * Subcommands:
 *   /sensitive                  alias for `/sensitive list`.
 *   /sensitive list             show every effective pattern (defaults,
 *                               global, project) with reason + source.
 *   /sensitive add <pattern>    append `<pattern>` to project-local
 *                               `.localcode/sensitive-files.toml`. Creates
 *                               the file when absent. Does not modify the
 *                               global file.
 *   /sensitive check <path>     test a path against the active catalog;
 *                               handy for debugging false positives.
 *
 * The active catalog is reloaded on every invocation so a user edit
 * outside the TUI is reflected immediately.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SlashCommand, CommandContext } from '@/types/global';
import {
  isSensitivePath,
  loadSensitiveFiles,
  projectSensitiveFilesPath,
} from '@/security/sensitive-files';

const NAME = 'sensitive';
const DESCRIPTION =
  'Sensitive-files catalog — list patterns, add a project pattern, or check a path.';
const USAGE = '/sensitive [list|add <pattern>|check <path>]';

export function createSensitiveCommand(): SlashCommand {
  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : ['list'];
      const sub = (parts[0] ?? 'list').toLowerCase();
      const rest = parts.slice(1).join(' ').trim();
      switch (sub) {
        case 'list':
          runList(ctx);
          return;
        case 'add':
          runAdd(ctx, rest);
          return;
        case 'check':
          runCheck(ctx, rest);
          return;
        default:
          ctx.print(`Unknown /sensitive subcommand: ${sub}. Usage: ${USAGE}`);
          return;
      }
    },
  };
}

function runList(ctx: CommandContext): void {
  const config = loadSensitiveFiles(ctx.projectRoot);
  if (config.patterns.length === 0) {
    ctx.print('No sensitive patterns active.');
    return;
  }
  const counts: Record<'default' | 'global' | 'project', number> = {
    default: 0,
    global: 0,
    project: 0,
  };
  for (const p of config.patterns) counts[p.source] += 1;
  ctx.print(
    `Effective sensitive patterns: ${config.patterns.length} ` +
      `(defaults ${counts.default}, global ${counts.global}, project ${counts.project})`,
  );
  for (const p of config.patterns) {
    ctx.print(`  [${p.source}] ${p.pattern}  — ${p.reason}`);
  }
}

function runAdd(ctx: CommandContext, pattern: string): void {
  if (pattern.length === 0) {
    ctx.print('Usage: /sensitive add <pattern>');
    return;
  }
  const target = projectSensitiveFilesPath(ctx.projectRoot);
  let existing = '';
  if (existsSync(target)) {
    try {
      existing = readFileSync(target, 'utf8');
    } catch (cause) {
      ctx.print(`Failed to read ${target}: ${errMsg(cause)}`);
      return;
    }
  }
  if (patternAlreadyPresent(existing, pattern)) {
    ctx.print(`Pattern already present in ${target}.`);
    return;
  }
  const updated = appendSensitiveEntry(existing, pattern);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, updated, 'utf8');
  } catch (cause) {
    ctx.print(`Failed to write ${target}: ${errMsg(cause)}`);
    return;
  }
  ctx.print(`Added project sensitive pattern: ${pattern}`);
}

function runCheck(ctx: CommandContext, pathArg: string): void {
  if (pathArg.length === 0) {
    ctx.print('Usage: /sensitive check <path>');
    return;
  }
  const absolutePath = path.isAbsolute(pathArg)
    ? pathArg
    : path.resolve(ctx.projectRoot, pathArg);
  const config = loadSensitiveFiles(ctx.projectRoot);
  const result = isSensitivePath(absolutePath, ctx.projectRoot, config);
  if (result.sensitive) {
    ctx.print(
      `SENSITIVE: ${absolutePath}` +
        `\n  pattern: ${result.pattern}` +
        `\n  reason:  ${result.reason}` +
        `\n  source:  ${result.source}`,
    );
    return;
  }
  ctx.print(`Not sensitive: ${absolutePath}`);
}

// ---------- raw TOML editing helpers ----------

/**
 * True when the raw text already contains a `pattern = "<pattern>"`
 * declaration. Quick substring check — good enough for the typical
 * `[[sensitive]]\npattern = "..."` shape we emit; users who hand-author
 * exotic TOML may get a false negative, which only results in a
 * harmless duplicate entry (the loader dedupes by pattern).
 */
export function patternAlreadyPresent(raw: string, pattern: string): boolean {
  if (raw.length === 0) return false;
  const needle = `pattern = "${pattern}"`;
  return raw.includes(needle);
}

/**
 * Append a single `[[sensitive]]` block declaring `pattern`. Pure string
 * editing — preserves the user's surrounding formatting and any
 * pre-existing comments.
 */
export function appendSensitiveEntry(raw: string, pattern: string): string {
  const block = `[[sensitive]]\npattern = "${pattern}"\n`;
  if (raw.length === 0) {
    return `# Project-local sensitive-files overrides (extends defaults + global).\n\n${block}`;
  }
  const sep = raw.endsWith('\n\n') ? '' : raw.endsWith('\n') ? '\n' : '\n\n';
  return `${raw}${sep}${block}`;
}

function errMsg(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
