/**
 * /cost — open the current-session cost breakdown overlay.
 *
 * Per-turn list of input/output/cache tokens, duration, and computed
 * cost. Sticky total at the bottom. Opens the overlay through
 * `ctx.showOverlay('cost')`; falls back to a short text snapshot when
 * the host doesn't wire overlay dispatch.
 */

import type { SlashCommand, CommandContext } from '@/types/global';

export interface CostDeps {
  /** Snapshot the current session's per-turn cost rows. */
  readonly sessionTurnSnapshot: () => Array<{
    turn: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    durationMs: number;
    cost: number;
    model: string;
  }>;
}

const COST_NAME = 'cost';
const COST_DESCRIPTION = 'Show per-turn cost breakdown for the current session';
const COST_USAGE = '/cost';

export function createCostCommand(deps: CostDeps): SlashCommand {
  const { sessionTurnSnapshot } = deps;
  return {
    name: COST_NAME,
    description: COST_DESCRIPTION,
    usage: COST_USAGE,
    execute: async (_args: string, ctx: CommandContext): Promise<void> => {
      if (ctx.showOverlay !== undefined) {
        ctx.showOverlay('cost');
        return;
      }
      try {
        const rows = sessionTurnSnapshot();
        if (rows.length === 0) {
          ctx.print('No assistant turns recorded yet.');
          return;
        }
        let totalCost = 0;
        let totalIn = 0;
        let totalOut = 0;
        for (const r of rows) {
          totalCost += r.cost;
          totalIn += r.inputTokens;
          totalOut += r.outputTokens;
        }
        ctx.print(
          `Session cost: $${totalCost.toFixed(4)} · ${totalIn}→${totalOut} tokens across ${rows.length} turn(s).`,
        );
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`/cost failed: ${msg}`);
      }
    },
  };
}
