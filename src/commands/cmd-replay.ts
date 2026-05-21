/**
 * /replay — load a saved recording and play it back as a demo.
 *
 * Forms:
 *   /replay <file>                replay at 1x speed.
 *   /replay <file> --speed <N>    multiplier (e.g. `2`, `2x`, `0.5`).
 *   /replay <file> --instant      no delays between entries.
 *
 * The replay is local-only — entries flow through the host-supplied
 * dispatch callback that decides how to surface them in the UI (e.g.
 * append to the message stream as system notices, or render them as
 * fresh user/assistant bubbles). The command itself does not call the
 * LLM.
 */

import path from 'node:path';
import type { CommandContext, SlashCommand } from '@/types/global';
import type { Recording, ReplayDispatch, ReplayOptions } from '@/recordings';
import { Player, loadRecording } from '@/recordings';

export interface ReplayDeps {
  /** Player instance — wired by the composition root. */
  player: Player;
  /** Project root for resolving relative paths. */
  projectRoot: string;
  /**
   * Dispatch sink — composition root decides how entries materialise
   * in the UI.
   */
  dispatch: ReplayDispatch;
  /** Optional override for file load (tests). */
  loadFn?: (filePath: string) => Promise<Recording>;
}

const NAME = 'replay';
const DESCRIPTION =
  'Replay a saved recording (.lcrec) as a demo. Supports --speed and --instant.';
const USAGE = '/replay <file> [--speed <N>] [--instant]';

interface ParsedArgs {
  readonly filePath: string | null;
  readonly options: Partial<ReplayOptions>;
  readonly error: string | null;
}

export function parseReplayArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  let filePath: string | null = null;
  let speed: number | undefined;
  let skipDelays = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    if (tok === '--instant') {
      skipDelays = true;
      continue;
    }
    if (tok === '--speed') {
      const next = tokens[i + 1];
      if (next === undefined) {
        return {
          filePath: null,
          options: {},
          error: '--speed requires a multiplier value',
        };
      }
      const parsed = parseSpeed(next);
      if (parsed === null) {
        return {
          filePath: null,
          options: {},
          error: `--speed expects a positive number (e.g. 2, 2x, 0.5); got '${next}'`,
        };
      }
      speed = parsed;
      i += 1;
      continue;
    }
    if (tok.startsWith('--')) {
      return {
        filePath: null,
        options: {},
        error: `Unknown flag: ${tok}`,
      };
    }
    if (filePath === null) {
      filePath = tok;
      continue;
    }
    return {
      filePath: null,
      options: {},
      error: `Unexpected argument: ${tok}`,
    };
  }

  const options: Partial<ReplayOptions> =
    speed !== undefined ? { skipDelays, speed } : { skipDelays };
  return { filePath, options, error: null };
}

function parseSpeed(token: string): number | null {
  const cleaned = token.endsWith('x') || token.endsWith('X')
    ? token.slice(0, -1)
    : token;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function createReplayCommand(deps: ReplayDeps): SlashCommand {
  const { player, projectRoot, dispatch } = deps;
  const loadFn = deps.loadFn ?? loadRecording;

  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const parsed = parseReplayArgs(args);
      if (parsed.error !== null) {
        ctx.print(parsed.error);
        ctx.print(`Usage: ${USAGE}`);
        return;
      }
      if (parsed.filePath === null) {
        ctx.print(`Usage: ${USAGE}`);
        return;
      }
      const target = path.isAbsolute(parsed.filePath)
        ? parsed.filePath
        : path.resolve(projectRoot, parsed.filePath);
      let rec: Recording;
      try {
        rec = await loadFn(target);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to load recording: ${msg}`);
        return;
      }
      ctx.print(
        `Replaying ${rec.id} (${rec.entries.length} entries${
          parsed.options.skipDelays === true ? ', instant' : ''
        }${
          parsed.options.speed !== undefined && parsed.options.speed !== 1
            ? `, ${parsed.options.speed}x`
            : ''
        }).`,
      );
      try {
        await player.replay(rec, dispatch, parsed.options);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Replay failed: ${msg}`);
        return;
      }
      ctx.print('Replay complete.');
    },
  };
}
