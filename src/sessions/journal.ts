/**
 * Per-session crash-resilient journal.
 *
 * On crash (process kill, OOM, SIGINT mid-stream), the SQLite-backed
 * `SessionManager` only persists fully-committed messages. In-flight
 * stream chunks and unsent user input are lost. This module records
 * those events to an append-only JSONL file with a synchronous flush
 * per event so power-loss and SIGKILL leave a recoverable trail.
 *
 * Layout:
 *   ~/.localcode/journal/<sessionId>.jsonl         — active journals
 *   ~/.localcode/journal/archive/<sessionId>-<ts>.jsonl
 *                                                  — archived journals
 *
 * Recovery contract:
 *   - A journal is "recoverable" iff its LAST event is NOT
 *     `{ type: 'session_end', data: { reason: 'clean' } }`.
 *   - `recoverableJournals()` filters by that predicate.
 *   - `archiveJournal(sid)` moves a file into the archive dir.
 *
 * The writer uses `fs.writeSync` + `fs.fsyncSync` per `append()` so a
 * `kill -9` or sudden power loss leaves every previously-flushed event
 * on disk. The trade-off (an fsync per chunk) is documented at the
 * call site; the writer also accepts a buffered mode for callers that
 * want to amortise fsync cost across N events / X ms.
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

// ---------- Public types ----------

/**
 * Event types persisted to the journal. The shape is intentionally
 * lean — recoverers don't need rich structure, only enough to know
 * what was in flight when the crash happened.
 */
export type JournalEventType =
  | 'session_start'
  | 'user_input'
  | 'chunk'
  | 'tool_call_start'
  | 'tool_call_done'
  | 'message_committed'
  | 'session_end';

/**
 * Single line in the JSONL file. `ts` is `Date.now()` at append time.
 * `data` carries event-specific payload (typed as `unknown` so the
 * writer never has to introspect; readers parse via Zod or by-type
 * narrowing at the call site).
 */
export interface JournalEvent {
  readonly ts: number;
  readonly type: JournalEventType;
  readonly data: unknown;
}

/**
 * Constructor options for {@link JournalWriter}. Defaults mirror the
 * "safe by default" stance — sync flush per append. Tests and
 * performance-sensitive call sites can opt into buffered mode.
 */
export interface JournalWriterOptions {
  /**
   * Override the directory under which the per-session JSONL lives.
   * Defaults to `~/.localcode/journal`. Tests pass a tmp dir.
   */
  readonly directory?: string;
  /**
   * When > 0 the writer batches up to N events before flushing to disk
   * (sync write happens immediately; the `fsync` is deferred). Defaults
   * to 1 ⇒ fsync every append. Bumping to 8–16 noticeably reduces I/O
   * pressure on high-throughput streams; the exposed `flush()` method
   * still allows callers to force a checkpoint at boundaries (e.g.
   * just before SIGTERM / clean close).
   */
  readonly fsyncEveryN?: number;
}

/**
 * Result row returned by {@link recoverableJournals}. Carries enough
 * metadata for the recovery prompt UI to render a snippet preview
 * without re-reading the file.
 */
export interface RecoverableJournal {
  /** Session id parsed from the filename. */
  readonly sessionId: string;
  /** Absolute path to the journal file. */
  readonly filepath: string;
  /** Last successfully parsed event. `null` when the file is empty. */
  readonly lastEvent: JournalEvent | null;
  /** Total event count in the file. Useful for UI hints. */
  readonly eventCount: number;
}

// ---------- Module-level defaults ----------

/** Default journal directory under the user's home. */
export const DEFAULT_JOURNAL_DIR = path.join(
  homedir(),
  '.localcode',
  'journal',
);

/** Default archive directory (sibling of the active journal dir). */
export const DEFAULT_ARCHIVE_DIR = path.join(DEFAULT_JOURNAL_DIR, 'archive');

// ---------- JournalWriter ----------

/**
 * Append-only writer for one session's crash journal.
 *
 * Thread-safety: each writer owns a single file descriptor; concurrent
 * `append()` calls from the same Node thread are serialised by the
 * event loop (writeSync is synchronous). Two JournalWriters MUST NOT
 * be opened against the same path simultaneously — the caller is
 * responsible for ensuring at most one writer per session id.
 */
export class JournalWriter {
  private readonly sessionId: string;
  private readonly filepathInternal: string;
  private fd: number | null;
  private readonly fsyncEveryN: number;
  private appendsSinceFsync: number;

  constructor(sessionId: string, options?: JournalWriterOptions) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('JournalWriter: sessionId must be a non-empty string');
    }
    this.sessionId = sessionId;
    const dir = options?.directory ?? DEFAULT_JOURNAL_DIR;
    fs.mkdirSync(dir, { recursive: true });
    this.filepathInternal = path.join(dir, `${sessionId}.jsonl`);
    // 'a' = append mode. Each writeSync goes to EOF atomically (POSIX).
    this.fd = fs.openSync(this.filepathInternal, 'a');
    const everyN = options?.fsyncEveryN;
    this.fsyncEveryN =
      typeof everyN === 'number' && Number.isFinite(everyN) && everyN > 0
        ? Math.floor(everyN)
        : 1;
    this.appendsSinceFsync = 0;
  }

  /** Absolute path of the journal file this writer owns. */
  get filepath(): string {
    return this.filepathInternal;
  }

  /** True once `close()` has been called. */
  get isClosed(): boolean {
    return this.fd === null;
  }

  /**
   * Append a single event. Writes synchronously and (by default) calls
   * `fsync` so a SIGKILL immediately after this return cannot lose the
   * event. Throws if the writer is already closed.
   */
  append(event: JournalEvent): void {
    if (this.fd === null) {
      throw new Error(
        `JournalWriter: append on closed writer for session ${this.sessionId}`,
      );
    }
    // Stringify defensively — a circular `data` shouldn't crash the
    // whole stream; fall back to a marker so the recoverer can still
    // surface a usable last event.
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch {
      const safe: JournalEvent = {
        ts: event.ts,
        type: event.type,
        data: { _error: 'unserialisable' },
      };
      line = `${JSON.stringify(safe)}\n`;
    }
    fs.writeSync(this.fd, line);
    this.appendsSinceFsync += 1;
    if (this.appendsSinceFsync >= this.fsyncEveryN) {
      try {
        fs.fsyncSync(this.fd);
      } catch {
        // Non-fatal — write already hit kernel buffers; a later flush
        // / close will retry.
      }
      this.appendsSinceFsync = 0;
    }
  }

  /**
   * Force a synchronous flush of any buffered events. Useful at known
   * boundaries (just before a slow operation, before SIGTERM, etc.)
   * without paying for fsync on every event.
   */
  flush(): void {
    if (this.fd === null) return;
    if (this.appendsSinceFsync === 0) return;
    try {
      fs.fsyncSync(this.fd);
    } catch {
      // best-effort
    }
    this.appendsSinceFsync = 0;
  }

  /**
   * Append the terminal `session_end` event and close the fd. Idempotent
   * — calling close twice is a no-op (returns immediately the second
   * time).
   */
  close(reason: 'clean' | 'crash' = 'clean'): void {
    if (this.fd === null) return;
    // Best-effort: record the end marker. If it fails we still close the
    // fd; the file simply won't be tagged as cleanly closed and will be
    // surfaced as recoverable on next start (safer than silently losing
    // a session_end).
    try {
      this.append({
        ts: Date.now(),
        type: 'session_end',
        data: { reason },
      });
      this.flush();
    } catch {
      // ignore
    }
    try {
      fs.closeSync(this.fd);
    } catch {
      // ignore
    }
    this.fd = null;
  }
}

// ---------- Static helpers ----------

/**
 * Parse a JSONL file into an ordered array of {@link JournalEvent}s.
 * Lines that fail to parse are skipped (the writer tolerates partial
 * tail writes by design — see `append`).
 *
 * Exposed so the recovery prompt UI can render a snippet preview of
 * the last few events without re-implementing the loop.
 */
export function readJournalEvents(filepath: string): JournalEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filepath, 'utf8');
  } catch {
    return [];
  }
  const out: JournalEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isJournalEvent(parsed)) out.push(parsed);
    } catch {
      // skip malformed line (partial tail write).
    }
  }
  return out;
}

/**
 * Scan the journal directory and return entries whose last event is
 * NOT a clean `session_end`. Empty files are surfaced as recoverable
 * with `lastEvent === null` so the recovery UI can decide whether to
 * archive them (the default action) or ignore.
 */
export function recoverableJournals(
  directory: string = DEFAULT_JOURNAL_DIR,
): RecoverableJournal[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const out: RecoverableJournal[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const filepath = path.join(directory, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filepath);
    } catch {
      continue;
    }
    // Skip directories named like `<x>.jsonl` (defensive — shouldn't
    // happen but guards against a stray `archive.jsonl` directory).
    if (!stat.isFile()) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    const events = readJournalEvents(filepath);
    const eventCount = events.length;
    const lastEvent = eventCount > 0 ? (events[eventCount - 1] ?? null) : null;
    if (isCleanSessionEnd(lastEvent)) continue;
    out.push({
      sessionId,
      filepath,
      lastEvent,
      eventCount,
    });
  }
  // Most recently modified first so the recovery prompt highlights the
  // freshest crash.
  out.sort((a, b) => {
    try {
      const aStat = fs.statSync(a.filepath);
      const bStat = fs.statSync(b.filepath);
      return bStat.mtimeMs - aStat.mtimeMs;
    } catch {
      return 0;
    }
  });
  return out;
}

/**
 * Move a journal file from the active directory to the archive
 * subdirectory, tagging it with the current ISO date. Idempotent —
 * a missing source file is a no-op (returns `false`).
 *
 * Returns `true` when the rename succeeded.
 */
export function archiveJournal(
  sessionId: string,
  options?: { directory?: string; archiveDir?: string },
): boolean {
  const dir = options?.directory ?? DEFAULT_JOURNAL_DIR;
  const archiveDir = options?.archiveDir ?? path.join(dir, 'archive');
  const src = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(src)) return false;
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
  } catch {
    // mkdir may fail if a regular file with the same name exists.
    // Treat that as a non-archivable state and bail.
    return false;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(archiveDir, `${sessionId}-${stamp}.jsonl`);
  try {
    fs.renameSync(src, dest);
    return true;
  } catch {
    // EXDEV (cross-device link): fall back to copy + unlink.
    try {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Permanently delete a journal file from the active directory. Used
 * when the user explicitly discards a recoverable session in the
 * recovery prompt. No-op when the file doesn't exist.
 */
export function discardJournal(
  sessionId: string,
  directory: string = DEFAULT_JOURNAL_DIR,
): boolean {
  const src = path.join(directory, `${sessionId}.jsonl`);
  if (!fs.existsSync(src)) return false;
  try {
    fs.unlinkSync(src);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prune archived journals older than `maxAgeMs` (default 30 days). The
 * recovery system grows monotonically without this; the TUI invokes it
 * once on startup so the archive folder stays bounded. No-op when the
 * archive dir doesn't exist. Returns the number of files removed.
 */
export function pruneArchivedJournals(
  options?: { archiveDir?: string; maxAgeMs?: number },
): number {
  const archiveDir = options?.archiveDir ?? DEFAULT_ARCHIVE_DIR;
  const maxAge =
    options?.maxAgeMs !== undefined && Number.isFinite(options.maxAgeMs)
      ? Math.max(0, Math.floor(options.maxAgeMs))
      : 30 * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = fs.readdirSync(archiveDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAge;
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const filepath = path.join(archiveDir, name);
    try {
      const stat = fs.statSync(filepath);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filepath);
        removed += 1;
      }
    } catch {
      // best-effort — skip on stat/unlink failure.
    }
  }
  return removed;
}

// ---------- Internals ----------

function isJournalEvent(value: unknown): value is JournalEvent {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['ts'] !== 'number') return false;
  if (typeof obj['type'] !== 'string') return false;
  // `data` is `unknown` by contract — anything goes.
  return true;
}

function isCleanSessionEnd(event: JournalEvent | null): boolean {
  if (event === null) return false;
  if (event.type !== 'session_end') return false;
  const data = event.data;
  if (data === null || typeof data !== 'object') return false;
  const reason = (data as Record<string, unknown>)['reason'];
  return reason === 'clean';
}
