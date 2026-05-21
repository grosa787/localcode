/**
 * TeamBus — in-memory pub-sub for agent-to-agent messages.
 *
 * Scope: one bus per parent session (the lead session). The
 * orchestrator wires sender ids ('lead' for the parent, agent id for
 * each worker) and routes messages.
 *
 * Capacity: a bounded ring buffer (default 1000). Older messages are
 * dropped on overflow — clients tracking their own cursor are expected
 * to call `read()` often enough to consume before drop.
 *
 * Filtering: `read(forAgentId, sinceMs)` returns messages whose
 * `to === 'all'` OR `to === forAgentId`, AND whose `from !== forAgentId`
 * (callers don't echo their own broadcasts), AND whose `at > sinceMs`.
 *
 * Observers: `subscribe(fn)` lets the orchestrator listen for every
 * message so it can forward to the WS event bus for the parent. The
 * subscriber set is invoked synchronously after `send`. Throwing
 * subscribers are logged and never propagate.
 */

import type { TeamBusMessage } from './types';

/** Default capacity. Bigger buffers waste memory; smaller starves slow readers. */
export const DEFAULT_BUS_CAPACITY = 1000;

export type TeamBusSubscriber = (msg: TeamBusMessage) => void;

export class TeamBus {
  private readonly buffer: TeamBusMessage[] = [];
  private readonly capacity: number;
  private readonly subscribers = new Set<TeamBusSubscriber>();

  constructor(opts?: { capacity?: number }) {
    const raw = opts?.capacity;
    this.capacity =
      typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.floor(raw)
        : DEFAULT_BUS_CAPACITY;
  }

  /** Append `msg` to the ring buffer and notify subscribers. */
  send(msg: { from: string; to: string; message: string }): TeamBusMessage {
    const entry: TeamBusMessage = {
      from: msg.from,
      to: msg.to,
      message: msg.message,
      at: Date.now(),
    };
    this.buffer.push(entry);
    // Audit M6 — Array.shift() is O(n). At the default cap (1000) the
    // amortised cost is negligible (a 1000-element shift in V8 is sub-ms
    // and only fires once per overflow). If the cap is ever raised
    // significantly (≥10K) this should become a head/tail circular
    // buffer; we keep the simple array form for now because every
    // consumer (read, history) expects ordered iteration.
    while (this.buffer.length > this.capacity) this.buffer.shift();
    // Snapshot so a subscriber unsubscribing during dispatch doesn't
    // mutate the iterator.
    const snapshot = [...this.subscribers];
    for (const fn of snapshot) {
      try {
        fn(entry);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[TeamBus] subscriber threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return entry;
  }

  /**
   * Read messages addressed to `forAgentId` (or `'all'`) sent strictly
   * after `sinceMs`. Excludes the caller's own messages so a worker
   * polling after a broadcast doesn't see its own packet.
   */
  read(forAgentId: string, sinceMs: number): TeamBusMessage[] {
    const out: TeamBusMessage[] = [];
    for (const m of this.buffer) {
      if (m.at <= sinceMs) continue;
      if (m.from === forAgentId) continue;
      if (m.to !== 'all' && m.to !== forAgentId) continue;
      out.push(m);
    }
    return out;
  }

  /** Full unfiltered history snapshot — diagnostics + UI inspection. */
  history(): readonly TeamBusMessage[] {
    return [...this.buffer];
  }

  /** Subscribe to every send. Returns an unsubscribe fn. */
  subscribe(fn: TeamBusSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Drop all subscribers and clear the buffer. */
  clear(): void {
    this.subscribers.clear();
    this.buffer.length = 0;
  }

  /** Diagnostics — current buffer length. */
  size(): number {
    return this.buffer.length;
  }
}
