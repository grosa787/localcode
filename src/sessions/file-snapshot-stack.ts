/**
 * FileSnapshotStack — in-memory ring buffer of pre-mutation file snapshots.
 *
 * Used by `/undo` to roll back the last N file mutations performed by
 * `write_file` / `edit_file` / `multi_edit` during the current process
 * lifetime. Snapshots are taken BEFORE the tool commits the change so
 * `/undo` can restore the file to its pre-edit state.
 *
 * Contract:
 *   - `push(path, contentBefore)` records a snapshot. `contentBefore`
 *     is `null` when the file did not exist before the mutation (new
 *     file). Restoring such a snapshot deletes the file.
 *   - `pop()` removes and returns the most recent snapshot, or `null`
 *     when the stack is empty.
 *   - `list()` returns a copy of the snapshot stack in newest-first
 *     order — UI callers (e.g. `/undo list`) consume it as-is.
 *   - `clear()` empties the stack — primarily for `/clear` and tests.
 *
 * Storage policy:
 *   - In-memory only. The buffer is process-scoped — restarting
 *     LocalCode drops every snapshot. Documented in the `/undo` help
 *     text so users don't expect cross-restart persistence.
 *   - Ring buffer with capacity `DEFAULT_CAPACITY` (10). Older entries
 *     are silently evicted — `/undo` is meant for "last few" recovery,
 *     not a full audit log.
 */

export interface FileSnapshotEntry {
  /** Absolute or project-relative path the snapshot was taken for. */
  readonly path: string;
  /**
   * File contents before the mutation. `null` means the file did not
   * exist (the mutation created it); restoring deletes the file.
   */
  readonly contentBefore: string | null;
  /** `Date.now()` at push-time. Surfaced by `/undo list`. */
  readonly timestamp: number;
  /** Tool that produced the mutation. Surfaced by `/undo list`. */
  readonly toolName: string;
}

const DEFAULT_CAPACITY = 10;

export class FileSnapshotStack {
  private readonly capacity: number;
  private readonly entries: FileSnapshotEntry[] = [];

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity =
      Number.isFinite(capacity) && capacity > 0
        ? Math.floor(capacity)
        : DEFAULT_CAPACITY;
  }

  /**
   * Record a snapshot of a file's pre-mutation state. Pushes onto the
   * ring buffer; when full, the oldest entry is evicted.
   */
  push(
    path: string,
    contentBefore: string | null,
    toolName: string,
  ): void {
    if (typeof path !== 'string' || path.length === 0) return;
    const entry: FileSnapshotEntry = {
      path,
      contentBefore,
      timestamp: Date.now(),
      toolName,
    };
    this.entries.push(entry);
    // Evict the oldest entry when over capacity. The buffer is small
    // (default 10), so the shift is cheap; no need for a circular array.
    while (this.entries.length > this.capacity) {
      this.entries.shift();
    }
  }

  /**
   * Remove and return the most recent snapshot. Returns `null` when the
   * stack is empty.
   */
  pop(): FileSnapshotEntry | null {
    const entry = this.entries.pop();
    return entry ?? null;
  }

  /**
   * Snapshot list in newest-first order. Returns a defensive copy so
   * callers can iterate without disturbing the internal state.
   */
  list(): readonly FileSnapshotEntry[] {
    return this.entries.slice().reverse();
  }

  /** Current snapshot count. */
  get size(): number {
    return this.entries.length;
  }

  /** Configured ring-buffer capacity. */
  get maxCapacity(): number {
    return this.capacity;
  }

  /** Drop every entry. */
  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Process-wide singleton, lazily constructed. Both the TUI composition
 * root (`src/app.tsx`) and the `/undo` slash command read this so the
 * stack survives across React re-renders and command invocations.
 */
let processStack: FileSnapshotStack | null = null;

export function getProcessFileSnapshotStack(): FileSnapshotStack {
  if (processStack === null) {
    processStack = new FileSnapshotStack();
  }
  return processStack;
}

/** Test helper — replaces the singleton (or resets it via `null`). */
export function setProcessFileSnapshotStack(
  stack: FileSnapshotStack | null,
): void {
  processStack = stack;
}
