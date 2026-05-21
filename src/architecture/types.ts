/**
 * Architecture-rule types.
 *
 * `.localcode/arch.toml` declares layering rules. Each rule binds a glob
 * (`match`) to a list of forbidden import prefixes (`forbid`). When a
 * source file matching a rule imports a path resolving under any of the
 * forbidden prefixes, a violation is produced.
 *
 * `allowAll: true` short-circuits the rule — any file matching `match`
 * is whitelisted regardless of its imports (useful for tests/fixtures).
 *
 * `[global].ignoreImports` is an array of regex strings; imports whose
 * normalised module specifier matches ANY entry are skipped by the
 * validator before any per-rule check.
 */

import { z } from 'zod';

// ---------- Zod schemas ----------

/**
 * Single rule entry. `forbid` is required UNLESS `allowAll` is true.
 * The refine below enforces that XOR — keeps malformed configs from
 * silently accepting everything.
 */
export const ArchRuleSchema = z
  .object({
    id: z.string().min(1, 'rule.id must be a non-empty string'),
    description: z.string().optional(),
    match: z.string().min(1, 'rule.match must be a non-empty glob'),
    forbid: z.array(z.string().min(1)).optional(),
    allowAll: z.boolean().optional(),
    severity: z.enum(['warn', 'error']).optional(),
  })
  .refine(
    (r) =>
      r.allowAll === true ||
      (Array.isArray(r.forbid) && r.forbid.length > 0),
    {
      message: 'rule must declare either allowAll=true or a non-empty forbid list',
      path: ['forbid'],
    },
  );

export const ArchGlobalSchema = z
  .object({
    ignoreImports: z.array(z.string().min(1)).default([]),
  })
  .default({ ignoreImports: [] });

export const ArchConfigSchema = z.object({
  rule: z.array(ArchRuleSchema).default([]),
  global: ArchGlobalSchema,
});

export type ArchRule = z.infer<typeof ArchRuleSchema>;
export type ArchGlobal = z.infer<typeof ArchGlobalSchema>;
export type ArchConfig = z.infer<typeof ArchConfigSchema>;

// ---------- Domain types ----------

/**
 * A single resolved import edge — produced by `extractImports`. Carries
 * both the raw source specifier (what appeared in the file) and the
 * resolved absolute path (after tsconfig `paths` and `.ts`/`.tsx`
 * resolution). `resolvedAbsolute` is null when the specifier could not
 * be resolved to a file under `projectRoot` (e.g. bare npm imports,
 * builtin modules).
 */
export interface ImportEdge {
  readonly sourceFile: string;
  readonly specifier: string;
  readonly resolvedAbsolute: string | null;
  readonly line: number;
}

/**
 * Recorded layering violation. `resolvedTarget` is null for forbidden
 * imports that hit a bare specifier (e.g. forbidding `node:fs` for an
 * isolated layer); otherwise it is the absolute project-relative path
 * the import resolved to.
 */
export interface ArchViolation {
  readonly ruleId: string;
  readonly sourceFile: string;
  readonly importPath: string;
  readonly resolvedTarget: string | null;
  readonly line: number;
  readonly severity: 'warn' | 'error';
}
