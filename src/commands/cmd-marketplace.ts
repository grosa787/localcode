/**
 * Marketplace slash commands — `/skills browse` + `/mcp browse`.
 *
 * Both commands:
 *   1. Fetch the upstream catalog (with cache) and print a one-line
 *      summary into the chat transcript.
 *   2. Hand control to the host so it can open `MarketplaceOverlay`.
 *      The overlay itself owns navigation + install hotkeys; we provide
 *      the install plumbing via deps so the command stays
 *      composition-free.
 *
 * When the host can't open an overlay (test harnesses, headless web
 * runtimes) the command degrades to printing the first N entries so
 * the user still sees the catalog. Install via the overlay only;
 * keystroke parsing isn't done here.
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import type {
  MarketplaceFetchOpts,
  MarketplaceFetchResult,
  MarketplaceMcpServer,
  MarketplaceSkill,
} from '@/marketplace/types';

const SKILLS_NAME = 'skills';
const SKILLS_DESCRIPTION = 'Browse and install skills from the Anthropic catalog.';
const SKILLS_USAGE = '/skills browse';

const MCP_NAME = 'mcp';
const MCP_DESCRIPTION = 'Browse and install MCP servers from the modelcontextprotocol/servers catalog.';
const MCP_USAGE = '/mcp browse';

export interface SkillsBrowseDeps {
  /** Fetch the catalog — typically `fetchSkillCatalog`. Injectable for tests. */
  fetchCatalog: (
    opts?: MarketplaceFetchOpts,
  ) => Promise<MarketplaceFetchResult<MarketplaceSkill>>;
  /**
   * Open the marketplace overlay. Host injects a function that mounts
   * `MarketplaceOverlay` with the supplied entries + install callbacks.
   * When omitted the command falls back to printing into the transcript.
   */
  openMarketplace?: (payload: {
    mode: 'skills';
    result: MarketplaceFetchResult<MarketplaceSkill>;
  }) => void;
}

export interface McpBrowseDeps {
  fetchCatalog: (
    opts?: MarketplaceFetchOpts,
  ) => Promise<MarketplaceFetchResult<MarketplaceMcpServer>>;
  openMarketplace?: (payload: {
    mode: 'mcp';
    result: MarketplaceFetchResult<MarketplaceMcpServer>;
  }) => void;
}

/**
 * Build the `/skills browse` slash command. The host wires
 * `fetchCatalog` to `fetchSkillCatalog` from `@/marketplace/skills-fetcher`
 * and supplies `openMarketplace` from `app.tsx` so the overlay opens.
 *
 * The command name MUST be `skills` (not `skills-browse`) so the user
 * can type `/skills browse` matching the spec. Subcommand parsing lives
 * here so we don't have to register two distinct commands.
 */
export function createSkillsBrowseCommand(deps: SkillsBrowseDeps): SlashCommand {
  return {
    name: SKILLS_NAME,
    description: SKILLS_DESCRIPTION,
    usage: SKILLS_USAGE,
    execute: async (rawArgs: string, ctx: CommandContext): Promise<void> => {
      const args = rawArgs.trim().split(/\s+/).filter((s) => s.length > 0);
      const sub = args[0] ?? '';
      if (sub.length === 0) {
        ctx.print(`Usage: ${SKILLS_USAGE}`);
        return;
      }
      if (sub !== 'browse') {
        ctx.print(`Unknown subcommand: /skills ${sub}`);
        ctx.print(`Usage: ${SKILLS_USAGE}`);
        return;
      }

      ctx.print('Fetching skills catalog…');
      let result: MarketplaceFetchResult<MarketplaceSkill>;
      try {
        result = await deps.fetchCatalog();
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to fetch skills catalog: ${msg}`);
        return;
      }

      if (deps.openMarketplace !== undefined) {
        deps.openMarketplace({ mode: 'skills', result });
        return;
      }

      // Headless fallback: print summary.
      printSummary(ctx, result, 'skills');
    },
  };
}

/**
 * Build the `/mcp browse` slash command. Symmetric with
 * `createSkillsBrowseCommand`.
 */
export function createMcpBrowseCommand(deps: McpBrowseDeps): SlashCommand {
  return {
    name: MCP_NAME,
    description: MCP_DESCRIPTION,
    usage: MCP_USAGE,
    execute: async (rawArgs: string, ctx: CommandContext): Promise<void> => {
      const args = rawArgs.trim().split(/\s+/).filter((s) => s.length > 0);
      const sub = args[0] ?? '';
      if (sub.length === 0) {
        ctx.print(`Usage: ${MCP_USAGE}`);
        return;
      }
      if (sub !== 'browse') {
        ctx.print(`Unknown subcommand: /mcp ${sub}`);
        ctx.print(`Usage: ${MCP_USAGE}`);
        return;
      }

      ctx.print('Fetching MCP server catalog…');
      let result: MarketplaceFetchResult<MarketplaceMcpServer>;
      try {
        result = await deps.fetchCatalog();
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to fetch MCP catalog: ${msg}`);
        return;
      }

      if (deps.openMarketplace !== undefined) {
        deps.openMarketplace({ mode: 'mcp', result });
        return;
      }

      printSummary(ctx, result, 'mcp');
    },
  };
}

function printSummary(
  ctx: CommandContext,
  result: MarketplaceFetchResult<MarketplaceSkill | MarketplaceMcpServer>,
  label: 'skills' | 'mcp',
): void {
  if (result.rateLimited) {
    ctx.print(
      'GitHub rate-limit reached — showing cached entries (60 req/hr unauthenticated).',
    );
  } else if (result.stale) {
    ctx.print('Upstream unreachable — showing cached entries.');
  }
  if (result.entries.length === 0) {
    ctx.print(`No ${label} found.`);
    return;
  }
  ctx.print(`${result.entries.length} ${label} available:`);
  const limit = 20;
  for (const entry of result.entries.slice(0, limit)) {
    const desc =
      entry.description.length > 60
        ? `${entry.description.slice(0, 60)}…`
        : entry.description;
    ctx.print(`  ${entry.id}  ${desc}`);
  }
  if (result.entries.length > limit) {
    ctx.print(`  …and ${result.entries.length - limit} more.`);
  }
}
