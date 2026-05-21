/**
 * /plugin — inside-TUI plugin management.
 *
 * Subcommands:
 *   /plugin list                  Show registered plugins.
 *   /plugin info <id>             Print manifest snapshot for one plugin.
 *   /plugin enable <id>           Flip enabled flag on.
 *   /plugin disable <id>          Flip enabled flag off.
 *   /plugin reload                Re-run discovery and re-register
 *                                 contributed tools / commands / themes.
 *
 * The command itself is async, prints via `ctx.print`, and never opens
 * an overlay. Plugin installation is intentionally CLI-only (use
 * `localcode plugin install <path>`) so the user can't accidentally
 * shell-copy untrusted code from inside the chat input.
 */

import type { CommandContext, SlashCommand } from '@/types/global';
import {
  PluginRegistry,
  type PluginRegistryEntry,
} from '@/plugins/registry';

export interface PluginCommandDeps {
  /** Project root used to build the project-scoped registry. */
  getProjectRoot: () => string;
  /**
   * Trigger a plugin reload in the host. Implemented by app.tsx (TUI)
   * as a re-run of `loadPlugins({ projectRoot })` + handler-map rebuild.
   * Returns the new plugin count so the command can print a summary.
   */
  reloadPlugins?: () => Promise<{ count: number; names: string[] }>;
  /**
   * Optional override — tests inject a registry rooted at a tmp
   * directory. Production callers omit it and the command builds one
   * from `getProjectRoot()`.
   */
  registry?: PluginRegistry;
}

const NAME = 'plugin';
const DESCRIPTION = 'Manage installed plugins (list, info, enable, disable, reload).';
const USAGE = '/plugin <list|info|enable|disable|reload> [id]';

export function createPluginCommand(deps: PluginCommandDeps): SlashCommand {
  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (rawArgs: string, ctx: CommandContext): Promise<void> => {
      const args = rawArgs.trim().split(/\s+/).filter((s) => s.length > 0);
      const sub = args[0] ?? 'list';
      const id = args[1];

      const registry =
        deps.registry ??
        new PluginRegistry({
          scope: 'project',
          projectRoot: deps.getProjectRoot(),
        });

      try {
        switch (sub) {
          case 'list':
            await runList(ctx, registry);
            return;
          case 'info': {
            if (id === undefined) {
              ctx.print('Usage: /plugin info <id>');
              return;
            }
            await runInfo(ctx, registry, id);
            return;
          }
          case 'enable':
          case 'disable': {
            if (id === undefined) {
              ctx.print(`Usage: /plugin ${sub} <id>`);
              return;
            }
            const updated =
              sub === 'enable'
                ? await registry.enable(id)
                : await registry.disable(id);
            ctx.print(`✓ ${updated.id} → ${updated.enabled ? 'enabled' : 'disabled'}`);
            return;
          }
          case 'reload':
            await runReload(ctx, deps);
            return;
          default:
            ctx.print(`Unknown subcommand: ${sub}. ${USAGE}`);
        }
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`/plugin ${sub}: ${msg}`);
      }
    },
  };
}

async function runList(
  ctx: CommandContext,
  registry: PluginRegistry,
): Promise<void> {
  const entries = await registry.list();
  if (entries.length === 0) {
    ctx.print('No plugins registered for this project.');
    ctx.print('Install one with `localcode plugin install <path>`.');
    return;
  }
  ctx.print(`Registered plugins (${entries.length}):`);
  for (const entry of entries) {
    const v = readVersion(entry);
    const flag = entry.enabled ? 'enabled' : 'disabled';
    ctx.print(`  ${entry.id}  v${v}  [${flag}]`);
  }
}

async function runInfo(
  ctx: CommandContext,
  registry: PluginRegistry,
  id: string,
): Promise<void> {
  const entry = await registry.get(id);
  if (entry === null) {
    ctx.print(`No plugin registered with id "${id}".`);
    return;
  }
  const m = entry.manifestSnapshot;
  ctx.print(`Plugin: ${entry.id}`);
  ctx.print(`  Name:        ${readString(m, 'name')}`);
  ctx.print(`  Version:     ${readString(m, 'version')}`);
  ctx.print(`  Description: ${readString(m, 'description')}`);
  const author = readString(m, 'author');
  if (author !== '?') ctx.print(`  Author:      ${author}`);
  const license = readString(m, 'license');
  if (license !== '?') ctx.print(`  License:     ${license}`);
  const homepage = readString(m, 'homepage');
  if (homepage !== '?') ctx.print(`  Homepage:    ${homepage}`);
  ctx.print(`  Enabled:     ${entry.enabled ? 'yes' : 'no'}`);
  ctx.print(`  Source:      ${entry.sourcePath}`);
  const caps = m['capabilities'];
  if (caps !== null && typeof caps === 'object' && !Array.isArray(caps)) {
    const c = caps as Record<string, unknown>;
    const tools = Array.isArray(c['tools']) ? c['tools'].length : 0;
    const commands = Array.isArray(c['commands']) ? c['commands'].length : 0;
    const themes = Array.isArray(c['themes']) ? c['themes'].length : 0;
    const statusline = c['statusline'] !== undefined ? 1 : 0;
    ctx.print(`  Capabilities: tools=${tools}, commands=${commands}, themes=${themes}, statusline=${statusline}`);
  }
}

async function runReload(
  ctx: CommandContext,
  deps: PluginCommandDeps,
): Promise<void> {
  if (deps.reloadPlugins === undefined) {
    ctx.print('Plugin reload is not wired in this build.');
    return;
  }
  const result = await deps.reloadPlugins();
  if (result.count === 0) {
    ctx.print('Plugins reloaded. No plugins active.');
    return;
  }
  ctx.print(`✓ Reloaded ${result.count} plugin${result.count === 1 ? '' : 's'}: ${result.names.join(', ')}`);
}

function readString(record: Record<string, unknown>, key: string): string {
  const v = record[key];
  return typeof v === 'string' && v.length > 0 ? v : '?';
}

function readVersion(entry: PluginRegistryEntry): string {
  const v = entry.manifestSnapshot['version'];
  return typeof v === 'string' ? v : '?';
}
