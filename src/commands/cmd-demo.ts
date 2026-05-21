/**
 * /demo — replay the bundled quick-tour inside an active session.
 *
 * Mirrors `localcode demo` but routes the recording entries through a
 * host-supplied dispatch callback so the events surface as chat-log
 * lines instead of stdout. Wiring the same Player used by `/replay`
 * keeps the playback semantics identical (speed=1x, no skip).
 *
 * The command takes no arguments — the demo is curated and ships with
 * the binary. A future iteration may add `--speed` / `--instant` flags
 * but the v1 surface stays deliberately small.
 *
 * If the bundled recording cannot be found (e.g. a hand-built dev tree
 * with the asset removed), the command prints a friendly error to chat
 * and returns without throwing.
 */

import type { CommandContext, SlashCommand } from '@/types/global';
import { Player, loadRecording, type Recording, type ReplayDispatch } from '@/recordings';
import { resolveDemoRecordingPath, formatEntry } from '@/cli/demo';

export interface DemoCmdDeps {
  /** Player instance — wired by the composition root (1 per session). */
  readonly player: Player;
  /**
   * Optional dispatch sink — composition root decides how each entry
   * materialises in the UI. When omitted, the command falls back to
   * `ctx.print` so entries land as system notices in the chat log.
   */
  readonly dispatch?: ReplayDispatch;
  /** Test seam: alternate recording loader. */
  readonly loadFn?: (filePath: string) => Promise<Recording>;
  /** Test seam: alternate path resolver. */
  readonly resolveFn?: () => Promise<string>;
}

const NAME = 'demo';
const DESCRIPTION = 'Replay a short tour that shows what LocalCode can do.';
const USAGE = '/demo';

export function createDemoCommand(deps: DemoCmdDeps): SlashCommand {
  const resolveFn = deps.resolveFn ?? resolveDemoRecordingPath;
  const loadFn = deps.loadFn ?? loadRecording;

  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (_args: string, ctx: CommandContext): Promise<void> => {
      let recordingPath: string;
      try {
        recordingPath = await resolveFn();
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`/demo: ${msg}`);
        return;
      }

      let rec: Recording;
      try {
        rec = await loadFn(recordingPath);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`/demo: failed to load recording: ${msg}`);
        return;
      }

      ctx.print(`Replaying ${rec.id} (${rec.entries.length} entries).`);

      // Use the host-supplied dispatch when present; otherwise fall back
      // to surfacing each entry as a system note via ctx.print so the
      // command is useful even on hosts that don't wire dispatch.
      const dispatch: ReplayDispatch =
        deps.dispatch ??
        ((entry): void => {
          ctx.print(formatEntry(entry));
        });

      try {
        await deps.player.replay(rec, dispatch);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`/demo: replay failed: ${msg}`);
        return;
      }

      ctx.print('Demo complete.');
    },
  };
}
