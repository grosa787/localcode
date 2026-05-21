/**
 * /wakeups — inspect and cancel pending in-session wakeups (scheduled
 * via the `schedule_wakeup` tool).
 *
 * Usage:
 *   /wakeups                       → list pending wakeups (id, fire-in,
 *                                    reason, first 60 chars of prompt).
 *   /wakeups cancel <id>           → cancel the wakeup with the given id
 *                                    (or any unambiguous prefix).
 *   /wakeups cancel all            → cancel every pending wakeup.
 *
 * The registry is process-wide and NOT persistent across restarts — a
 * `localcode` process restart implicitly cancels every pending wakeup.
 */

import type { CommandContext, SlashCommand } from '@/types/global';
import type { ScheduledWakeup, WakeupRegistry } from '@/scheduling';

export interface WakeupsDeps {
  /**
   * Process-wide wakeup registry. Composition roots pass the singleton
   * via `getProcessWakeupRegistry()`. The command is a thin wrapper
   * over `list()` / `cancel()` — no side effects beyond that.
   */
  registry: WakeupRegistry;
}

const WAKEUPS_NAME = 'wakeups';
const WAKEUPS_DESCRIPTION =
  'List or cancel pending in-session wakeups scheduled via schedule_wakeup.';
const WAKEUPS_USAGE = '/wakeups [cancel <id|all>]';

function fmtFireIn(fireAt: number, now: number): string {
  const deltaMs = Math.max(0, fireAt - now);
  const totalSec = Math.round(deltaMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${sec.toString().padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h${remMin.toString().padStart(2, '0')}m`;
}

function truncatePrompt(prompt: string, max = 60): string {
  if (prompt.length <= max) return prompt;
  return `${prompt.slice(0, max - 1)}…`;
}

function findByPrefix(
  entries: readonly ScheduledWakeup[],
  query: string,
): ScheduledWakeup | { ambiguous: true; matches: ScheduledWakeup[] } | null {
  const exact = entries.find((e) => e.id === query);
  if (exact !== undefined) return exact;
  const prefixMatches = entries.filter((e) => e.id.startsWith(query));
  if (prefixMatches.length === 0) return null;
  if (prefixMatches.length === 1) {
    const only = prefixMatches[0];
    return only !== undefined ? only : null;
  }
  return { ambiguous: true, matches: prefixMatches };
}

export function createWakeupsCommand(deps: WakeupsDeps): SlashCommand {
  const { registry } = deps;

  return {
    name: WAKEUPS_NAME,
    description: WAKEUPS_DESCRIPTION,
    usage: WAKEUPS_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();

      if (trimmed.length === 0) {
        const entries = registry.list();
        if (entries.length === 0) {
          ctx.print('No pending wakeups.');
          return;
        }
        const now = Date.now();
        ctx.print(`Pending wakeups (${entries.length}):`);
        for (const w of entries) {
          ctx.print(
            `  ${w.id}  fires in ${fmtFireIn(w.fireAt, now)}  — ${w.reason}`,
          );
          ctx.print(`      prompt: ${truncatePrompt(w.prompt)}`);
        }
        ctx.print('Cancel one with `/wakeups cancel <id>` or all with `/wakeups cancel all`.');
        return;
      }

      const firstSpace = trimmed.indexOf(' ');
      const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

      if (verb !== 'cancel') {
        ctx.print(`Unknown subcommand: ${verb}. Usage: ${WAKEUPS_USAGE}`);
        return;
      }

      if (rest.length === 0) {
        ctx.print('Usage: /wakeups cancel <id|all>');
        return;
      }

      if (rest === 'all') {
        const entries = registry.list();
        if (entries.length === 0) {
          ctx.print('No pending wakeups to cancel.');
          return;
        }
        let cancelled = 0;
        for (const w of entries) {
          if (registry.cancel(w.id)) cancelled += 1;
        }
        ctx.print(`Cancelled ${cancelled} wakeup${cancelled === 1 ? '' : 's'}.`);
        return;
      }

      const entries = registry.list();
      const found = findByPrefix(entries, rest);
      if (found === null) {
        ctx.print(`No wakeup matches id '${rest}'.`);
        return;
      }
      if ('ambiguous' in found) {
        ctx.print(`Ambiguous id '${rest}' — matches ${found.matches.length} wakeups:`);
        for (const m of found.matches) ctx.print(`  ${m.id}`);
        return;
      }
      const ok = registry.cancel(found.id);
      if (ok) {
        ctx.print(`Cancelled wakeup ${found.id}.`);
      } else {
        ctx.print(`Wakeup ${found.id} was already cancelled or has already fired.`);
      }
    },
  };
}
