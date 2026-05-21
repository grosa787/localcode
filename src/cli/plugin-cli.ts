/**
 * `localcode plugin <subcommand>` — argv handlers for the plugin
 * sub-CLI. Does NOT launch ink — every subcommand prints to stdout and
 * exits with a numeric status code.
 *
 * Subcommands:
 *   - install <path>     register a plugin from a local directory
 *   - uninstall <id>     remove a registered plugin
 *   - list               print the registered plugins
 *   - enable <id>        flip the enabled flag on
 *   - disable <id>       flip the enabled flag off
 *
 * Designed so the tests can call `runPluginCli(argv, { write, scope })`
 * with a captured-output writer and assert on the rendered text without
 * spawning a child process.
 */

import {
  PluginRegistry,
  type PluginRegistryEntry,
  type PluginScope,
} from '@/plugins/registry';

export interface PluginCliWriters {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface PluginCliOptions {
  /**
   * Optional override for the registry instance. Tests inject a
   * registry rooted at a tmp directory; production callers omit it
   * and the handler builds one from `scope` + `projectRoot`.
   */
  registry?: PluginRegistry;
  scope?: PluginScope;
  projectRoot?: string;
  writers?: Partial<PluginCliWriters>;
}

interface ParsedArgs {
  sub: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseSubArgs(args: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let sub = '';
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i];
    if (tok === undefined) continue;
    if (sub === '') {
      sub = tok;
      continue;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[tok.slice(2)] = next;
          i += 1;
        } else {
          flags[tok.slice(2)] = true;
        }
      }
      continue;
    }
    positional.push(tok);
  }
  return { sub, positional, flags };
}

const HELP_TEXT = `localcode plugin <subcommand>

Subcommands:
  install <path>      Register a plugin from a local directory.
  uninstall <id>      Remove a registered plugin.
  list                Print the registered plugins for the current scope.
  enable <id>         Mark a plugin as enabled.
  disable <id>        Mark a plugin as disabled.

Flags:
  --scope global|project   Choose which registry to operate on. Default: project.
  --project-root <path>    Override the project root (default: cwd).
  --help, -h               Show this help.

Examples:
  localcode plugin install ./my-plugin
  localcode plugin list
  localcode plugin disable hello-plugin
`;

/**
 * Entry point used by `cli.tsx` when the first positional argument is
 * `plugin`. Returns an exit code (0 on success, non-zero on error) so
 * the caller can pass it directly to `process.exit`.
 */
export async function runPluginCli(
  argv: readonly string[],
  opts: PluginCliOptions = {},
): Promise<number> {
  const write: PluginCliWriters = {
    out: opts.writers?.out ?? ((l): void => {
      process.stdout.write(`${l}\n`);
    }),
    err: opts.writers?.err ?? ((l): void => {
      process.stderr.write(`${l}\n`);
    }),
  };

  const parsed = parseSubArgs(argv);

  if (parsed.sub === '' || parsed.sub === 'help' || parsed.flags['help'] === true || parsed.flags['h'] === true) {
    write.out(HELP_TEXT);
    return 0;
  }

  const scopeFlag = parsed.flags['scope'];
  const scope: PluginScope =
    typeof opts.scope === 'string'
      ? opts.scope
      : scopeFlag === 'global'
        ? 'global'
        : scopeFlag === 'project' || scopeFlag === undefined
          ? 'project'
          : 'project';

  const projectRoot =
    typeof opts.projectRoot === 'string'
      ? opts.projectRoot
      : typeof parsed.flags['project-root'] === 'string'
        ? (parsed.flags['project-root'] as string)
        : process.cwd();

  let registry: PluginRegistry;
  if (opts.registry !== undefined) {
    registry = opts.registry;
  } else {
    try {
      registry =
        scope === 'global'
          ? new PluginRegistry({ scope: 'global' })
          : new PluginRegistry({ scope: 'project', projectRoot });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      write.err(`plugin: ${msg}`);
      return 1;
    }
  }

  try {
    switch (parsed.sub) {
      case 'install': {
        const src = parsed.positional[0];
        if (src === undefined) {
          write.err('plugin install: missing <path> argument');
          return 1;
        }
        const entry = await registry.install(src);
        write.out(`Installed plugin "${entry.id}" → ${entry.sourcePath}`);
        return 0;
      }
      case 'uninstall': {
        const id = parsed.positional[0];
        if (id === undefined) {
          write.err('plugin uninstall: missing <id> argument');
          return 1;
        }
        const removed = await registry.uninstall(id);
        if (!removed) {
          write.err(`plugin uninstall: no plugin registered with id "${id}"`);
          return 1;
        }
        write.out(`Uninstalled plugin "${id}".`);
        return 0;
      }
      case 'list': {
        const entries = await registry.list();
        renderList(entries, scope, write);
        return 0;
      }
      case 'enable': {
        const id = parsed.positional[0];
        if (id === undefined) {
          write.err('plugin enable: missing <id> argument');
          return 1;
        }
        const entry = await registry.enable(id);
        write.out(`Enabled "${entry.id}".`);
        return 0;
      }
      case 'disable': {
        const id = parsed.positional[0];
        if (id === undefined) {
          write.err('plugin disable: missing <id> argument');
          return 1;
        }
        const entry = await registry.disable(id);
        write.out(`Disabled "${entry.id}".`);
        return 0;
      }
      default:
        write.err(`plugin: unknown subcommand "${parsed.sub}"`);
        write.err('Run `localcode plugin --help` for usage.');
        return 1;
    }
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    write.err(`plugin ${parsed.sub}: ${msg}`);
    return 1;
  }
}

function renderList(
  entries: readonly PluginRegistryEntry[],
  scope: PluginScope,
  write: PluginCliWriters,
): void {
  if (entries.length === 0) {
    write.out(`No plugins registered (${scope} scope).`);
    return;
  }
  write.out(`Registered plugins (${scope}):`);
  for (const entry of entries) {
    const snapshot = entry.manifestSnapshot;
    const version =
      typeof snapshot['version'] === 'string'
        ? (snapshot['version'] as string)
        : '?';
    const flag = entry.enabled ? 'enabled' : 'disabled';
    write.out(`  ${entry.id}  v${version}  [${flag}]  ${entry.sourcePath}`);
  }
}
