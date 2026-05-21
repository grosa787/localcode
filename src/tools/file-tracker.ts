/**
 * FileChangeTracker — process-wide ledger of last-known mtime/size for each
 * file the model has `read_file`-ed. Used by the tool-executor to warn the
 * model when it tries to `write_file` / `edit_file` / `multi_edit` a path
 * whose contents have changed externally since the last read.
 *
 * Design notes:
 *   - Singleton per process. Two reasons:
 *       1. There's no natural place to thread the tracker through every
 *          tool ctx without polluting half the codebase, and
 *       2. The web runtime and the TUI runtime share the same module
 *          (one Bun process), so a single in-memory map is sufficient.
 *   - Keyed by `<sessionId ?? '_no_session'>::<absolutePath>`. The session
 *     id keeps tracking isolated across concurrent sessions so a write
 *     in session B doesn't surface as "external" when session A reads
 *     the same path later. When `sessionId` is undefined the special
 *     `'_no_session'` partition is used (e.g. ad-hoc tool calls in tests).
 *   - Tracks `mtimeMs` AND `size` because some filesystems (network, FUSE)
 *     report mtime with second-level resolution; size acts as a tiebreaker.
 *   - No disk persistence. The tracker is best-effort and not security
 *     critical — clearing it on restart is fine (and matches the
 *     intuition that a fresh process forgets prior reads).
 */

/** Snapshot captured at the moment `read_file` returned successfully. */
interface FileSnapshot {
  /** mtimeMs as reported by `fs.stat`. */
  readonly mtimeMs: number;
  /** Byte size as reported by `fs.stat`. */
  readonly size: number;
  /** Wall-clock timestamp (ms since epoch) when the read happened. */
  readonly readAt: number;
}

/** Outcome of `checkChanged`. `null` means "no prior read recorded". */
export interface FileChangeStatus {
  readonly changed: boolean;
  /** Wall-clock timestamp of the last `markRead` for this key. */
  readonly lastReadAt: number;
  /** mtimeMs observed by `checkChanged` itself (post-stat). */
  readonly currentMtime: number;
}

/**
 * Process-wide ledger. Constructed once at module load and shared by
 * every read/write path. Tests can call `clear()` between cases for a
 * deterministic start.
 */
export class FileChangeTracker {
  private snapshots: Map<string, FileSnapshot> = new Map();

  private buildKey(absolutePath: string, sessionId: string | undefined): string {
    const sid = sessionId !== undefined && sessionId.length > 0 ? sessionId : '_no_session';
    return `${sid}::${absolutePath}`;
  }

  /**
   * Record a successful `read_file` snapshot. Idempotent — repeated calls
   * with the same key overwrite the prior snapshot so the tracker always
   * reflects the model's MOST RECENT view of the file.
   */
  markRead(
    absolutePath: string,
    mtimeMs: number,
    size: number,
    sessionId?: string,
  ): void {
    this.snapshots.set(this.buildKey(absolutePath, sessionId), {
      mtimeMs,
      size,
      readAt: Date.now(),
    });
  }

  /**
   * Check whether `absolutePath` was modified since the last `markRead`.
   * Returns `null` when there is no recorded read (the model never read
   * the file in this session — we can't say whether it changed).
   *
   * Returns `{ changed: true, ... }` when EITHER mtimeMs OR size differ
   * between the stat and the snapshot. We use both because some
   * filesystems clamp mtime to whole seconds; size catches in-place
   * truncations that round-trip through the same mtime bucket.
   */
  checkChanged(
    absolutePath: string,
    currentMtimeMs: number,
    currentSize: number,
    sessionId?: string,
  ): FileChangeStatus | null {
    const snap = this.snapshots.get(this.buildKey(absolutePath, sessionId));
    if (snap === undefined) return null;
    const changed = snap.mtimeMs !== currentMtimeMs || snap.size !== currentSize;
    return {
      changed,
      lastReadAt: snap.readAt,
      currentMtime: currentMtimeMs,
    };
  }

  /** Drop every recorded snapshot. Used by tests and explicit teardown. */
  clear(): void {
    this.snapshots.clear();
  }

  /**
   * Test/diagnostic accessor — true when at least one snapshot exists
   * for the given (path, session) pair. Internal callers should prefer
   * `checkChanged` which already encodes the "no prior read" case.
   */
  hasRead(absolutePath: string, sessionId?: string): boolean {
    return this.snapshots.has(this.buildKey(absolutePath, sessionId));
  }
}

/**
 * Process-wide singleton. Exported as a function so test setups can
 * obtain a stable reference and call `.clear()` between cases without
 * importing internal state.
 */
let processTracker: FileChangeTracker | null = null;

export function getProcessFileChangeTracker(): FileChangeTracker {
  if (processTracker === null) processTracker = new FileChangeTracker();
  return processTracker;
}

/**
 * Test-only helper — replace the process singleton with a fresh
 * instance. Production code never calls this; tests that want to
 * isolate the tracker without affecting other suites use this in
 * `beforeEach`.
 */
export function setProcessFileChangeTracker(next: FileChangeTracker): void {
  processTracker = next;
}
