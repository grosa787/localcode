/**
 * Semantic dedup for `read_file` tool results.
 *
 * When a long session has the model re-reading the same file repeatedly
 * (a very common pattern: "look at X — okay, now look at X again to
 * decide Y"), the conversation history accumulates near-identical
 * tool-role messages that bloat the prompt without adding signal. The
 * most recent read is usually authoritative; earlier reads of the same
 * path can be safely substituted with a pointer to the latest result.
 *
 * Contract (see DedupResult below):
 *   - Match tool-role messages whose `toolName === 'read_file'` and
 *     whose source assistant tool_call references the same `path` arg.
 *   - Group by `path` (string-equal). When a group has >= 3 reads,
 *     keep the LAST result verbatim; replace earlier results' content
 *     with a marker `[dedup: see read_file result at message index N]`.
 *   - Never modify mutating-tool results (write_file, edit_file,
 *     multi_edit, run_command, git_commit, notebook_edit).
 *   - Never modify the last 5 messages (recency window).
 *   - Pure: no I/O, no mutation of the input array. Returns a new array.
 *
 * Token accounting (`removedTokens`) uses the same `4 chars ≈ 1 token`
 * estimator the rest of the context manager uses — close enough for
 * compression decisions.
 */

import type { Message } from '@/types/global';

/** Tools whose results MUST be preserved verbatim. */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'run_command',
  'git_commit',
  'notebook_edit',
]);

/** Recency window: the last N messages are never touched. */
export const DEDUP_RECENCY_WINDOW = 5;

/** Minimum number of reads of the same file before dedup pays off. */
export const DEDUP_MIN_READS = 3;

const CHARS_PER_TOKEN = 4;

export interface DedupResult {
  /** New message list (same length as input). */
  messages: Message[];
  /** Approximate tokens removed by collapsing duplicate read_file results. */
  removedTokens: number;
  /** Number of read_file results that were substituted with the dedup marker. */
  dedupedReadCount: number;
}

/**
 * Build the dedup-marker string. Extracted so callers / tests can
 * recognise the exact format.
 */
export function buildDedupMarker(authoritativeIndex: number): string {
  return `[dedup: see read_file result at message index ${authoritativeIndex}]`;
}

/**
 * Walk the message list and substitute earlier `read_file` results
 * with the dedup marker when the same path has been read >= 3 times.
 *
 * Path resolution: for each tool-role message we walk backwards to
 * find its source assistant message (the one whose `toolCalls`
 * contains the matching `toolCallId`) and read the `path` argument
 * from the tool-call's `arguments`. When the source can't be located
 * the message is treated as non-deduplicable (safest default — we'd
 * rather over-preserve than mis-substitute).
 */
export function dedupReadResults(messages: readonly Message[]): DedupResult {
  if (messages.length === 0) {
    return { messages: [], removedTokens: 0, dedupedReadCount: 0 };
  }

  const recencyCutoff = Math.max(0, messages.length - DEDUP_RECENCY_WINDOW);

  // Step 1 — find every `read_file` tool-result message and resolve
  // its `path` argument. Group indices by path so we can decide
  // which to dedupe.
  const groupsByPath = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== 'tool') continue;
    if (msg.toolName !== 'read_file') continue;
    // Recency window: never group anything inside it (and therefore
    // never substitute it). We DO group entries OUTSIDE the recency
    // window even if their authoritative twin lives inside — that's
    // the whole point: the inside-recency message stays, the older
    // ones get a marker pointing to it.
    const path = resolveReadFilePath(messages, i);
    if (path === null) continue;
    const list = groupsByPath.get(path);
    if (list === undefined) groupsByPath.set(path, [i]);
    else list.push(i);
  }

  // Step 2 — determine substitutions. For each path with >= 3 reads,
  // keep the LAST index verbatim (the "authoritative" index) and
  // mark every earlier index for substitution UNLESS the earlier
  // index is inside the recency window.
  const substitutions = new Map<number, string>();
  let dedupedReadCount = 0;
  let removedChars = 0;

  for (const [, indices] of groupsByPath) {
    if (indices.length < DEDUP_MIN_READS) continue;
    const authoritativeIdx = indices[indices.length - 1];
    if (authoritativeIdx === undefined) continue;
    const marker = buildDedupMarker(authoritativeIdx);
    const markerLen = marker.length;
    for (let k = 0; k < indices.length - 1; k += 1) {
      const idx = indices[k];
      if (idx === undefined) continue;
      if (idx >= recencyCutoff) continue;
      const msg = messages[idx];
      if (!msg) continue;
      const origLen = typeof msg.content === 'string' ? msg.content.length : 0;
      // Defensive: if the original is already shorter than the marker
      // (unusual but possible for empty / tiny files), skip. Substituting
      // would INFLATE the prompt; that's never a win.
      if (origLen <= markerLen) continue;
      substitutions.set(idx, marker);
      dedupedReadCount += 1;
      removedChars += origLen - markerLen;
    }
  }

  // Step 3 — build the output array. Pass-through every untouched
  // message; substitute content for indices in `substitutions`.
  const out: Message[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg) continue;
    const replacement = substitutions.get(i);
    if (replacement === undefined) {
      out[i] = msg;
    } else {
      out[i] = { ...msg, content: replacement };
    }
  }

  return {
    messages: out,
    removedTokens: Math.ceil(removedChars / CHARS_PER_TOKEN),
    dedupedReadCount,
  };
}

/**
 * Resolve the `path` argument of the `read_file` tool-call that produced
 * the tool-result message at `toolIdx`. Walks backwards until it finds
 * an assistant message whose `toolCalls` array contains a call with the
 * matching `id`. Returns `null` when the source can't be located or the
 * call's arguments don't carry a usable `path` string.
 *
 * The walk is bounded by the start of the array — worst case O(n) per
 * lookup. In practice the source assistant message is almost always
 * the immediate predecessor.
 */
function resolveReadFilePath(
  messages: readonly Message[],
  toolIdx: number,
): string | null {
  const toolMsg = messages[toolIdx];
  if (!toolMsg) return null;
  const callId = toolMsg.toolCallId;
  if (typeof callId !== 'string' || callId.length === 0) return null;

  for (let j = toolIdx - 1; j >= 0; j -= 1) {
    const candidate = messages[j];
    if (!candidate) continue;
    if (candidate.role !== 'assistant') continue;
    if (!Array.isArray(candidate.toolCalls)) continue;
    for (const call of candidate.toolCalls) {
      if (call.id !== callId) continue;
      const argPath = call.arguments['path'];
      if (typeof argPath !== 'string' || argPath.length === 0) return null;
      return argPath;
    }
  }
  return null;
}

/**
 * Predicate exported for callers (compress-strategy) that want to ask
 * "is this tool name a mutating tool whose result must be preserved?"
 * without re-implementing the set.
 */
export function isMutatingTool(toolName: string | undefined): boolean {
  if (typeof toolName !== 'string' || toolName.length === 0) return false;
  return MUTATING_TOOL_NAMES.has(toolName);
}
