/**
 * /perf (alias /tokens) — open the live token-visualiser overlay.
 *
 * Shows ASCII sparklines for the last N turns' tokens-in / tokens-out /
 * duration / cache-hit, plus a live tokens-per-second gauge during
 * streaming.
 */

import type { SlashCommand, CommandContext } from '@/types/global';

const PERF_DESCRIPTION = 'Show live token throughput, cache-hit, and latency sparklines';

export function createPerfCommand(name: 'perf' | 'tokens' = 'perf'): SlashCommand {
  const usage = `/${name}`;
  return {
    name,
    description: PERF_DESCRIPTION,
    usage,
    execute: async (_args: string, ctx: CommandContext): Promise<void> => {
      if (ctx.showOverlay !== undefined) {
        ctx.showOverlay('perf');
        return;
      }
      ctx.print('Token visualiser is only available in interactive mode.');
    },
  };
}
