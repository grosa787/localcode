/**
 * Glob-style matcher for tool names.
 *
 * Supports:
 *   - `*`      — zero or more characters (excluding nothing; greedy)
 *   - `?`      — exactly one character
 *   - `[xy]`   — character class
 *   - `[!xy]`  — negated character class
 *
 * Anything else is escaped as a regex literal. Patterns are case-
 * sensitive — tool names are stable lowercase identifiers
 * (`write_file`, `git_status`).
 *
 * Kept narrow on purpose: we do NOT support brace expansion or `**`
 * cross-segment matching. Tool names are single-segment so the simple
 * form is enough.
 */

/**
 * Translate a hook glob into a regex source.
 *
 * Exported separately so the test suite can pin the conversion logic
 * without re-running the full matcher.
 */
export function globToRegex(pattern: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === '*') {
      out += '.*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '.';
      i += 1;
      continue;
    }
    if (ch === '[') {
      // Find the matching `]`. If not found, treat the `[` as literal.
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let cls = pattern.slice(i + 1, close);
      // Negation: leading `!` (glob style) → `^` (regex style).
      if (cls.startsWith('!')) {
        cls = `^${cls.slice(1)}`;
      }
      // Escape backslashes inside the class but keep `-` as a range
      // operator. Most regex specials lose meaning inside `[...]`.
      cls = cls.replace(/\\/g, '\\\\');
      out += `[${cls}]`;
      i = close + 1;
      continue;
    }
    // Escape regex metacharacters; everything else passes through.
    if (/[.+^${}()|\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i += 1;
  }
  out += '$';
  return new RegExp(out);
}

/**
 * `true` when `name` matches the glob `pattern`.
 *
 * An undefined / empty / `*` pattern matches everything — that's the
 * "no toolPattern in TOML" path.
 */
export function matchesGlob(pattern: string | undefined, name: string): boolean {
  if (pattern === undefined) return true;
  if (pattern.length === 0) return true;
  if (pattern === '*') return true;
  return globToRegex(pattern).test(name);
}
