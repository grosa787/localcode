/**
 * /memory save <id> — accept a staged feedback proposal and persist it
 * to `<projectRoot>/.localcode/memory/<name>.md`.
 *
 * Wave 6 — self-evolution memory.
 *
 * Lifecycle:
 *   1. `AutoFeedbackDetector.observe(...)` returns a `FeedbackProposal`
 *      after a positive / negative / configuration signal.
 *   2. The host stages the proposal via `FeedbackStagingArea.stage(p)`
 *      and surfaces a synthetic system note inviting the user to save.
 *   3. The user types `/memory save <id>` (or `/memory save latest` to
 *      grab the most-recently-staged entry).
 *   4. The command consumes the staged proposal and writes it through
 *      `MemoryStore.write(...)`.
 *
 * Deliberately a separate slash command from the read-only `/memory`
 * lister — keeping them split means the staged-area consumer cannot
 * accidentally fire on a casual `/memory` invocation.
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import { MemoryStore } from '@/memory/store';
import {
  type FeedbackProposal,
  type FeedbackStagingArea,
} from '@/memory/auto-feedback';

export interface MemorySaveDeps {
  readonly projectRoot: string;
  readonly staging: FeedbackStagingArea;
  /** Override the store constructor for tests. */
  readonly storeFactory?: (projectRoot: string) => Pick<MemoryStore, 'write'>;
  /**
   * Optional resolver for `latest` — returns the most recently staged
   * proposal id. Hosts that want `/memory save latest` to work must
   * supply this. Without it the command still functions for explicit
   * ids.
   */
  readonly resolveLatest?: () => string | null;
}

const CMD_NAME = 'memory-save';
const CMD_DESCRIPTION = 'Persist a staged feedback memory entry by id';
const CMD_USAGE = '/memory-save <id>';

export function createMemorySaveCommand(deps: MemorySaveDeps): SlashCommand {
  const { projectRoot, staging, storeFactory, resolveLatest } = deps;
  const makeStore = storeFactory ?? ((root: string) => new MemoryStore(root));

  return {
    name: CMD_NAME,
    description: CMD_DESCRIPTION,
    usage: CMD_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        ctx.print(`Missing id. ${CMD_USAGE}`);
        return;
      }

      const id = resolveId(trimmed, resolveLatest);
      if (id === null) {
        ctx.print('No staged proposals to save.');
        return;
      }

      const proposal = staging.consume(id);
      if (proposal === null) {
        ctx.print(
          `No staged feedback proposal with id "${id}" (may have expired or already been saved).`,
        );
        return;
      }

      try {
        const store = makeStore(projectRoot);
        const written = await store.write(proposal.suggestedEntry);
        ctx.print(
          `Saved feedback memory: ${written.name} (${proposal.polarity}, confidence ${proposal.confidence.toFixed(2)}).`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.print(`Failed to save feedback memory: ${msg}`);
        // Re-stage on failure so the user can retry without losing the
        // proposal. The staging area's TTL still applies.
        restage(staging, proposal);
      }
    },
  };
}

function resolveId(
  arg: string,
  resolveLatest: (() => string | null) | undefined,
): string | null {
  if (arg.toLowerCase() === 'latest' || arg.toLowerCase() === 'last') {
    if (resolveLatest === undefined) return null;
    return resolveLatest();
  }
  return arg;
}

function restage(staging: FeedbackStagingArea, proposal: FeedbackProposal): void {
  try {
    staging.stage(proposal);
  } catch {
    // Best-effort — staging.stage() is currently infallible, but we
    // defend against future changes.
  }
}
