/**
 * /tutorial — re-open the first-run interactive walkthrough on demand.
 *
 * The TutorialOverlay normally auto-fires on the first chat-screen
 * render after onboarding (gated by `config.firstRun?.tutorialShown`).
 * Once dismissed the overlay never auto-re-shows; users who want to see
 * it again invoke this command. The composition root supplies the
 * `open` callback that flips the overlay state back on; this command
 * is purely a thin shim so the slash registry surfaces `/tutorial` in
 * `/help` and `/api/commands`.
 *
 * No arguments — the tutorial content is curated. A future iteration
 * may add `--step <n>` to jump straight to a specific card.
 */

import type { CommandContext, SlashCommand } from '@/types/global';

export interface TutorialDeps {
  /**
   * Re-open the tutorial overlay. The composition root owns the actual
   * `setTutorialOpen(true)` call so this command stays decoupled from
   * React state.
   */
  readonly open: () => void;
}

const NAME = 'tutorial';
const DESCRIPTION = 'Re-open the first-run interactive walkthrough.';
const USAGE = '/tutorial';

export function createTutorialCommand(deps: TutorialDeps): SlashCommand {
  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (_args: string, _ctx: CommandContext): Promise<void> => {
      deps.open();
    },
  };
}
