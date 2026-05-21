/**
 * /usage — open the cross-session usage dashboard.
 *
 * No-arg invocation opens the overlay via `ctx.showOverlay('usage')`.
 * When the host doesn't wire `showOverlay`, prints a short text
 * snapshot via `ctx.print` so the command remains useful in tests and
 * non-interactive contexts.
 *
 * Cost numbers are computed at overlay-render time so the dashboard
 * picks up the freshest OpenRouter prices — this command itself does
 * NOT trigger the network fetch (the parent does, debounced).
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import type { SessionManager } from '@/sessions/session-manager';
import { resolvePrice } from '@/llm/pricing/resolver';
import { computeCostBreakdown } from '@/llm/pricing/cost-calculator';

export interface UsageDeps {
  readonly sessionManager: SessionManager;
  /** Currently-active backend — used to route OpenRouter pricing. */
  readonly currentBackend: () => string;
}

const USAGE_NAME = 'usage';
const USAGE_DESCRIPTION = 'Show cross-session token usage and cost dashboard';
const USAGE_USAGE = '/usage';

export function createUsageCommand(deps: UsageDeps): SlashCommand {
  const { sessionManager, currentBackend } = deps;
  return {
    name: USAGE_NAME,
    description: USAGE_DESCRIPTION,
    usage: USAGE_USAGE,
    execute: async (_args: string, ctx: CommandContext): Promise<void> => {
      if (ctx.showOverlay !== undefined) {
        ctx.showOverlay('usage');
        return;
      }

      // Headless fallback — print a one-line summary.
      try {
        const byModel = sessionManager.aggregateUsageByModel();
        const backend = currentBackend();
        let totalCost = 0;
        let totalTokens = 0;
        const sessions = new Set<string>();
        for (const row of byModel) {
          const pricing = resolvePrice(backend, row.model);
          const c = computeCostBreakdown(
            {
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              cachedInputTokens: row.cachedTokens,
            },
            pricing,
          );
          totalCost += c.total;
          totalTokens += row.inputTokens + row.outputTokens;
          sessions.add(row.model);
        }
        ctx.print(
          `Usage: $${totalCost.toFixed(4)} · ${totalTokens.toLocaleString('en-US')} tokens · ${byModel.length} model(s)`,
        );
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`/usage failed: ${msg}`);
      }
    },
  };
}
