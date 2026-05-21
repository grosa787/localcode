/**
 * SessionEventBus — typed publish/subscribe keyed by session id.
 *
 * Each `ChatRuntime` emits `WSServerMessage` events for its session.
 * One or more WebSocket sockets may be subscribed to a given session
 * (multi-tab support). The bus owns no state beyond the subscriber set;
 * persisted history lives in `SessionManager`, in-flight state lives in
 * `ChatRuntime`, pending approvals live in `ApprovalBridge`.
 *
 * Failure isolation: if one subscriber throws synchronously, every other
 * subscriber still receives the event. We log the failure to `console.warn`
 * (visible to developers, invisible to users) so a buggy socket handler
 * cannot break the streaming flow.
 */

import type { WSServerMessage } from '@/web/protocol/messages';

export type Subscriber = (msg: WSServerMessage) => void;

export class SessionEventBus {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  /**
   * Subscribers marked dead by a prior `emit` (their send threw —
   * typically a torn-down WebSocket without an `onClose`). Pruned on
   * the next `emit` to that session. Audit M3.
   */
  private readonly deadSubscribers = new Map<string, Set<Subscriber>>();

  /**
   * Register a subscriber for `sessionId`. Returns an `unsubscribe`
   * function — call it from the socket's `onClose` handler so a
   * disconnected client is reaped immediately.
   */
  subscribe(sessionId: string, fn: Subscriber): () => void {
    let set = this.subscribers.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      const current = this.subscribers.get(sessionId);
      if (current === undefined) return;
      current.delete(fn);
      this.deadSubscribers.get(sessionId)?.delete(fn);
      if (current.size === 0) {
        this.subscribers.delete(sessionId);
        this.deadSubscribers.delete(sessionId);
      }
    };
  }

  /**
   * Broadcast a message to every subscriber of `sessionId`. Subscribers
   * are invoked synchronously in insertion order. Throwing subscribers
   * are logged but never propagate — the event loop must remain robust.
   *
   * Audit M3 — a thrown subscriber is treated as dead (typical when a
   * WS partitions without firing `onClose`). On the next `emit` pass
   * the dead set is pruned so we don't keep dispatching into the void.
   */
  emit(sessionId: string, msg: WSServerMessage): void {
    // Prune subscribers marked dead during the previous emit.
    const deadSet = this.deadSubscribers.get(sessionId);
    if (deadSet !== undefined && deadSet.size > 0) {
      const live = this.subscribers.get(sessionId);
      if (live !== undefined) {
        for (const fn of deadSet) live.delete(fn);
        if (live.size === 0) this.subscribers.delete(sessionId);
      }
      this.deadSubscribers.delete(sessionId);
    }

    const set = this.subscribers.get(sessionId);
    if (set === undefined || set.size === 0) return;
    // Snapshot so a subscriber that unsubscribes during dispatch
    // doesn't mutate the iterator we're walking.
    const snapshot = [...set];
    let freshDead: Set<Subscriber> | undefined;
    for (const fn of snapshot) {
      try {
        fn(msg);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[SessionEventBus] subscriber for "${sessionId}" threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (freshDead === undefined) freshDead = new Set();
        freshDead.add(fn);
      }
    }
    if (freshDead !== undefined && freshDead.size > 0) {
      this.deadSubscribers.set(sessionId, freshDead);
    }
  }

  /** True iff at least one subscriber is currently registered for `sessionId`. */
  hasSubscribers(sessionId: string): boolean {
    return (this.subscribers.get(sessionId)?.size ?? 0) > 0;
  }

  /** Subscriber count for `sessionId` — useful for diagnostics + tests. */
  subscriberCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.size ?? 0;
  }

  /**
   * Count of subscribers that are NOT marked dead — i.e. those still
   * expected to receive the next emit. Equal to `subscriberCount` until
   * an emit has flagged a failing subscriber. Audit M3.
   */
  liveCount(sessionId: string): number {
    const total = this.subscribers.get(sessionId)?.size ?? 0;
    const dead = this.deadSubscribers.get(sessionId)?.size ?? 0;
    return Math.max(0, total - dead);
  }

  /**
   * Drop every subscriber for every session. Called from the server
   * shutdown path to release closures held by socket-bound callbacks.
   */
  clear(): void {
    this.subscribers.clear();
    this.deadSubscribers.clear();
  }
}
