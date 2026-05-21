/**
 * SnippetRing — composer power feature #1.
 *
 * In-memory ring buffer for ad-hoc text snippets the user pulls out of
 * the running chat transcript. The selection UI in ChatScreen
 * (`'select'` input mode) writes into the singleton via `push()`; the
 * pre-submit hook in the composer rewrites `@clip-<N>` tokens back to
 * the captured content before `onSubmit` fires.
 *
 * Contract:
 *   - Process-wide singleton (`getSnippetRing()`). No disk persistence
 *     — snippets are session-ephemeral. Cleared on process exit.
 *   - FIFO eviction at `MAX_ENTRIES = 10`. The oldest entry is dropped
 *     when push #11 lands so the most recent ten are always available.
 *   - Sequence numbers are monotonically increasing across the
 *     process lifetime — `clip-N` references never reshuffle when an
 *     earlier entry is evicted. This is the load-bearing invariant:
 *     evicting clip-1 then pushing must produce clip-11, NOT a reused
 *     clip-1. Users who copy a reference into a draft expect that
 *     reference to remain stable while the snippet still exists.
 *
 * The class is exported only so tests can construct fresh instances
 * with isolated state. Production callers go through the singleton.
 */

export interface SnippetEntry {
  readonly clipId: string;
  readonly content: string;
  readonly addedAt: number;
}

const MAX_ENTRIES = 10;
/**
 * Reference token format: `@clip-<positive-integer>`. Matched at word
 * boundaries so embedded references (`(@clip-1)`, `[@clip-3].`,
 * `\n@clip-2\n`) all resolve. The trailing `(?=\W|$)` keeps `@clip-12foo`
 * from parsing as `clip-1` plus `2foo`.
 */
const CLIP_REF_RE = /@clip-(\d+)(?=\W|$)/g;

export class SnippetRing {
  private readonly entries: SnippetEntry[] = [];
  private nextSeq = 1;

  /**
   * Append `content` to the ring. Returns the `clip-N` id assigned to it.
   * Empty strings are accepted (the selection UI doesn't filter the
   * captured selection, and an empty entry is still a deliberate user
   * action — the existing `get()` semantics treat it correctly).
   */
  push(content: string): { readonly clipId: string } {
    const clipId = `clip-${this.nextSeq}`;
    this.nextSeq += 1;
    this.entries.push({ clipId, content, addedAt: Date.now() });
    while (this.entries.length > MAX_ENTRIES) {
      // FIFO — oldest entry leaves first. Sequence numbers do NOT
      // recycle (see class doc), so the visible `clip-N` for surviving
      // entries stays stable.
      this.entries.shift();
    }
    return { clipId };
  }

  /**
   * Look up a snippet by its `clip-N` id. Returns null when the id is
   * unknown or the entry has already been evicted.
   */
  get(clipId: string): string | null {
    for (const e of this.entries) {
      if (e.clipId === clipId) return e.content;
    }
    return null;
  }

  /** All current entries in insertion order (oldest → newest). */
  list(): readonly SnippetEntry[] {
    return this.entries.slice();
  }

  /** Drop every entry. The next push starts fresh at seq `+1`. */
  clear(): void {
    this.entries.length = 0;
    // We deliberately keep `nextSeq` advancing so a `clear()` followed
    // by a `push()` still produces a brand-new id rather than reusing
    // a recently-cleared one. Matches the no-recycle invariant above.
  }

  /** Count of live entries. */
  get size(): number {
    return this.entries.length;
  }
}

/**
 * Replace every `@clip-<N>` reference in `text` with the captured
 * snippet content. Unknown / evicted ids are left as-is so the user
 * spots the typo (substituting nothing would silently drop their
 * reference). Returns both the rewritten text and the list of clip ids
 * that were resolved — callers can use the latter to log the
 * substitution or surface a small UI confirmation.
 *
 * Pure function — no singleton access — so tests can drive it with a
 * fresh `SnippetRing` instance and assert behaviour deterministically.
 */
export function expandClipReferences(
  text: string,
  ring: SnippetRing,
): { readonly text: string; readonly resolved: readonly string[] } {
  const resolved: string[] = [];
  const rewritten = text.replace(CLIP_REF_RE, (whole, num: string) => {
    const clipId = `clip-${num}`;
    const content = ring.get(clipId);
    if (content === null) return whole;
    resolved.push(clipId);
    return content;
  });
  return { text: rewritten, resolved };
}

let singleton: SnippetRing | null = null;

/**
 * Process-wide accessor. Lazy-constructs the singleton on first call so
 * tests that never touch the ring don't allocate. Tests that need
 * isolated state construct `new SnippetRing()` directly.
 */
export function getSnippetRing(): SnippetRing {
  if (singleton === null) singleton = new SnippetRing();
  return singleton;
}

/**
 * Reset the process-wide singleton. Used by tests that exercise the
 * global path. Not exported through `index.ts`-style barrels because no
 * runtime caller has any reason to call it.
 */
export function __resetSnippetRingForTests(): void {
  singleton = null;
}

export { MAX_ENTRIES as SNIPPET_RING_MAX, CLIP_REF_RE };
