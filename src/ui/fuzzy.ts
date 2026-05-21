/**
 * Hand-rolled fuzzy sub-sequence matcher used by `<CommandPalette>`.
 *
 * Design goals:
 *   - No external dependency (fzf, fuse.js, fuzzysort) so it ships with
 *     the embedded TUI binary and adds zero install weight.
 *   - Returns matched character indices so the renderer can paint
 *     highlights (`--accent` on matched chars, muted on the rest).
 *   - Tuned for the kinds of inputs the palette serves: short
 *     identifiers (command names like "permissions"), file paths
 *     ("src/ui/screens/ChatScreen.tsx"), and human-readable session
 *     titles ("Fixing the OpenRouter 429 handler"). Bonuses reward the
 *     common access patterns: prefix matches, CamelCase / snake_case
 *     boundary jumps, consecutive runs.
 *
 * Scoring (sketch — keep predictable, no magic numbers buried in code):
 *   - Base       +1 per matched character.
 *   - Consecutive run multiplier — back-to-back matches in the haystack
 *     score 1.5x for the second, 2x for the third, capped at 3x. This
 *     is the main signal that distinguishes "foo bar baz" matching
 *     "fbb" (three jumps) from "foobar" matching "foo" (one solid run).
 *   - CamelCase / boundary jump — when a non-leading match lands on
 *     a CamelCase or after a separator (`-`, `_`, `/`, ` `, `.`), add
 *     a bonus. Lets "CP" match "CommandPalette" cleanly.
 *   - Prefix bonus — a match at index 0 adds an extra bonus on top.
 *     Means "perm" preferentially ranks `/permissions` over a session
 *     titled "Bug in permissions overlay".
 *   - First-char miss penalty — if the first query char doesn't match
 *     the first haystack char, we don't penalise here — the prefix
 *     bonus above is enough signal.
 *
 * The implementation is greedy left-to-right rather than full
 * Smith-Waterman dynamic programming. For the palette's haystack
 * lengths (tens of chars) this is indistinguishable in quality from
 * full DP and runs in O(needle * haystack) memory-free.
 */

export interface FuzzyMatch {
  /** Total score; higher is better. 0 means no match. */
  readonly score: number;
  /**
   * Indices into the haystack string where each query character
   * matched. Length equals the (case-folded) query length, or empty
   * if the query is empty or there was no match.
   */
  readonly matchedIndices: readonly number[];
}

const ZERO_MATCH: FuzzyMatch = { score: 0, matchedIndices: [] };

/** Characters treated as word boundaries for the CamelCase bonus. */
const BOUNDARY_CHARS = new Set<string>(['-', '_', '/', ' ', '.', ':']);

/**
 * Case-insensitive sub-sequence fuzzy match.
 *
 * @returns `{ score, matchedIndices }`. `score === 0` when the query
 *          doesn't fit as a sub-sequence of the haystack (caller should
 *          drop the row). Empty query → `{ score: 0, matchedIndices: [] }`.
 */
export function fuzzyMatch(query: string, haystack: string): FuzzyMatch {
  if (query.length === 0 || haystack.length === 0) return ZERO_MATCH;

  const q = query.toLowerCase();
  const h = haystack.toLowerCase();

  const indices: number[] = [];
  let score = 0;
  let runLength = 0;
  let hIdx = 0;

  for (let qIdx = 0; qIdx < q.length; qIdx++) {
    const qc = q[qIdx];
    if (qc === undefined) return ZERO_MATCH;

    // Advance the haystack cursor to the next occurrence of qc.
    let found = -1;
    while (hIdx < h.length) {
      if (h[hIdx] === qc) {
        found = hIdx;
        hIdx++;
        break;
      }
      hIdx++;
    }
    if (found === -1) {
      // Query character did not appear in the remainder of the
      // haystack — overall match fails.
      return ZERO_MATCH;
    }

    indices.push(found);

    // Base score per matched character.
    let charScore = 1;

    // Consecutive-run multiplier — reward solid spans over scattered jumps.
    const prev = indices[indices.length - 2];
    const isConsecutive = prev !== undefined && found === prev + 1;
    if (isConsecutive) {
      runLength++;
      // Multiplier ramps 1.5 → 2 → 3 → 3 (cap).
      const multiplier = Math.min(1 + 0.5 * runLength, 3);
      charScore *= multiplier;
    } else {
      runLength = 0;
    }

    // Boundary / CamelCase bonus — a match that lands on the first
    // letter of a new "word" inside the haystack is worth more.
    if (found === 0) {
      // Prefix bonus on top of the base.
      charScore += 3;
    } else {
      const prevChar = haystack[found - 1];
      const thisChar = haystack[found];
      if (prevChar !== undefined && BOUNDARY_CHARS.has(prevChar)) {
        charScore += 2;
      } else if (
        prevChar !== undefined &&
        thisChar !== undefined &&
        prevChar === prevChar.toLowerCase() &&
        thisChar !== thisChar.toLowerCase() &&
        thisChar === thisChar.toUpperCase()
      ) {
        // CamelCase: previous lowercase, this uppercase.
        charScore += 2;
      }
    }

    score += charScore;
  }

  // Shorter haystacks at equal raw score should rank higher — the
  // user gets to the result faster. Small tie-breaker, not enough to
  // overwhelm any of the bonuses above.
  score += Math.max(0, 5 - haystack.length / 10);

  return { score, matchedIndices: indices };
}

/**
 * Convenience: rank a list of items by their fuzzy score against the
 * query. Items with `score === 0` are dropped. The returned list is
 * sorted descending by score; ties are broken by original index for
 * stable output (so the caller can pre-sort by recency / priority and
 * trust that ordering to survive a tie).
 *
 * Each result carries the source `item` plus the `match` so callers
 * can render highlights without re-running the matcher.
 */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  toHaystack: (item: T) => string,
): Array<{ readonly item: T; readonly match: FuzzyMatch }> {
  if (query.trim().length === 0) {
    return items.map((item) => ({
      item,
      match: { score: 0, matchedIndices: [] },
    }));
  }
  const scored: Array<{
    readonly item: T;
    readonly match: FuzzyMatch;
    readonly orig: number;
  }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    const haystack = toHaystack(item);
    const match = fuzzyMatch(query, haystack);
    if (match.score > 0) scored.push({ item, match, orig: i });
  }
  scored.sort((a, b) => {
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    return a.orig - b.orig;
  });
  return scored.map(({ item, match }) => ({ item, match }));
}

/**
 * Returns true when the haystack character at `idx` was matched by the
 * given query. Used by the renderer to decide whether to highlight a
 * cell. O(matched.length); the matched array is tiny.
 */
export function isMatched(
  match: FuzzyMatch,
  idx: number,
): boolean {
  return match.matchedIndices.includes(idx);
}
