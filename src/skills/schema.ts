/**
 * Zod schema for the *extended* skill frontmatter contract.
 *
 * The base skill parser in `./skill-parser.ts` stays dependency-free
 * (no Zod) so we don't introduce a runtime cost on the hot skill-load
 * path. This module provides the optional `triggers` field used by the
 * auto-suggest engine (`./auto-suggest.ts`). The schema is intentionally
 * permissive — bad regex patterns are caught at compile time by the
 * suggester (with a console.warn) rather than rejected here, so a single
 * typo in one skill's frontmatter doesn't poison the whole skill list.
 *
 * Contract:
 *   - `triggers` — optional `string[]` of regex pattern source strings.
 *                  Patterns are matched (case-insensitive) against the
 *                  raw user input. Absence ⇒ the skill is never
 *                  auto-suggested.
 *
 * This file is the canonical declaration of the triggers field; the
 * `SkillTriggers` TypeScript type is re-exported so callers can refer
 * to it from anywhere without re-declaring.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------

/**
 * Optional `triggers: string[]` frontmatter field. Each entry is a regex
 * source string (without delimiters) — e.g. `"\\breact\\b"`.
 */
export const SkillTriggersSchema = z.array(z.string()).optional();

/** Inferred TypeScript type — equivalent to `string[] | undefined`. */
export type SkillTriggers = z.infer<typeof SkillTriggersSchema>;

/**
 * Convenience parse helper. Returns the validated array or `undefined`
 * on any failure; never throws. Use this when accepting `triggers` from
 * an untyped source (JSON, TOML, frontmatter-extracted value).
 */
export function parseSkillTriggers(input: unknown): SkillTriggers {
  const parsed = SkillTriggersSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
