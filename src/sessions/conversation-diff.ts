/**
 * Conversation diff — compare two session branches' message lists and
 * identify where they diverged plus per-position deltas.
 *
 * Comparison rules (intentionally cheap — no model call, no fuzzy
 * matching):
 *   - Two messages are "identical" when role + content + createdAt all
 *     match. Tool calls are folded into content via the serialized JSON
 *     of `toolCalls` so a tool round-trip with different args still
 *     registers as a diff.
 *   - The branchPoint is the first position where the two lists disagree
 *     (or where one ran out — that's a `*-only` verdict in the entries).
 *   - After the branchPoint we still walk every remaining position so the
 *     viewer can show the full divergence; identical tails (rare) get an
 *     `identical` verdict.
 *
 * `Verdict` mirrors the spec exactly:
 *   - `identical` — both sides present and equal.
 *   - `diff`      — both sides present and unequal.
 *   - `a-only`    — only side A has a message at this position.
 *   - `b-only`    — only side B has a message at this position.
 */

import type { Message, Session } from '@/types/global';

// ---------- Public types ----------

export type ConversationDiffVerdict =
  | 'identical'
  | 'diff'
  | 'a-only'
  | 'b-only';

/**
 * One position in the merged walk. `index` is the 0-based position in
 * the chronological message lists (both sides share the index — when
 * one side is shorter the corresponding entry just omits that field).
 */
export interface ConversationDiffEntry {
  readonly index: number;
  readonly a?: Message;
  readonly b?: Message;
  readonly verdict: ConversationDiffVerdict;
}

/**
 * Branch point: the first message id that appears identically in both
 * sessions before the divergence kicks in. `null` when the very first
 * message disagrees (or either side is empty) — no shared history.
 */
export interface ConversationBranchPoint {
  readonly messageId: string;
  readonly ts: number;
}

export interface ConversationDiff {
  readonly branchPoint: ConversationBranchPoint | null;
  readonly diffs: readonly ConversationDiffEntry[];
}

// ---------- Comparison helpers ----------

function fingerprintToolCalls(m: Message): string {
  if (!m.toolCalls || m.toolCalls.length === 0) return '';
  // Stable JSON: tool calls already carry a deterministic order from
  // the executor, so a naive JSON.stringify is enough. We don't need
  // canonical-JSON normalisation because both sides come from the same
  // store with the same writer.
  return JSON.stringify(
    m.toolCalls.map((tc) => ({
      name: tc.name,
      arguments: tc.arguments,
    })),
  );
}

/** True when two messages compare equal under the conversation-diff rules. */
export function messagesEqual(a: Message, b: Message): boolean {
  if (a.role !== b.role) return false;
  if (a.content !== b.content) return false;
  if (a.createdAt !== b.createdAt) return false;
  return fingerprintToolCalls(a) === fingerprintToolCalls(b);
}

// ---------- Public API ----------

/**
 * Source list shape. The function only needs `getAllMessages(sessionId)`
 * on the store, so we accept a tiny interface rather than the full
 * `SessionManager` — keeps the module trivially testable.
 */
export interface ConversationDiffSource {
  getAllMessages(sessionId: string): readonly Message[];
}

/**
 * Compute the structural diff between two sessions' chronological
 * message lists. Pure function — no I/O beyond the `source` reader,
 * which is normally a `SessionManager` but can be any object with a
 * `getAllMessages` method (handy for tests / web RPC adapters).
 *
 * Algorithm:
 *   1. Read both lists in order.
 *   2. Walk pairs position-by-position. As long as both sides remain
 *      equal, emit `identical` entries and record the last shared
 *      message as the running branch-point candidate.
 *   3. On the first inequality (or once one side runs out) the
 *      branch-point is frozen; the remainder of the walk emits
 *      `diff` / `a-only` / `b-only` entries verbatim.
 *
 * The function is async to keep room for future I/O-bound enrichment
 * (e.g. loading message bodies on demand from a remote store) — current
 * implementation is synchronous internally and resolves immediately.
 */
export async function computeConversationDiff(
  sessionA: Session,
  sessionB: Session,
  source: ConversationDiffSource,
): Promise<ConversationDiff> {
  const aMessages = source.getAllMessages(sessionA.id);
  const bMessages = source.getAllMessages(sessionB.id);

  const max = Math.max(aMessages.length, bMessages.length);
  const diffs: ConversationDiffEntry[] = [];

  let branchPoint: ConversationBranchPoint | null = null;
  let stillMatching = true;

  for (let i = 0; i < max; i += 1) {
    const a = aMessages[i];
    const b = bMessages[i];

    if (a !== undefined && b !== undefined) {
      const eq = messagesEqual(a, b);
      if (eq && stillMatching) {
        branchPoint = { messageId: a.id, ts: a.createdAt };
        diffs.push({ index: i, a, b, verdict: 'identical' });
        continue;
      }
      stillMatching = false;
      diffs.push({
        index: i,
        a,
        b,
        verdict: eq ? 'identical' : 'diff',
      });
      continue;
    }

    // One side has run out — record the surviving side as *-only.
    stillMatching = false;
    if (a !== undefined) {
      diffs.push({ index: i, a, verdict: 'a-only' });
      continue;
    }
    if (b !== undefined) {
      diffs.push({ index: i, b, verdict: 'b-only' });
      continue;
    }
    // Defensive: max == length of longer list, so this branch is
    // unreachable. Kept as a guard so future refactors don't break the
    // invariant silently.
  }

  return Promise.resolve({ branchPoint, diffs });
}

// ---------- Viewer adapter ----------

/**
 * Render one diff entry into a text-diff body suitable for `<DiffViewer>`
 * (the cmd-diff `DiffEntry` shape with `before`/`after`/`filePath`/`mode`).
 *
 * - `identical` rows produce empty diffs and are skipped by callers.
 * - `diff` rows render side-A content as `before` and side-B as `after`.
 * - `a-only` / `b-only` map to `deleted` / `created`.
 *
 * The label includes the position index and the role so the viewer's
 * header reads like `#03 [assistant] diff` — distinct from a file-path
 * label so users don't confuse it with a real `/diff` view.
 */
export interface ConversationDiffViewerEntry {
  readonly filePath: string;
  readonly before: string;
  readonly after: string;
  readonly mode: 'modified' | 'created' | 'deleted';
}

function messageToBody(m: Message): string {
  const head = `[${m.role}] @ ${new Date(m.createdAt).toISOString()}`;
  const tools = fingerprintToolCalls(m);
  const toolLine = tools.length > 0 ? `\n[toolCalls] ${tools}` : '';
  return `${head}${toolLine}\n${m.content}`;
}

function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

export function diffEntryToViewerEntry(
  entry: ConversationDiffEntry,
): ConversationDiffViewerEntry | null {
  if (entry.verdict === 'identical') return null;
  const idx = pad(entry.index + 1, 3);
  const aBody = entry.a !== undefined ? messageToBody(entry.a) : '';
  const bBody = entry.b !== undefined ? messageToBody(entry.b) : '';
  const role =
    entry.a?.role ?? entry.b?.role ?? 'message';
  const filePath = `#${idx} [${role}] ${entry.verdict}`;
  if (entry.verdict === 'a-only') {
    return { filePath, before: aBody, after: '', mode: 'deleted' };
  }
  if (entry.verdict === 'b-only') {
    return { filePath, before: '', after: bBody, mode: 'created' };
  }
  return { filePath, before: aBody, after: bBody, mode: 'modified' };
}

/**
 * Convenience: turn a full `ConversationDiff` into a viewer-ready entry
 * list, dropping `identical` positions. Used by `/conv diff` when wiring
 * the DiffViewer overlay.
 */
export function conversationDiffToViewerEntries(
  d: ConversationDiff,
): readonly ConversationDiffViewerEntry[] {
  const out: ConversationDiffViewerEntry[] = [];
  for (const entry of d.diffs) {
    const v = diffEntryToViewerEntry(entry);
    if (v !== null) out.push(v);
  }
  return out;
}
