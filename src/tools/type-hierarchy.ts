/**
 * `type_hierarchy` tool — ancestors / descendants / siblings of a class
 * or interface, as captured by the ontology indexer's `extends` /
 * `implements` edges.
 *
 * Read-only, single-phase, no approval.
 */

import { z } from 'zod';

import { typeHierarchy } from '@/ontology/queries';

import { narrowOntologyContext } from './find-call-sites';
import type { ToolContext, ToolResult } from './types';

export const TypeHierarchyArgsSchema = z.object({
  typeName: z.string().min(1, 'typeName must be a non-empty string'),
});

export type TypeHierarchyArgs = z.infer<typeof TypeHierarchyArgsSchema>;

export async function typeHierarchyTool(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = TypeHierarchyArgsSchema.safeParse(args);
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
  const report = typeHierarchy(ont, parsed.data.typeName);
  return { success: true, output: JSON.stringify(report, null, 2) };
}
