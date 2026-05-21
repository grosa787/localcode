/**
 * Incremental markdown coalescing (R-perf, 2026-05).
 *
 * Streaming assistant messages re-parse the ENTIRE accumulated buffer
 * on every chunk: the parent component holds `currentOutput` as one
 * string, and the renderer slices it into paragraphs / fenced blocks /
 * tables on each repaint. For long answers (≥1k tokens) that's a
 * meaningful per-chunk cost, even before the syntax-highlight cache
 * fires.
 *
 * Observation: paragraph boundaries (`\n\n`) are STABLE. Once the
 * stream has emitted `…paragraph 1\n\nparagraph 2\n\nparag…`, the
 * first two paragraphs cannot change — every subsequent chunk only
 * extends the tail past the last `\n\n`. So we cache:
 *
 *   - the parsed-block array for the longest `\n\n`-terminated PREFIX
 *     of the current buffer (the "committed" prefix), and
 *   - a separate light parse of the unstable TAIL past that boundary.
 *
 * The cache key is an FNV-1a hash of the committed prefix. Every time
 * the buffer extends past another `\n\n`, the new prefix-hash is
 * computed once and used to look up the cached blocks. The tail is
 * always re-parsed (it's small — bounded by the size of one paragraph)
 * so the visible streaming UI never lags behind the model.
 *
 * This file owns ONLY the boundary + cache primitives. The actual
 * block parser (markdown → blocks) lives elsewhere; this module is
 * agnostic to the block shape (`TBlock` generic) so it stays usable
 * across the TUI's plain-markdown path and the web frontend's richer
 * AST.
 *
 * Pure-function API:
 *   - `findLastParagraphBoundary(text)` → index of the last `\n\n` end,
 *     or -1 if none.
 *   - `splitStableTail(text)`            → { stable, tail }.
 *   - `createIncrementalMarkdownCache<TBlock>()` → a tiny object with
 *     `parseIncremental(buf, fullParse)` that returns the combined
 *     blocks for the whole buffer, re-parsing only the tail when the
 *     stable prefix has already been seen.
 *
 * No React, no Ink, no global mutable state outside the closure.
 */

/**
 * Returns the index ONE PAST the last `\n\n` sequence in `text`, or -1
 * if no paragraph boundary is present. A boundary at the very end of
 * the buffer (`"foo\n\n"`) counts — the prefix `"foo\n\n"` is stable
 * and any new content lands in the tail.
 *
 * We scan from the right so the typical case (a long buffer with many
 * paragraph breaks, the last of which is recent) is O(tail-length).
 */
export function findLastParagraphBoundary(text: string): number {
  if (text.length < 2) return -1;
  // Walk backwards looking for "\n\n". Note: indexOf would be fine but
  // lastIndexOf with the second-char trick avoids scanning the whole
  // string when boundaries are close to the end.
  const idx = text.lastIndexOf('\n\n');
  if (idx === -1) return -1;
  // Return the position AFTER the boundary so callers can slice
  // [0, boundary) for the stable prefix and [boundary, end) for the
  // tail without further arithmetic.
  return idx + 2;
}

/**
 * Split `text` at the last `\n\n` into `{ stable, tail }`. `stable`
 * always ends with `\n\n` (or is `''`); `tail` never contains a
 * `\n\n` sequence. Round-trip property: `stable + tail === text`.
 */
export function splitStableTail(text: string): {
  readonly stable: string;
  readonly tail: string;
} {
  const boundary = findLastParagraphBoundary(text);
  if (boundary === -1) return { stable: '', tail: text };
  return { stable: text.slice(0, boundary), tail: text.slice(boundary) };
}

/**
 * FNV-1a 32-bit hash. Copy of the one used in `syntax-highlight.ts` so
 * we don't pull a runtime dependency between two leaf modules.
 */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Public shape returned by `parseIncremental`. The caller renders by
 * concatenating `prefixBlocks` (stable) and `tailBlocks` (re-parsed
 * every chunk). They're kept separate so the React layer can apply
 * `React.memo` to the stable region — `prefixBlocks` is reference-
 * equal across chunks as long as the prefix-hash stays the same.
 */
export interface IncrementalParseResult<TBlock> {
  readonly prefixBlocks: readonly TBlock[];
  readonly tailBlocks: readonly TBlock[];
  /** The stable-prefix hash that produced `prefixBlocks`. Stable identity. */
  readonly prefixHash: string;
}

/**
 * Cache statistics — exposed for tests + future telemetry.
 */
export interface IncrementalParseStats {
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
}

/**
 * Factory for an incremental markdown parser cache. The `parse`
 * function is supplied by the caller (so this module stays agnostic
 * to the block representation); the cache only memoises the result
 * of `parse(stable)` across chunks that share the same stable prefix.
 *
 * Capped at `maxEntries` (default 64) — one cache covers a single
 * streaming message, and entries are evicted by insertion order. The
 * usual lifetime is "discarded when the assistant message commits to
 * the chat log"; the cap is just defence-in-depth so a runaway
 * paragraph-heavy answer can't OOM.
 */
export function createIncrementalMarkdownCache<TBlock>(opts?: {
  readonly maxEntries?: number;
}): {
  readonly parseIncremental: (
    buffer: string,
    fullParse: (text: string) => readonly TBlock[],
  ) => IncrementalParseResult<TBlock>;
  readonly stats: () => IncrementalParseStats;
  readonly clear: () => void;
} {
  const maxEntries = opts?.maxEntries ?? 64;
  const cache = new Map<string, readonly TBlock[]>();
  let hits = 0;
  let misses = 0;

  const parseIncremental = (
    buffer: string,
    fullParse: (text: string) => readonly TBlock[],
  ): IncrementalParseResult<TBlock> => {
    const { stable, tail } = splitStableTail(buffer);
    const prefixHash = stable.length > 0 ? fnv1a32(stable) : '0';

    let prefixBlocks: readonly TBlock[];
    if (stable.length === 0) {
      // No stable prefix yet — the buffer is one in-flight paragraph.
      prefixBlocks = [];
    } else {
      const cached = cache.get(prefixHash);
      if (cached !== undefined) {
        hits += 1;
        prefixBlocks = cached;
      } else {
        misses += 1;
        prefixBlocks = fullParse(stable);
        cache.set(prefixHash, prefixBlocks);
        if (cache.size > maxEntries) {
          // FIFO eviction (Map preserves insertion order). Adequate
          // here because successive prefixes monotonically grow — the
          // OLDEST entry is the shortest committed prefix and never
          // comes back into use.
          const oldestKey = cache.keys().next().value;
          if (oldestKey !== undefined) cache.delete(oldestKey);
        }
      }
    }

    // Tail is always re-parsed — it's bounded by one paragraph's worth
    // of text, and the user expects the tail to update immediately.
    const tailBlocks: readonly TBlock[] =
      tail.length === 0 ? [] : fullParse(tail);

    return { prefixBlocks, tailBlocks, prefixHash };
  };

  const stats = (): IncrementalParseStats => ({
    hits,
    misses,
    size: cache.size,
  });

  const clear = (): void => {
    cache.clear();
    hits = 0;
    misses = 0;
  };

  return { parseIncremental, stats, clear };
}
