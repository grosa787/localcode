/**
 * /ontology — read-only window into the process-wide ontology indexer.
 *
 * Subcommands:
 *   - `/ontology status`           — symbol + edge counts, in-flight flag,
 *                                    last-built timestamp.
 *   - `/ontology refresh`          — kick a re-index pass (fire-and-forget).
 *   - `/ontology graph <symbol>`   — ASCII sketch of the symbol's
 *                                    incoming / outgoing neighbours.
 *
 * The command never touches the LLM — it only prints to the chat log
 * via `ctx.print` and (for `graph`) opens the OntologyGraph overlay.
 */

import type { CommandContext, SlashCommand } from '@/types/global';

import type { OntologyIndexerLike } from '@/tools/find-call-sites';

/**
 * Minimal subset of the indexer the command actually needs. Mirrors
 * `OntologyIndexerLike` but adds the optional `indexProject` trigger
 * so `/ontology refresh` works without dragging the full indexer
 * surface into the command boundary.
 */
export interface OntologyCommandIndexer extends OntologyIndexerLike {
  /** Kick a re-index pass. Resolves to `false` if a scan is already running. */
  indexProject?: () => Promise<boolean>;
}

export interface OntologyCommandDeps {
  /**
   * Accessor for the live indexer. Returns `null` when the indexer
   * hasn't been wired yet (start-up race or host without ontology).
   */
  getIndexer: () => OntologyCommandIndexer | null;
  /**
   * Optional overlay opener used by `/ontology graph <symbol>`. When
   * unset the command falls back to ASCII output through `ctx.print`.
   */
  openGraph?: (symbol: string) => void;
}

export function createOntologyCommand(
  deps: OntologyCommandDeps,
): SlashCommand {
  return {
    name: 'ontology',
    description:
      'Inspect the background ontology index (status / refresh / graph).',
    usage: '/ontology [status|refresh|graph <symbol>]',
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      const [subcommand, ...rest] = trimmed.length === 0 ? ['status'] : trimmed.split(/\s+/);
      const indexer = deps.getIndexer();

      if (indexer === null) {
        ctx.print('Ontology indexer is not wired in this build.');
        return;
      }

      switch (subcommand) {
        case 'status': {
          const ont = indexer.current;
          const built =
            ont.builtAt === 0
              ? 'never'
              : new Date(ont.builtAt).toISOString();
          ctx.print(
            `Ontology: ${ont.symbols.size} symbols, ${ont.edges.length} edges`,
          );
          ctx.print(`  Last built: ${built}`);
          ctx.print(`  Indexing:   ${indexer.isIndexing ? 'yes' : 'no'}`);
          ctx.print(`  Tracked files: ${ont.fileMtimes.size}`);
          return;
        }
        case 'refresh': {
          if (typeof indexer.indexProject !== 'function') {
            ctx.print('Refresh not available on the wired indexer.');
            return;
          }
          ctx.print('Ontology re-index queued.');
          try {
            await indexer.indexProject();
            ctx.print('Ontology re-index complete.');
          } catch (err) {
            ctx.print(
              `Ontology re-index failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          return;
        }
        case 'graph': {
          const symbolName = rest.join(' ').trim();
          if (symbolName.length === 0) {
            ctx.print('Usage: /ontology graph <symbol>');
            return;
          }
          if (deps.openGraph !== undefined) {
            deps.openGraph(symbolName);
            return;
          }
          // Fallback: ASCII sketch via ctx.print.
          const ont = indexer.current;
          const matches = [...ont.symbols.values()].filter(
            (s) => s.name === symbolName,
          );
          if (matches.length === 0) {
            ctx.print(`No symbol named "${symbolName}" in the ontology.`);
            return;
          }
          for (const sym of matches) {
            ctx.print(`${sym.kind} ${sym.name} (${sym.file}:${sym.line})`);
            const incoming = ont.edges.filter((e) => e.to === sym.id);
            const outgoing = ont.edges.filter((e) => e.from === sym.id);
            if (incoming.length > 0) {
              ctx.print('  Incoming:');
              for (const e of incoming.slice(0, 10)) {
                ctx.print(`    ${e.kind} ← ${e.from}`);
              }
              if (incoming.length > 10) {
                ctx.print(`    … ${incoming.length - 10} more`);
              }
            }
            if (outgoing.length > 0) {
              ctx.print('  Outgoing:');
              for (const e of outgoing.slice(0, 10)) {
                ctx.print(`    ${e.kind} → ${e.to}`);
              }
              if (outgoing.length > 10) {
                ctx.print(`    … ${outgoing.length - 10} more`);
              }
            }
          }
          return;
        }
        default: {
          ctx.print(
            `Unknown subcommand "${subcommand}". Try: status, refresh, graph <symbol>.`,
          );
        }
      }
    },
  };
}
