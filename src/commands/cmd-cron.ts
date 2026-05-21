/**
 * /cron — manage persistent cross-session cron entries.
 *
 * Forms:
 *   /cron list                    print all entries (id, spec, prompt
 *                                 preview, enabled/disabled, last fire).
 *   /cron add <spec> <prompt>     create a new entry. Inherits the
 *                                 current session's projectRoot + model.
 *   /cron remove <id>             delete an entry by id (or prefix).
 *   /cron enable <id>             flip `enabled = true`.
 *   /cron disable <id>            flip `enabled = false`.
 *
 * The command writes to `~/.localcode/crons.json` via the persistent
 * store. When a `PersistentScheduler` is wired, `refresh()` is called
 * after every mutation so the in-process timer rearms — daemon-less
 * setups get the schedule update without restarting.
 */

import type { CommandContext, SlashCommand } from '@/types/global';
import type {
  PersistentCronEntry,
  PersistentCronFile,
} from '@/scheduling';
import {
  defaultCronStorePath,
  loadCronStore,
  newCronId,
  parseCronSpec,
  updateCronStore,
} from '@/scheduling';

export interface CronDeps {
  /** Override the on-disk store path (tests / daemon). */
  filePath?: string;
  /**
   * Optional refresh hook — when a scheduler is running in-process,
   * call its `refresh()` so the timer rearms after a mutation.
   */
  onChange?: () => Promise<void> | void;
  /** Override `Date.now()` for tests. */
  nowFn?: () => number;
}

const NAME = 'cron';
const DESCRIPTION =
  'Manage persistent cross-session cron schedules (~/.localcode/crons.json).';
const USAGE = '/cron <list|add <spec> <prompt>|remove <id>|enable <id>|disable <id>>';

interface FindResult {
  entry: PersistentCronEntry | null;
  ambiguous: boolean;
  matches: PersistentCronEntry[];
}

function findByIdOrPrefix(
  entries: readonly PersistentCronEntry[],
  needle: string,
): FindResult {
  const exact = entries.find((e) => e.id === needle);
  if (exact !== undefined) return { entry: exact, ambiguous: false, matches: [exact] };
  const matches = entries.filter((e) => e.id.startsWith(needle));
  if (matches.length === 0) return { entry: null, ambiguous: false, matches: [] };
  if (matches.length === 1) {
    const only = matches[0];
    if (only === undefined) return { entry: null, ambiguous: false, matches: [] };
    return { entry: only, ambiguous: false, matches: [only] };
  }
  return { entry: null, ambiguous: true, matches };
}

function formatTimestamp(ms: number | undefined): string {
  if (ms === undefined) return 'never';
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

function truncate(s: string, max = 60): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Parse the `add` sub-command arguments. The cron spec is exactly 5
 * fields; everything after the 5th whitespace-separated token is the
 * prompt body (including embedded whitespace).
 */
export function parseCronAddArgs(
  raw: string,
): { spec: string; prompt: string } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { error: 'Usage: /cron add <spec> <prompt>' };
  }
  // Take first 5 tokens as the spec, the rest as the prompt. We need
  // the prompt to preserve internal whitespace, so we manually scan.
  const tokens: string[] = [];
  let i = 0;
  while (i < trimmed.length && tokens.length < 5) {
    // skip whitespace
    while (i < trimmed.length && /\s/.test(trimmed[i] ?? '')) i += 1;
    const start = i;
    while (i < trimmed.length && !/\s/.test(trimmed[i] ?? '')) i += 1;
    if (start < i) tokens.push(trimmed.slice(start, i));
  }
  if (tokens.length < 5) {
    return {
      error: 'Cron spec must be 5 fields. Usage: /cron add <m> <h> <dom> <mon> <dow> <prompt>',
    };
  }
  const promptPart = trimmed.slice(i).trim();
  if (promptPart.length === 0) {
    return { error: 'Prompt is required. Usage: /cron add <spec> <prompt>' };
  }
  const spec = tokens.join(' ');
  return { spec, prompt: promptPart };
}

export function createCronCommand(deps: CronDeps = {}): SlashCommand {
  const filePath = deps.filePath ?? defaultCronStorePath();

  async function notifyChange(): Promise<void> {
    if (deps.onChange === undefined) return;
    try {
      await deps.onChange();
    } catch {
      // best-effort; never propagate refresh errors
    }
  }

  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        ctx.print(`Usage: ${USAGE}`);
        return;
      }
      const firstSpace = trimmed.indexOf(' ');
      const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

      if (verb === 'list') {
        let file: PersistentCronFile;
        try {
          file = await loadCronStore(filePath);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to read cron store: ${msg}`);
          return;
        }
        if (file.crons.length === 0) {
          ctx.print(`No cron entries in ${filePath}.`);
          ctx.print('Add one with `/cron add <spec> <prompt>`.');
          return;
        }
        ctx.print(`Cron entries (${file.crons.length}) — file: ${filePath}`);
        for (const c of file.crons) {
          const state = c.enabled ? 'enabled ' : 'disabled';
          ctx.print(
            `  ${c.id}  [${state}]  ${c.cronSpec}  last:${formatTimestamp(c.lastFiredAt)}`,
          );
          ctx.print(`      prompt: ${truncate(c.prompt)}`);
          if (c.model !== undefined) ctx.print(`      model:  ${c.model}`);
          if (c.projectRoot !== undefined) {
            ctx.print(`      root:   ${c.projectRoot}`);
          }
        }
        return;
      }

      if (verb === 'add') {
        const parsed = parseCronAddArgs(rest);
        if ('error' in parsed) {
          ctx.print(parsed.error);
          return;
        }
        try {
          parseCronSpec(parsed.spec);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Invalid cron spec: ${msg}`);
          return;
        }
        const id = newCronId();
        const entry: PersistentCronEntry = {
          id,
          cronSpec: parsed.spec,
          prompt: parsed.prompt,
          model: ctx.config.model.current,
          projectRoot: ctx.projectRoot,
          enabled: true,
        };
        try {
          await updateCronStore((current) => {
            return {
              version: 1,
              crons: [...current.crons, entry],
            };
          }, filePath);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to add cron: ${msg}`);
          return;
        }
        ctx.print(`Added cron ${id} — ${parsed.spec}`);
        await notifyChange();
        return;
      }

      if (verb === 'remove' || verb === 'rm') {
        if (rest.length === 0) {
          ctx.print('Usage: /cron remove <id>');
          return;
        }
        let removedId: string | null = null;
        try {
          await updateCronStore((current) => {
            const found = findByIdOrPrefix(current.crons, rest);
            if (found.ambiguous) {
              throw new Error(
                `Ambiguous id '${rest}' — matches ${found.matches.length} entries`,
              );
            }
            if (found.entry === null) {
              throw new Error(`No cron matches id '${rest}'`);
            }
            removedId = found.entry.id;
            return {
              version: 1,
              crons: current.crons.filter((c) => c.id !== removedId),
            };
          }, filePath);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(msg);
          return;
        }
        ctx.print(`Removed cron ${removedId ?? rest}.`);
        await notifyChange();
        return;
      }

      if (verb === 'enable' || verb === 'disable') {
        if (rest.length === 0) {
          ctx.print(`Usage: /cron ${verb} <id>`);
          return;
        }
        const wantEnabled = verb === 'enable';
        let targetId: string | null = null;
        try {
          await updateCronStore((current) => {
            const found = findByIdOrPrefix(current.crons, rest);
            if (found.ambiguous) {
              throw new Error(
                `Ambiguous id '${rest}' — matches ${found.matches.length} entries`,
              );
            }
            if (found.entry === null) {
              throw new Error(`No cron matches id '${rest}'`);
            }
            const matchedId = found.entry.id;
            targetId = matchedId;
            return {
              version: 1,
              crons: current.crons.map((c) =>
                c.id === matchedId ? { ...c, enabled: wantEnabled } : c,
              ),
            };
          }, filePath);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(msg);
          return;
        }
        ctx.print(`${wantEnabled ? 'Enabled' : 'Disabled'} cron ${targetId ?? rest}.`);
        await notifyChange();
        return;
      }

      ctx.print(`Unknown subcommand: ${verb}. Usage: ${USAGE}`);
    },
  };
}
