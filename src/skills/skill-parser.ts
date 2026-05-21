/**
 * skill-parser — read a markdown skill file and extract frontmatter + body.
 *
 * Skill files are plain markdown. An optional YAML-style frontmatter block
 * lives at the top, delimited by `---` fences:
 *
 *   ---
 *   name: My Skill
 *   description: What this skill does
 *   ---
 *
 *   ...markdown body...
 *
 * Only string values under `name:` / `description:` keys are recognized —
 * no nested objects, arrays, quotes, or multi-line values. This keeps the
 * parser dependency-free (no gray-matter / yaml package) and matches what
 * Claude-style skills use in practice.
 *
 * If the file has no frontmatter, the entire file content is treated as
 * the body and `name` is derived from the filename stem, `description` is
 * empty.
 *
 * `active` is always returned as `false` — the SkillsManager re-applies
 * the active state from its JSON store on top of what we return here.
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Skill } from '@/types/global';

/** Thrown when a skill file cannot be read or parsed. */
export class SkillParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SkillParseError';
  }
}

interface FrontmatterSplit {
  frontmatter: string | null;
  body: string;
}

/**
 * Split a file's raw text into a (frontmatter, body) pair.
 *
 * Rules:
 *   - File must begin with `---` followed by a newline to be considered
 *     to have frontmatter.
 *   - The closing `---` must appear on its own line (LF or CRLF ok).
 *   - Everything between the two fences is the frontmatter block; everything
 *     after the trailing newline of the closing fence is the body.
 *   - If no closing fence is found, the whole file is treated as body.
 */
export function splitFrontmatter(raw: string): FrontmatterSplit {
  // Normalise opening fence. Accept either LF or CRLF line endings.
  const openMatch = /^---\r?\n/.exec(raw);
  if (!openMatch) {
    return { frontmatter: null, body: raw };
  }

  const afterOpen = openMatch[0].length;
  // Look for a line containing only `---` (optionally followed by CR).
  const closeRegex = /(^|\r?\n)---\r?\n?/;
  const rest = raw.slice(afterOpen);
  const closeMatch = closeRegex.exec(rest);
  if (!closeMatch) {
    // Malformed frontmatter block — treat the whole file as body to be
    // forgiving. Callers get a best-effort skill instead of a hard error.
    return { frontmatter: null, body: raw };
  }

  const frontmatter = rest.slice(0, closeMatch.index);
  const bodyStart = closeMatch.index + closeMatch[0].length;
  const body = rest.slice(bodyStart);
  return { frontmatter, body };
}

/**
 * Parse a frontmatter block into a plain record of string values.
 *
 * Lines are split on the first `:` only; keys are lowercased for
 * case-insensitive lookup. Values are trimmed. Wrapping quotes (single or
 * double) are stripped. Lines starting with `#` or that are empty after
 * trimming are skipped. Malformed lines are silently ignored.
 */
export function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    if (key.length === 0) continue;
    let value = trimmed.slice(colon + 1).trim();
    // Strip matching surrounding quotes.
    if (value.length >= 2) {
      const first = value.charAt(0);
      const last = value.charAt(value.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read a skill markdown file from disk and return the parsed `Skill`.
 *
 * The returned skill always carries `active: false`; the SkillsManager
 * re-applies the active state from its persistent store.
 */
export async function parseSkillFile(filePath: string): Promise<Skill> {
  const absolute = path.resolve(filePath);

  let raw: string;
  try {
    raw = await fsReadFile(absolute, 'utf8');
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new SkillParseError(
      `Failed to read skill file at ${absolute}: ${msg}`,
      cause,
    );
  }

  const { frontmatter, body } = splitFrontmatter(raw);
  const fields = frontmatter !== null ? parseFrontmatter(frontmatter) : {};

  const base = path.basename(absolute);
  const id = base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base;

  const nameRaw = fields['name'];
  const descriptionRaw = fields['description'];

  // Content body: trimmed on the leading side if we stripped a frontmatter
  // block (so `--- \n\nHeading` doesn't leave a leading blank line); for
  // files without frontmatter we keep the original text verbatim.
  const content = frontmatter !== null ? body.replace(/^\r?\n+/, '') : body;

  const skill: Skill = {
    id,
    name: nameRaw && nameRaw.length > 0 ? nameRaw : id,
    description: descriptionRaw ?? '',
    content,
    active: false,
    path: absolute,
  };
  return skill;
}
