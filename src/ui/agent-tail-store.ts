/**
 * AgentTailStore — in-memory, subscribe-able log of TeamBus messages
 * that the TUI renders inline in the chat stream as collapsible
 * `▾ <agent-id> said:` blocks.
 *
 * Design contract
 * ----------------
 * - **Display-only.** These entries are NEVER persisted into the
 *   sessions SQLite store. They live until the React tree unmounts or
 *   `clear(sessionId)` is called. The lead's canonical reply history
 *   (the messages array) remains untouched — agent-tail is parallel
 *   chrome the user can collapse/expand without affecting prompt
 *   replay or compression.
 *
 * - **Per-session retention.** Each parent session id has its own ring
 *   buffer capped at {@link DEFAULT_MAX_PER_SESSION} entries (last-N
 *   wins). Overflow drops the OLDEST entry — this matches the TUI's
 *   "scroll forward" mental model.
 *
 * - **Subscribers.** `subscribe(fn)` registers a notify callback fired
 *   AFTER each successful `push` so the React `useSyncExternalStore`-
 *   style hook in `app.tsx`'s AGENT-TAIL-SECTION can pull the freshest
 *   snapshot and re-render. Errors in subscribers are swallowed so a
 *   single broken consumer can't take down the store.
 *
 * - **Interleaved selector.** `getInterleavedMessages(sessionId,
 *   leadMessages)` returns a chronologically-sorted union of the
 *   lead's messages and the recorded agent-tail entries. Same-timestamp
 *   ties break lead-first to keep the spec "render in chronological
 *   order, ties broken by source (lead first)".
 */

import type { Message } from '@/types/global';
import type { TeamBusMessage } from '@/agents/types';

/** Default cap on retained tail entries per session. */
export const DEFAULT_MAX_PER_SESSION = 100;

/**
 * A single recorded TeamBus message captured for inline rendering.
 *
 * `id` is synthetic and unique within the process lifetime so React
 * keys stay stable across re-renders. `templateName` is the label the
 * AgentPanel uses for the worker — composition root passes it through
 * so the inline header can show e.g. `▾ a1b2c3 · debugger · 12:31:05`
 * even when the worker fanned out without a template.
 */
export interface AgentTailEntry {
  /** Unique identifier — used as the React key. */
  readonly id: string;
  /** Parent session id this entry belongs to. */
  readonly sessionId: string;
  /** Agent id of the worker that posted the message. */
  readonly agentId: string;
  /** Template label (`debugger`, `reviewer`, …) or model id. */
  readonly templateName: string;
  /** Recipient — typically `'all'` or `'lead'`. */
  readonly to: string;
  /** Raw text body. */
  readonly message: string;
  /** Date.now() at receive time. */
  readonly at: number;
}

/**
 * Pushed-shape — the orchestrator fans `agent_team_message` events here
 * (see app.tsx AGENT-TAIL-SECTION). The store fills in `id` and the
 * `sessionId` is captured at the call-site (the orchestrator already
 * knows which parent the bus belongs to).
 */
export interface AgentTailPush {
  readonly sessionId: string;
  readonly agentId: string;
  readonly templateName: string;
  readonly bus: TeamBusMessage;
}

/**
 * One entry of the chronologically-interleaved list used by ChatScreen
 * to render messages and agent-tail blocks in a single pass. The
 * discriminator (`kind`) lets the renderer dispatch to MessageBlock or
 * AgentInlineMessage without a separate side-by-side traversal.
 *
 * The store NEVER mutates either source list; it returns a fresh array.
 */
export type InterleavedItem =
  | { readonly kind: 'message'; readonly ts: number; readonly message: Message }
  | { readonly kind: 'agent-tail'; readonly ts: number; readonly entry: AgentTailEntry };

export type AgentTailSubscriber = () => void;

export interface AgentTailStoreOptions {
  /** Override per-session cap. Mainly a test seam. */
  readonly maxPerSession?: number;
  /** Override id generator — tests pass a deterministic one. */
  readonly idGenerator?: () => string;
}

/**
 * The store. Constructed once per app (composition root holds the
 * singleton). The implementation is a plain class because the API
 * mirrors the TeamBus / OrchestratorEvent surfaces — both of which
 * the rest of the agents subsystem implements as plain classes.
 */
export class AgentTailStore {
  private readonly buffers = new Map<string, AgentTailEntry[]>();
  private readonly subscribers = new Set<AgentTailSubscriber>();
  private readonly maxPerSession: number;
  private readonly idGen: () => string;
  private idCounter = 0;

  constructor(opts: AgentTailStoreOptions = {}) {
    const cap = opts.maxPerSession;
    this.maxPerSession =
      typeof cap === 'number' && Number.isFinite(cap) && cap > 0
        ? Math.floor(cap)
        : DEFAULT_MAX_PER_SESSION;
    this.idGen = opts.idGenerator ?? (() => {
      this.idCounter += 1;
      return `tail-${Date.now().toString(36)}-${this.idCounter.toString(36)}`;
    });
  }

  /** Append a new entry; drop the oldest when the cap is exceeded. */
  push(push: AgentTailPush): AgentTailEntry {
    const entry: AgentTailEntry = {
      id: this.idGen(),
      sessionId: push.sessionId,
      agentId: push.agentId,
      templateName: push.templateName,
      to: push.bus.to,
      message: push.bus.message,
      at: push.bus.at,
    };
    let buf = this.buffers.get(push.sessionId);
    if (buf === undefined) {
      buf = [];
      this.buffers.set(push.sessionId, buf);
    }
    buf.push(entry);
    while (buf.length > this.maxPerSession) buf.shift();
    this.notify();
    return entry;
  }

  /** Snapshot of entries for one session (chronological). */
  getEntries(sessionId: string): readonly AgentTailEntry[] {
    const buf = this.buffers.get(sessionId);
    if (buf === undefined) return EMPTY;
    return buf.slice();
  }

  /** Drop all entries for one session. */
  clear(sessionId: string): void {
    if (this.buffers.delete(sessionId)) {
      this.notify();
    }
  }

  /** Drop everything. */
  clearAll(): void {
    if (this.buffers.size === 0) return;
    this.buffers.clear();
    this.notify();
  }

  /** Total entry count across every session (diagnostics). */
  size(): number {
    let n = 0;
    for (const buf of this.buffers.values()) n += buf.length;
    return n;
  }

  /** Subscribe to "store changed" notifications. Returns unsubscribe. */
  subscribe(fn: AgentTailSubscriber): () => void {
    this.subscribers.add(fn);
    return (): void => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * Merge `leadMessages` with the tail entries for `sessionId` into a
   * single chronologically-sorted list. Same-timestamp ties resolve
   * "lead first" so the user's question always reads before the
   * worker chatter it triggered.
   *
   * Pure function — does not allocate or mutate either input. The
   * caller is expected to memoise the result; the inputs are
   * referentially stable in practice (messages array is append-only,
   * tail buffer reference rotates on push).
   */
  getInterleavedMessages(
    sessionId: string,
    leadMessages: readonly Message[],
  ): readonly InterleavedItem[] {
    return mergeInterleaved(leadMessages, this.getEntries(sessionId));
  }

  // ---------- internals ----------

  private notify(): void {
    const snap = [...this.subscribers];
    for (const fn of snap) {
      try {
        fn();
      } catch {
        // ignore — never let a subscriber failure bubble
      }
    }
  }
}

const EMPTY: readonly AgentTailEntry[] = Object.freeze([]);

/**
 * Pure merge — exported so tests can drive the selector without
 * constructing a full store. Same-timestamp messages come first
 * (source = lead) before tail entries (source = worker). Within the
 * same source, original ordering is preserved (stable merge).
 */
export function mergeInterleaved(
  leadMessages: readonly Message[],
  tailEntries: readonly AgentTailEntry[],
): readonly InterleavedItem[] {
  const out: InterleavedItem[] = [];
  let i = 0;
  let j = 0;
  while (i < leadMessages.length && j < tailEntries.length) {
    const m = leadMessages[i];
    const t = tailEntries[j];
    if (m === undefined) {
      i += 1;
      continue;
    }
    if (t === undefined) {
      j += 1;
      continue;
    }
    const ma = m.createdAt;
    const ta = t.at;
    if (ma <= ta) {
      out.push({ kind: 'message', ts: ma, message: m });
      i += 1;
    } else {
      out.push({ kind: 'agent-tail', ts: ta, entry: t });
      j += 1;
    }
  }
  while (i < leadMessages.length) {
    const m = leadMessages[i];
    if (m !== undefined) {
      out.push({ kind: 'message', ts: m.createdAt, message: m });
    }
    i += 1;
  }
  while (j < tailEntries.length) {
    const t = tailEntries[j];
    if (t !== undefined) {
      out.push({ kind: 'agent-tail', ts: t.at, entry: t });
    }
    j += 1;
  }
  return out;
}
