/**
 * /whiteboard — open the drawing surface in the web UI.
 *
 * Web-only feature: the LocalCode SPA hosts a tldraw-based whiteboard
 * docked on the right. Submitting `/whiteboard` in the web composer is
 * intercepted client-side and never reaches this command — see
 * `Composer.tsx`'s `WHITEBOARD-SECTION` for the actual handler.
 *
 * This stub exists so:
 *   1. The TUI `slash-registry` lists the command in `/help`.
 *   2. The web UI's `/api/commands` payload includes it, so the
 *      Composer autocomplete surfaces `/whiteboard` to the user.
 *   3. Running `/whiteboard` from the TUI (where there is no web
 *      whiteboard) prints a friendly nudge instead of an "unknown
 *      command" error.
 */

import type { CommandContext, SlashCommand } from '@/types/global';

const NAME = 'whiteboard';
const DESCRIPTION =
  'Open the web whiteboard for sketching diagrams / UI mockups (web UI only).';
const USAGE = '/whiteboard';

/**
 * Factory returns a `SlashCommand` with no dependencies. The web side
 * intercepts the command in `Composer.tsx` before it ever runs.
 */
export function createWhiteboardCommand(): SlashCommand {
  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: (_args: string, ctx: CommandContext): void => {
      ctx.print(
        'Whiteboard is a web-only feature. Run `localcode --web`, then press Cmd/Ctrl+Shift+W to open it.',
      );
    },
  };
}
