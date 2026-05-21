/**
 * /suggest — toggle the suggested-follow-ups composer ghost rows.
 *
 * No persistence — the toggle is in-memory and resets to "on" on every
 * fresh process start. Lives behind a host-supplied setter so the
 * command stays free of UI imports (the ghost-row state is owned by
 * ChatScreen / app.tsx, which pass us a tiny `setEnabled` callback).
 *
 * Usage:
 *   /suggest        → print current state.
 *   /suggest on     → enable.
 *   /suggest off    → disable.
 *   /suggest toggle → flip current state.
 */

import type { SlashCommand, CommandContext } from '@/types/global';

export interface SuggestDeps {
  /** Read the live "are suggestions visible" flag. */
  readonly getEnabled: () => boolean;
  /** Persist the new flag in host state so the UI rerenders. */
  readonly setEnabled: (next: boolean) => void;
}

const SUGGEST_NAME = 'suggest';
const SUGGEST_DESCRIPTION = 'Toggle the suggested follow-ups under each assistant reply';
const SUGGEST_USAGE = '/suggest [on|off|toggle]';

export function createSuggestCommand(deps: SuggestDeps): SlashCommand {
  const { getEnabled, setEnabled } = deps;
  return {
    name: SUGGEST_NAME,
    description: SUGGEST_DESCRIPTION,
    usage: SUGGEST_USAGE,
    execute: (args: string, ctx: CommandContext): void => {
      const arg = args.trim().toLowerCase();
      const current = getEnabled();
      if (arg.length === 0) {
        ctx.print(`Suggested follow-ups are ${current ? 'ON' : 'OFF'}. ${SUGGEST_USAGE}`);
        return;
      }
      if (arg === 'on' || arg === 'enable') {
        setEnabled(true);
        ctx.print('Suggested follow-ups: ON');
        return;
      }
      if (arg === 'off' || arg === 'disable') {
        setEnabled(false);
        ctx.print('Suggested follow-ups: OFF');
        return;
      }
      if (arg === 'toggle') {
        setEnabled(!current);
        ctx.print(`Suggested follow-ups: ${!current ? 'ON' : 'OFF'}`);
        return;
      }
      ctx.print(`Unknown /suggest argument: '${arg}'. Use ${SUGGEST_USAGE}`);
    },
  };
}
