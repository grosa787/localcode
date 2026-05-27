/**
 * auto-suggest — match the user's input against each skill's `triggers`
 * frontmatter and surface the matching, currently-inactive skills as
 * suggestions. User opt-in only: the caller (app.tsx) renders a toast
 * and binds Tab to activate; this module never mutates skill state.
 *
 * Skill triggers live in the markdown frontmatter as a single inline
 * line:
 *
 *   ---
 *   name: React Specialist
 *   description: ...
 *   triggers: ["\\breact\\b", "\\bhooks?\\b", "(jsx|tsx)"]
 *   ---
 *
 * Patterns are regex *source* strings (no delimiters), compiled with the
 * `i` flag (case-insensitive). Malformed patterns log a warning to
 * `console.warn` and are skipped — a single broken regex never crashes
 * the suggester or hides the rest of the matches.
 *
 * Caching strategy
 * ----------------
 *   - The compiled `RegExp` array for each skill is memoised by
 *     `skill.path` *and* `skill.content` (FNV-1a hash of the raw content).
 *     Hot-reload changes both the mtime and the content; either drift
 *     invalidates the cache entry.
 *   - The frontmatter extraction step (parsing the inline `triggers:`
 *     line) is also memoised inside the same compile path so we don't
 *     re-walk the raw file body on every keystroke.
 *
 * Ordering & cap
 * --------------
 *   - Results are sorted by trigger specificity (longer matched pattern
 *     wins) then by skill name for stable tie-breaking.
 *   - Caller-facing cap is 3 — more would clutter the chat UI and
 *     defeat the "subtle, opt-in" intent.
 */

import * as fs from 'node:fs';
import type { Skill } from '@/types/global';
import { parseSkillTriggers, type SkillTriggers } from '@/skills/schema';

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

/**
 * A single suggestion returned from {@link suggestSkillsForInput}.
 *
 *   - `skillId`     — canonical id (matches `Skill.id`).
 *   - `skillName`   — display name (matches `Skill.name`).
 *   - `reason`      — the matched substring excerpted from the input.
 *                     Trimmed and bounded at 60 chars so a wildcard
 *                     regex doesn't spew the whole message back at the
 *                     UI layer.
 */
export interface SkillSuggestion {
  readonly skillId: string;
  readonly skillName: string;
  readonly reason: string;
}

/** Maximum number of suggestions surfaced per call (UI sanity cap). */
export const MAX_SUGGESTIONS = 3;

/** Bound on the `reason` excerpt length so the toast stays one line. */
const REASON_EXCERPT_MAX = 60;

// ---------------------------------------------------------------------
// Compile cache
// ---------------------------------------------------------------------

interface CacheEntry {
  readonly contentHash: number;
  readonly patterns: readonly RegExp[];
}

/**
 * Compile cache keyed by `skill.path`. We refresh on content drift so
 * hot-reloaded skills pick up new triggers without a full process
 * restart. Exposed via {@link clearCompileCacheForTests} so the test
 * suite can isolate each case.
 */
const compileCache: Map<string, CacheEntry> = new Map();

/**
 * Best-effort FNV-1a 32-bit hash. Same algorithm used elsewhere in the
 * codebase (`src/ui/highlighting/syntax-highlight.ts`) — fast, no deps,
 * and good enough to detect content drift on the suggester hot path.
 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------

/**
 * Pull the inline `triggers: [...]` line out of a markdown file's
 * frontmatter block. Returns `undefined` when:
 *   - the file has no frontmatter,
 *   - the frontmatter has no `triggers` line,
 *   - the value parses but is not a JSON array of strings.
 *
 * The parser is deliberately tiny — we only accept a SINGLE inline JSON
 * array on the right-hand side (e.g. `triggers: ["\\breact\\b"]`). This
 * matches what the rest of the skill loader can author + read without
 * pulling in a YAML dependency.
 */
export function extractTriggersFromMarkdown(raw: string): SkillTriggers {
  // Match opening fence (LF or CRLF). Bail on absence.
  const openMatch = /^---\r?\n/.exec(raw);
  if (openMatch === null) return undefined;
  const afterOpen = openMatch[0].length;
  const rest = raw.slice(afterOpen);

  // Closing fence — start-of-line or after a newline, exactly `---`.
  const closeRegex = /(^|\r?\n)---\r?\n?/;
  const closeMatch = closeRegex.exec(rest);
  if (closeMatch === null) return undefined;
  const block = rest.slice(0, closeMatch.index);

  // Walk the block line-by-line; case-insensitive `triggers:` key.
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    if (key !== 'triggers') continue;

    const value = trimmed.slice(colon + 1).trim();
    if (value.length === 0) return undefined;

    // We support exactly one shape: an inline JSON array literal. This
    // keeps the dep-free contract while letting authors escape regex
    // chars naturally (`["\\breact\\b"]`).
    try {
      const parsed: unknown = JSON.parse(value);
      return parseSkillTriggers(parsed);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Load a skill's raw markdown (path → text) so we can extract triggers
 * that the base parser dropped. Returns `null` on any I/O error — the
 * caller treats that as "no triggers", same as a missing field.
 */
function readSkillRaw(skillPath: string): string | null {
  try {
    return fs.readFileSync(skillPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Resolve the compiled `RegExp[]` for a skill, using and updating the
 * module-level cache. Patterns that fail to compile are logged once per
 * `(path, pattern)` pair and dropped from the returned array.
 */
function getCompiledTriggers(skill: Skill): readonly RegExp[] {
  const raw = readSkillRaw(skill.path);
  if (raw === null) return [];

  const hash = fnv1a(raw);
  const cached = compileCache.get(skill.path);
  if (cached !== undefined && cached.contentHash === hash) {
    return cached.patterns;
  }

  const triggers = extractTriggersFromMarkdown(raw);
  if (triggers === undefined || triggers.length === 0) {
    compileCache.set(skill.path, { contentHash: hash, patterns: [] });
    return [];
  }

  const compiled: RegExp[] = [];
  for (const src of triggers) {
    if (typeof src !== 'string' || src.length === 0) continue;
    try {
      compiled.push(new RegExp(src, 'i'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[skills/auto-suggest] Skipping malformed trigger pattern in ${skill.id}: ${src} (${msg})`,
      );
    }
  }
  compileCache.set(skill.path, { contentHash: hash, patterns: compiled });
  return compiled;
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

interface CandidateMatch {
  readonly skill: Skill;
  readonly pattern: RegExp;
  readonly excerpt: string;
}

/**
 * Build the suggestion list for the freshly-submitted user input.
 *
 *   - Skips skills already in `activeSkillIds`.
 *   - Skips skills with no triggers (the parser surfaces `[]` for both
 *     "missing field" and "field present but invalid").
 *   - Picks the LONGEST matching pattern per skill so the reason
 *     excerpt is the most specific match available.
 *   - Cross-skill ordering: longest match across all skills wins;
 *     ties broken by skill name for determinism.
 *   - Caller-facing cap is {@link MAX_SUGGESTIONS}.
 *
 * Returns an empty array when:
 *   - `input` is empty / whitespace,
 *   - no skill has triggers,
 *   - all matching skills are already active.
 *
 * Never throws. Bad regex in a skill's frontmatter degrades to "no
 * triggers for that skill" (with a one-shot `console.warn`).
 */
export function suggestSkillsForInput(
  input: string,
  skills: readonly Skill[],
  activeSkillIds: ReadonlySet<string>,
): SkillSuggestion[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) return [];
  if (skills.length === 0) return [];

  const candidates: CandidateMatch[] = [];

  for (const skill of skills) {
    if (activeSkillIds.has(skill.id)) continue;
    const patterns = getCompiledTriggers(skill);
    if (patterns.length === 0) continue;

    // Find the LONGEST matching pattern for this skill — gives the user
    // the most informative "reason" excerpt without firing N toasts for
    // overlapping patterns.
    let best: { pattern: RegExp; matchText: string } | null = null;
    for (const pattern of patterns) {
      const m = pattern.exec(input);
      if (m === null) continue;
      const matchText = m[0];
      if (best === null || matchText.length > best.matchText.length) {
        best = { pattern, matchText };
      }
    }
    if (best === null) continue;

    const excerpt =
      best.matchText.length > REASON_EXCERPT_MAX
        ? best.matchText.slice(0, REASON_EXCERPT_MAX - 1) + '…'
        : best.matchText;

    candidates.push({
      skill,
      pattern: best.pattern,
      excerpt,
    });
  }

  // Sort: longest match wins, then skill name for stable ties.
  candidates.sort((a, b) => {
    const lenDiff = b.excerpt.length - a.excerpt.length;
    if (lenDiff !== 0) return lenDiff;
    return a.skill.name.localeCompare(b.skill.name);
  });

  return candidates.slice(0, MAX_SUGGESTIONS).map((c) => ({
    skillId: c.skill.id,
    skillName: c.skill.name,
    reason: c.excerpt,
  }));
}

// ---------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------

/**
 * Drop every entry in the compile cache. Tests call this in `beforeEach`
 * so a stale cache entry from a previous case doesn't shadow a freshly
 * authored skill file.
 */
export function clearCompileCacheForTests(): void {
  compileCache.clear();
}
