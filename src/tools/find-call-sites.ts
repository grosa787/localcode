/**
 * `find_call_sites` tool — surface every caller of a symbol via the
 * background-indexed ontology graph. Read-only, single-phase, no
 * approval.
 *
 * When the ontology isn't ready (no indexer wired or no scan yet) the
 * tool returns `{ success: false, error: 'Ontology not ready' }` so
 * the model knows to fall back to `find_symbol`.
 */

import { z } from 'zod';

import { findCallSites, type FindCallSitesOpts } from '@/ontology/queries';
import type { Ontology } from '@/ontology/types';

import type { ToolContext, ToolResult } from './types';

/** Zod schema for `find_call_sites` arguments. */
export const FindCallSitesArgsSchema = z.object({
  symbol: z.string().min(1, 'symbol must be a non-empty string'),
  scope: z.enum(['project', 'file']).optional(),
  filePath: z.string().optional(),
});

export type FindCallSitesArgs = z.infer<typeof FindCallSitesArgsSchema>;

/**
 * Narrow shape of the ontology indexer the tool actually consumes —
 * just enough to read the current graph snapshot and the in-flight
 * indexing flag. Keeping the contract tiny lets tests stub it with a
 * hand-rolled object without pulling in the full `OntologyIndexer`.
 */
export interface OntologyIndexerLike {
  readonly current: Ontology;
  readonly isIndexing: boolean;
}

/**
 * Type-guard wrapper around `ctx.ontology`. The field is `unknown` on
 * the shared ToolContext (to avoid an import cycle); we re-narrow it
 * structurally here.
 */
function narrowOntology(
  value: unknown,
): OntologyIndexerLike | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const v = value as { current?: unknown; isIndexing?: unknown };
  if (v.current === null || typeof v.current !== 'object') return null;
  const cur = v.current as { symbols?: unknown };
  if (!(cur.symbols instanceof Map)) return null;
  return value as OntologyIndexerLike;
}

export async function findCallSitesTool(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = FindCallSitesArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  const indexer = narrowOntology(ctx.ontology);
  if (indexer === null) {
    return {
      success: false,
      output: '',
      error: 'Ontology not ready',
    };
  }
  const ont = indexer.current;
  if (ont.symbols.size === 0) {
    return {
      success: false,
      output: '',
      error: 'Ontology not ready',
    };
  }

  const opts: FindCallSitesOpts = {};
  if (parsed.data.filePath !== undefined) opts.filePath = parsed.data.filePath;
  const result = findCallSites(ont, parsed.data.symbol, opts);

  const payload = {
    symbol: parsed.data.symbol,
    matches: result.matches,
    truncated: result.truncated === true,
    totalCount: result.totalCount,
  };

  return {
    success: true,
    output: JSON.stringify(payload, null, 2),
  };
}

/**
 * Re-narrow `ctx.ontology` to the structural shape the ontology tools
 * share. Exported so `impacts_of` and `type_hierarchy` use the same
 * runtime check without re-implementing it.
 */
export function narrowOntologyContext(
  value: unknown,
): OntologyIndexerLike | null {
  return narrowOntology(value);
}
