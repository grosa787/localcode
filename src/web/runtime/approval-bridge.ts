/**
 * ApprovalBridge — pending-promise registry that turns the synchronous
 * `ToolExecutor.approvalCallback` into an asynchronous request/response
 * over WebSocket.
 *
 * Flow:
 *   1. `ChatRuntime` wires `setApprovalCallback` so each tool requiring
 *      approval lands here as `request(toolCallId, …)`.
 *   2. `request` registers a pending entry, starts a 5-minute safety
 *      timeout, and returns a Promise<boolean>.
 *   3. The server emits an `approval_request` event over the bus; the
 *      browser eventually replies with `approval_response`.
 *   4. The WS router calls `resolve(toolCallId, approved)`. The promise
 *      settles; the tool executor proceeds (or aborts).
 *
 * Multi-tab: every connected tab sees the request; the first
 * `approval_response` wins (subsequent calls are no-ops). Timeout
 * counts as a rejection so tools never hang the session.
 *
 * Note: this module is transport-agnostic. It does NOT touch the WS
 * layer directly — `ChatRuntime` and the WS router glue events to it.
 */

import type { ToolPreviewWire } from '@/web/protocol/messages';

// APPROVAL-MODIFIED-ARGS-SECTION
/**
 * Resolution carried back to the executor approval callback. Includes
 * any args edits the user made through the Monaco editor in the SPA
 * approval dialog so the runtime can mutate the live `args` record
 * before the tool's `commit()` runs.
 */
export interface ApprovalResolution {
  readonly approved: boolean;
  readonly modifiedArgs?: Record<string, unknown>;
}
// APPROVAL-MODIFIED-ARGS-SECTION-END

type Resolver = (resolution: ApprovalResolution) => void;
type Rejector = (err: Error) => void;

interface PendingApproval {
  resolver: Resolver;
  rejector: Rejector;
  timeoutHandle: ReturnType<typeof setTimeout>;
  toolName: string;
  args: unknown;
  preview: ToolPreviewWire | null;
  sessionId: string;
}

export interface ApprovalBridgeOptions {
  /** Auto-reject timeout in ms. Default 5 minutes. */
  timeoutMs?: number;
}

/** Snapshot of a pending approval, returned by `listPending`. */
export interface PendingApprovalView {
  toolCallId: string;
  toolName: string;
  args: unknown;
  preview: ToolPreviewWire | null;
  sessionId: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Distinguishes a timeout from an explicit user rejection (audit H4).
 *
 * The ToolExecutor catches this in its approvalCallback path and surfaces
 * a "Approval timed out after N minutes" error to the model — visibly
 * different from "User rejected ...". Callers that prefer the original
 * boolean false (e.g. shutdown `rejectAll`) use `resolve(false)` instead.
 */
export class ApprovalTimeoutError extends Error {
  readonly toolCallId: string;
  readonly timeoutMs: number;
  constructor(toolCallId: string, timeoutMs: number) {
    const minutes = Math.round(timeoutMs / 60_000);
    super(
      minutes >= 1
        ? `Approval timed out after ${minutes} minute${minutes === 1 ? '' : 's'}`
        : `Approval timed out after ${timeoutMs}ms`,
    );
    this.name = 'ApprovalTimeoutError';
    this.toolCallId = toolCallId;
    this.timeoutMs = timeoutMs;
  }
}

export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly timeoutMs: number;

  constructor(opts?: ApprovalBridgeOptions) {
    const raw = opts?.timeoutMs;
    this.timeoutMs =
      typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.floor(raw)
        : DEFAULT_TIMEOUT_MS;
  }

  /**
   * Register a pending approval and return a Promise that resolves when
   * `resolve(toolCallId, …)` is called or *rejects* with an
   * {@link ApprovalTimeoutError} when the safety timeout fires (audit H4).
   *
   * Throws if another approval with the same `toolCallId` is already
   * outstanding — duplicate ids would let one response cross-resolve a
   * different tool call.
   */
  request(
    toolCallId: string,
    toolName: string,
    args: unknown,
    preview: ToolPreviewWire | null,
    sessionId: string,
  ): Promise<ApprovalResolution> {
    if (this.pending.has(toolCallId)) {
      throw new Error(`Approval already pending for ${toolCallId}`);
    }
    return new Promise<ApprovalResolution>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const entry = this.pending.get(toolCallId);
        if (entry === undefined) return;
        this.pending.delete(toolCallId);
        // Timeout — reject with a typed error so the executor can
        // distinguish "user said no" from "no one was around to answer".
        entry.rejector(new ApprovalTimeoutError(toolCallId, this.timeoutMs));
      }, this.timeoutMs);
      this.pending.set(toolCallId, {
        resolver: resolve,
        rejector: reject,
        timeoutHandle,
        toolName,
        args,
        preview,
        sessionId,
      });
    });
  }

  /**
   * Settle a pending approval. Returns true if a request was actually
   * resolved, false when no entry matched (already resolved / timed
   * out / unknown id). Idempotent: a second `resolve` with the same
   * id is a no-op.
   *
   * APPROVAL-MODIFIED-ARGS-SECTION — optional `modifiedArgs` carries
   * the SPA's Monaco-edited tool arguments back to the runtime; the
   * runtime applies them in-place before the tool's `commit()` runs.
   */
  resolve(
    toolCallId: string,
    approved: boolean,
    modifiedArgs?: Record<string, unknown>,
  ): boolean {
    const entry = this.pending.get(toolCallId);
    if (entry === undefined) return false;
    clearTimeout(entry.timeoutHandle);
    this.pending.delete(toolCallId);
    try {
      entry.resolver(
        modifiedArgs !== undefined
          ? { approved, modifiedArgs }
          : { approved },
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ApprovalBridge] resolver for ${toolCallId} threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return true;
  }

  /** True iff an approval is currently pending for `toolCallId`. */
  has(toolCallId: string): boolean {
    return this.pending.has(toolCallId);
  }

  /** Number of currently-pending approvals — diagnostics + tests. */
  size(): number {
    return this.pending.size;
  }

  /**
   * Snapshot of every pending approval. Used by the WS router to
   * re-emit `approval_request` events when a tab subscribes (so a
   * fresh tab catches up on outstanding approvals it missed).
   */
  listPending(): PendingApprovalView[] {
    const out: PendingApprovalView[] = [];
    for (const [toolCallId, entry] of this.pending) {
      out.push({
        toolCallId,
        toolName: entry.toolName,
        args: entry.args,
        preview: entry.preview,
        sessionId: entry.sessionId,
      });
    }
    return out;
  }

  /**
   * Reject every outstanding approval — used during server shutdown
   * so dangling tool calls fail fast instead of hanging the process.
   */
  rejectAll(): void {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.resolve(id, false, undefined);
  }
}
