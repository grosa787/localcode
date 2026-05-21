/**
 * `impacts_of` tool — transitive blast-radius of a symbol. Walks the
 * ontology in reverse (callers + references + extends + implements +
 * uses-type) up to `maxDepth` hops and returns the affected set.
 *
 * Read-only, single-phase, no approval.
 */

import { z } from 'zod';

import { impactsOf, type ImpactsOfOpts } from '@/ontology/queries';

import { narrowOntologyContext } from './find-call-sites';
import type { ToolContext, ToolResult } from './types';

export const ImpactsOfArgsSchema = z.object({
  symbol: z.string().min(1, 'symbol must be a non-empty string'),
  maxDepth: z.number().int().min(1).max(8).optional(),
});

export type ImpactsOfArgs = z.infer<typeof ImpactsOfArgsSchema>;

export async function impactsOfTool(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = ImpactsOfArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  const indexer = narrowOntologyContext(ctx.ontology);
  if (indexer === null) {
    return { success: false, output: '', error: 'Ontology not ready' };
  }
  const ont = indexer.current;
  if (ont.symbols.size === 0) {
    return { success: false, output: '', error: 'Ontology not ready' };
  }

  const opts: ImpactsOfOpts = {};
  if (parsed.data.maxDepth !== undefined) opts.maxDepth = parsed.data.maxDepth;
  const report = impactsOf(ont, parsed.data.symbol, opts);
  const payload = {
    rootSymbol: report.rootSymbol,
    affected: report.affected,
    totalCount: report.totalCount,
    truncated: report.truncated === true,
  };
  return { success: true, output: JSON.stringify(payload, null, 2) };
}
