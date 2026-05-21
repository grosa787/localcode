/**
 * Background task registry — keeps live handles to long-running shell
 * commands spawned via `run_command` with `runInBackground: true`.
 *
 * The registry is a process-wide singleton because the model issues a
 * tool call that returns a `taskId` and later polls a separate `monitor`
 * tool call referencing the SAME id. Both tool calls run inside the same
 * Node/Bun process, so a `Map` is enough — no IPC required.
 *
 * Output is captured into a ring buffer (per stream) capped at
 * `RING_BUFFER_CAP_BYTES` (200 KB). When the cap is exceeded we drop the
 * oldest bytes (FIFO) and prefix the returned slice with a
 * `[...truncated, N bytes earlier...]` marker so the model knows it is
 * looking at a tail.
 *
 * Lifecycle: register on spawn. The child's `exit` listener flips
 * `status` to `completed` / `failed` and records `exitCode`. `dispose()`
 * SIGKILLs every still-running child (so a CLI/web shutdown does not
 * leak background processes).
 */

import type { Subprocess } from 'execa';

/** Per-stream cap. Combined ceiling is therefore ~400 KB across the two streams. */
export const RING_BUFFER_CAP_BYTES = 200_000;

/** Status of a registered background task. */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed';

/**
 * Lightweight ring buffer that stores at most `cap` bytes of utf-8 text.
 *
 * Internally we keep a single string and trim from the front whenever the
 * buffered length exceeds the cap. That is O(n) per overflow but
 * acceptable for a tool that is fundamentally bounded by what a model
 * actually wants to consume.
 */
class RingBuffer {
  private body = '';
  private dropped = 0;
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  /** Append a chunk; trim from the front when over cap. */
  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.body = `${this.body}${chunk}`;
    if (this.body.length > this.cap) {
      const overflow = this.body.length - this.cap;
      this.body = this.body.slice(overflow);
      this.dropped += overflow;
    }
  }

  /** Snapshot the buffered text with a truncation marker if applicable. */
  snapshot(): string {
    if (this.dropped === 0) return this.body;
    return `[...truncated, ${this.dropped} bytes earlier...]\n${this.body}`;
  }

  /** Raw byte count currently buffered (excluding the truncation marker). */
  size(): number {
    return this.body.length;
  }
}

/**
 * Internal record stored in the map. Public callers receive a slice via
 * the `snapshot()` method on the registry.
 */
interface BackgroundTaskRecord {
  readonly taskId: string;
  readonly child: Subprocess;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  readonly stdoutBuf: RingBuffer;
  readonly stderrBuf: RingBuffer;
  readonly startedAt: number;
  finishedAt: number | null;
  /** Wakers invoked whenever status changes or new output is appended. */
  readonly listeners: Set<() => void>;
}

/** Public snapshot returned by the monitor tool. */
export interface BackgroundTaskSnapshot {
  taskId: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  durationMs: number;
  /** Cumulative byte counts (post ring-buffer trim) — diagnostic. */
  stdoutBytes: number;
  stderrBytes: number;
}

/** Random taskId — short enough to read out, long enough to avoid collisions. */
function genTaskId(): string {
  return `bg_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Process-wide registry for background `run_command` invocations.
 *
 * Singleton access via `getProcessBackgroundTaskRegistry()`. Direct
 * construction is exposed so tests can build an isolated instance.
 */
export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private disposed = false;

  /** Register a freshly-spawned child. Returns the generated taskId. */
  register(child: Subprocess): string {
    if (this.disposed) {
      throw new Error('BackgroundTaskRegistry: already disposed');
    }
    const taskId = genTaskId();
    const record: BackgroundTaskRecord = {
      taskId,
      child,
      status: 'running',
      exitCode: null,
      stdoutBuf: new RingBuffer(RING_BUFFER_CAP_BYTES),
      stderrBuf: new RingBuffer(RING_BUFFER_CAP_BYTES),
      startedAt: Date.now(),
      finishedAt: null,
      listeners: new Set(),
    };
    this.tasks.set(taskId, record);
    this.wireChild(record);
    return taskId;
  }

  /** Public snapshot. Returns `null` when the task does not exist. */
  get(taskId: string): BackgroundTaskSnapshot | null {
    const rec = this.tasks.get(taskId);
    if (rec === undefined) return null;
    const finishedAt = rec.finishedAt ?? Date.now();
    return {
      taskId: rec.taskId,
      status: rec.status,
      exitCode: rec.exitCode,
      stdout: rec.stdoutBuf.snapshot(),
      stderr: rec.stderrBuf.snapshot(),
      startedAt: rec.startedAt,
      durationMs: finishedAt - rec.startedAt,
      stdoutBytes: rec.stdoutBuf.size(),
      stderrBytes: rec.stderrBuf.size(),
    };
  }

  /**
   * Send SIGTERM to a running task. No-op for already-terminal tasks.
   * Returns whether a kill signal was actually delivered.
   */
  kill(taskId: string): boolean {
    const rec = this.tasks.get(taskId);
    if (rec === undefined) return false;
    if (rec.status !== 'running') return false;
    try {
      rec.child.kill('SIGTERM');
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Block until either the task's status changes from `running` or new
   * output is appended to either stream. Resolves immediately if the
   * task is already terminal. Returns `true` if an event woke the
   * waiter, `false` if the timeout fired first.
   */
  waitForChange(taskId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const rec = this.tasks.get(taskId);
      if (rec === undefined) {
        resolve(false);
        return;
      }
      if (rec.status !== 'running') {
        resolve(true);
        return;
      }
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        rec.listeners.delete(listener);
        clearTimeout(timer);
        resolve(result);
      };
      const listener = (): void => {
        finish(true);
      };
      rec.listeners.add(listener);
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    });
  }

  /** Number of currently-registered tasks (any status). */
  size(): number {
    return this.tasks.size;
  }

  /**
   * Kill every still-running child and clear the map. Used on process
   * shutdown so background commands do not outlive the CLI.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const rec of this.tasks.values()) {
      if (rec.status !== 'running') continue;
      try {
        rec.child.kill('SIGTERM');
      } catch {
        /* swallow */
      }
    }
    // Best-effort wait so children get a chance to exit cleanly. We
    // intentionally do NOT block forever — callers (CLI / web shutdown)
    // want this to return promptly so the process can exit.
    const KILL_GRACE_MS = 250;
    const races = [...this.tasks.values()]
      .filter((rec) => rec.status === 'running')
      .map(
        (rec) =>
          new Promise<void>((resolve) => {
            const settle = (): void => resolve();
            rec.listeners.add(settle);
            setTimeout(() => {
              rec.listeners.delete(settle);
              try {
                rec.child.kill('SIGKILL');
              } catch {
                /* swallow */
              }
              resolve();
            }, KILL_GRACE_MS);
          }),
      );
    await Promise.all(races);
    this.tasks.clear();
  }

  /** Test-only — list known task ids. */
  ids(): readonly string[] {
    return [...this.tasks.keys()];
  }

  /**
   * Attach stdout/stderr/exit listeners. Output goes into the ring
   * buffer; exit flips status and wakes any waiters.
   */
  private wireChild(rec: BackgroundTaskRecord): void {
    const wakeListeners = (): void => {
      for (const fn of rec.listeners) {
        try {
          fn();
        } catch {
          /* swallow */
        }
      }
    };

    if (rec.child.stdout !== null && rec.child.stdout !== undefined) {
      rec.child.stdout.on('data', (chunk: unknown) => {
        rec.stdoutBuf.append(coerceChunk(chunk));
        wakeListeners();
      });
    }
    if (rec.child.stderr !== null && rec.child.stderr !== undefined) {
      rec.child.stderr.on('data', (chunk: unknown) => {
        rec.stderrBuf.append(coerceChunk(chunk));
        wakeListeners();
      });
    }

    rec.child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (rec.status !== 'running') return;
      rec.exitCode = typeof code === 'number' ? code : null;
      rec.status =
        signal !== null || (typeof code === 'number' && code !== 0)
          ? 'failed'
          : 'completed';
      rec.finishedAt = Date.now();
      wakeListeners();
    });

    rec.child.on('error', () => {
      if (rec.status !== 'running') return;
      rec.status = 'failed';
      rec.finishedAt = Date.now();
      wakeListeners();
    });
  }
}

/**
 * Coerce a stream chunk (Buffer / string / Uint8Array / unknown) into a
 * utf-8 string. Buffers and Uint8Arrays decode via TextDecoder; strings
 * pass through unchanged; anything else gets `String(...)`-coerced.
 */
function coerceChunk(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) {
    return new TextDecoder('utf-8', { fatal: false }).decode(chunk);
  }
  if (
    chunk !== null &&
    typeof chunk === 'object' &&
    'toString' in chunk &&
    typeof (chunk as { toString: unknown }).toString === 'function'
  ) {
    return (chunk as { toString: () => string }).toString();
  }
  return String(chunk);
}

let processSingleton: BackgroundTaskRegistry | null = null;

/** Shared process-wide registry; lazily instantiated. */
export function getProcessBackgroundTaskRegistry(): BackgroundTaskRegistry {
  if (processSingleton === null) {
    processSingleton = new BackgroundTaskRegistry();
  }
  return processSingleton;
}

/** Test/shutdown helper — replace or clear the process singleton. */
export function setProcessBackgroundTaskRegistry(
  reg: BackgroundTaskRegistry | null,
): void {
  processSingleton = reg;
}
