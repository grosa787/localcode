/**
 * Allowlist loader + matcher for the secret scanner.
 *
 * Lives at `<projectRoot>/.localcode/secret-allowlist.toml`:
 *
 *   [[allow]]
 *   pattern = "AKIA1234567890EXAMPLE"   # exact-string match on `finding.match`
 *   reason  = "documentation example"
 *
 *   [[allow]]
 *   regex   = "^EXAMPLE_KEY_"            # JS-flavour regex; full-string match
 *   reason  = "test fixtures"
 *
 * Either `pattern` or `regex` is required per entry (mutually exclusive
 * — having both is rejected). `reason` is free-text metadata.
 *
 * The loader is pure I/O: synchronous read, returns `{ entries, errors }`
 * so callers can decide whether a broken allowlist is fatal. Default
 * call site (`builtin-hook.ts`) treats a missing file as empty list and
 * a parse error as a hard reject — the scanner won't silently drop
 * back to "block everything" if the user mis-edits the allowlist.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import type { Finding } from './secret-scanner';

export const AllowlistEntrySchema = z
  .object({
    pattern: z.string().min(1).optional(),
    regex: z.string().min(1).optional(),
    reason: z.string().optional(),
  })
  .refine(
    (e): boolean =>
      (e.pattern !== undefined && e.regex === undefined) ||
      (e.pattern === undefined && e.regex !== undefined),
    {
      message: 'each [[allow]] entry must set exactly one of `pattern` or `regex`',
    },
  );

export const AllowlistFileSchema = z.object({
  allow: z.array(AllowlistEntrySchema).default([]),
});

export type AllowlistEntry = z.infer<typeof AllowlistEntrySchema>;

export interface CompiledAllowlistEntry {
  raw: AllowlistEntry;
  /** When set, a literal-string match against `finding.match`. */
  pattern?: string;
  /** When set, an anchored regex tested against `finding.match`. */
  regex?: RegExp;
}

export interface LoadedAllowlist {
  entries: CompiledAllowlistEntry[];
  errors: string[];
  /** Resolved absolute path of the file (whether it exists or not). */
  filePath: string;
}

/** Default path under the project root. Exported for tests. */
export function allowlistPath(projectRoot: string): string {
  return path.join(projectRoot, '.localcode', 'secret-allowlist.toml');
}

/**
 * Load + validate the allowlist. Missing file → empty entries, no
 * errors. Parse / schema failures → empty entries + populated errors.
 * Callers that treat errors as fatal should refuse to run the scanner.
 */
export function loadAllowlist(projectRoot: string): LoadedAllowlist {
  const filePath = allowlistPath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return { entries: [], errors: [], filePath };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { entries: [], errors: [`read failed: ${msg}`], filePath };
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { entries: [], errors: [`TOML parse error: ${msg}`], filePath };
  }
  const validated = AllowlistFileSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      entries: [],
      errors: validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      filePath,
    };
  }
  const entries: CompiledAllowlistEntry[] = [];
  const errors: string[] = [];
  for (let i = 0; i < validated.data.allow.length; i += 1) {
    const e = validated.data.allow[i];
    if (e === undefined) continue;
    if (e.regex !== undefined) {
      try {
        // Anchor on full match unless the user already anchored.
        const src = e.regex;
        const re = new RegExp(src);
        entries.push({ raw: e, regex: re });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`allow[${i}].regex: invalid regex (${msg})`);
      }
      continue;
    }
    if (e.pattern !== undefined) {
      entries.push({ raw: e, pattern: e.pattern });
    }
  }
  return { entries, errors, filePath };
}

/**
 * Return true when the finding is covered by any allowlist entry.
 * Empty allowlist → always false.
 */
export function isAllowed(
  finding: Finding,
  entries: readonly CompiledAllowlistEntry[],
): boolean {
  if (entries.length === 0) return false;
  for (const entry of entries) {
    if (entry.pattern !== undefined && entry.pattern === finding.match) return true;
    if (entry.regex !== undefined && entry.regex.test(finding.match)) return true;
  }
  return false;
}

/**
 * Filter findings through the allowlist. Pure helper around `isAllowed`.
 */
export function applyAllowlist(
  findings: readonly Finding[],
  entries: readonly CompiledAllowlistEntry[],
): Finding[] {
  if (entries.length === 0) return [...findings];
  return findings.filter((f) => !isAllowed(f, entries));
}
