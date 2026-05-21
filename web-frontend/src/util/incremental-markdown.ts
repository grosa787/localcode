/**
 * Incremental markdown stable-boundary detection.
 *
 * Streaming LLM output appends chunks to a growing string. Re-parsing the
 * full source on every chunk is O(N) per chunk → O(N²) over the stream.
 * For a 2000-line response at ~30 chunks/sec that is 60K lines parsed
 * per second, which dominates the React render budget.
 *
 * Strategy: find the highest character offset in `source` such that the
 * prefix is *parser-stable* — appending more characters cannot change
 * how the prefix is tokenised. A stable boundary is:
 *
 *   - a line index that is NOT inside an open code fence, AND
 *   - the line is blank (i.e. it ends a block in markdown), AND
 *   - we are not in the middle of a table (header+separator+body run).
 *
 * Given the boundary, callers parse the prefix ONCE and cache the result;
 * for subsequent renders they only re-parse `source.slice(boundary)`.
 *
 * Pure functions live here so we can test the algorithm independently of
 * React. The cache itself is held by the `Markdown` component via a
 * `useRef`, keyed on the prefix.
 */

/**
 * Find the byte offset at which `source` is parser-stable.
 *
 * Returns 0 when the source has no committed block boundary yet — in
 * that case callers should fall back to a full parse.
 *
 * Invariants:
 *   - The returned offset is `<= source.length`.
 *   - `source.slice(0, offset)` is guaranteed to round-trip through the
 *     block parser unchanged regardless of what is appended afterwards.
 *   - Triple-backtick fence parity is tracked: a boundary inside an open
 *     fence is rejected because the fence may still close further down.
 *   - GFM table header+separator pairs are treated as atomic — we never
 *     split between a header row and its separator.
 */
export function findStableBoundary(source: string): number {
  if (source.length === 0) return 0;

  const normalised = source.replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');

  // Walk lines; track fence parity. Record the END offset (in normalised
  // source) of every blank line found while OUTSIDE a fence, that is not
  // immediately followed by a table separator opportunity.
  let inFence = false;
  let offset = 0;
  let lastStable = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineLen = line.length;
    // Toggle fence parity on triple-backtick lines (with optional info).
    if (/^```/.test(line)) {
      inFence = !inFence;
      // Advance over this line + newline (if not the last line).
      offset += lineLen + (i < lines.length - 1 ? 1 : 0);
      continue;
    }
    // A blank line outside a fence is a candidate boundary — but only if
    // the NEXT line isn't a table separator (which would mean the line
    // just before the blank was actually a paragraph that mustn't merge
    // with the upcoming table). Blank lines safely terminate any block
    // we currently emit (paragraph/list/blockquote), so the prefix up to
    // and including this blank line is stable.
    if (!inFence && line.trim().length === 0) {
      // Include this newline in the stable prefix so the next parse
      // continues from the line AFTER the blank.
      const candidate = offset + lineLen + (i < lines.length - 1 ? 1 : 0);
      // Don't strand the source mid-document — only mark stable when
      // there is at least ONE more line after the blank, otherwise we
      // gain nothing (cached prefix == full source, no tail to parse).
      if (candidate < normalised.length) {
        lastStable = candidate;
      }
    }
    offset += lineLen + (i < lines.length - 1 ? 1 : 0);
  }

  return lastStable;
}

/**
 * Cache entry held by the `Markdown` component. Stores:
 *   - the byte length of the prefix that has been parsed and rendered;
 *   - a hash of the prefix so we can cheaply detect a stream restart;
 *   - the React node tree for the stable prefix.
 *
 * The actual cached node tree is opaque to this module (it lives in the
 * caller). We expose only the validation helpers.
 */
export interface IncrementalCacheKey {
  readonly prefixLength: number;
  readonly prefixHash: number;
}

/**
 * FNV-1a 32-bit hash. Cheap and good-enough for cache invalidation —
 * a collision would only show an incorrect render until the next chunk,
 * and the probability for the very-short prefixes we cache is negligible.
 */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Decide whether `cached` is still valid for `source`.
 *
 * Valid iff `source` starts with the exact prefix that was cached. We
 * verify by re-hashing `source.slice(0, prefixLength)` and comparing.
 *
 * Returns false when:
 *   - the source shrank (stream restart, user cleared);
 *   - the source diverged within the cached prefix (edit);
 *   - the cache is empty (`prefixLength === 0`).
 */
export function isCacheValid(
  cached: IncrementalCacheKey | null,
  source: string,
): boolean {
  if (cached === null) return false;
  if (cached.prefixLength === 0) return false;
  if (source.length < cached.prefixLength) return false;
  const prefix = source.slice(0, cached.prefixLength);
  return fnv1a(prefix) === cached.prefixHash;
}
