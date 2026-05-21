/**
 * Process monitor — registers long-running developer processes (dev
 * servers, watch builds, test runners), captures their stdio into
 * ring buffers, and emits structured events the chat loop can react
 * to.
 *
 * Singleton access via `getProcessMonitor()`. The class can also be
 * constructed directly for tests so each suite gets a fresh registry.
 *
 * Output is captured into a per-stream ring buffer capped at
 * `RING_BUFFER_CAP_BYTES` (200 KB) — once exceeded we trim the oldest
 * bytes (FIFO). The registry caps the number of concurrent watched
 * processes at `MAX_WATCHED` (20); oldest-completed entries are
 * evicted first when a new spawn would push us over.
 *
 * Events (via the built-in `EventEmitter` API exposed on the
 * registry):
 *   - `output`     — `(event: ProcessEvent)` for every line read
 *   - `diagnostic` — `(signal: DiagnosticSignal)` when the matcher hits
 *   - `exit`       — `(event: { processId, exitCode, signal })`
 *
 * `'diagnostic'` events are throttled per `(processId, signature)`
 * tuple — same signature within `DIAGNOSTIC_THROTTLE_MS` (30 s) is
 * suppressed. This keeps a watch-mode tool that keeps emitting the
 * same compile error every save from spamming the chat.
 */

import { EventEmitter } from 'node:events';
import { execa, type ResultPromise } from 'execa';
import path from 'node:path';

import { diagnose } from './diagnoser';
import type {
  DiagnosticSignal,
  ProcessEvent,
  ProcessHealth,
  WatchedProcess,
} from './types';

/** Per-stream byte cap. Combined ceiling is ~400 KB across the two streams. */
export const RING_BUFFER_CAP_BYTES = 200_000;
/** Maximum number of concurrent watched processes. */
export const MAX_WATCHED = 20;
/** Default throttle window for duplicate diagnostic signatures. */
export const DIAGNOSTIC_THROTTLE_MS = 30_000;
/** How many recent lines to keep per stream for `list()`. */
export const RECENT_LINES_KEPT = 50;
/** Grace period between SIGTERM and SIGKILL on `unwatch`. */
export const KILL_GRACE_MS = 3_000;

/** Options passed to `ProcessMonitor.watch`. */
export interface WatchOptions {
  /** Shell command to spawn. */
  readonly command: string;
  /** Working directory (absolute or relative to process.cwd()). Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Optional human-readable label for the panel + status output. */
  readonly label?: string;
}

/**
 * Lightweight ring buffer that keeps a tail of the most-recent text up
 * to `cap` bytes, plus a separate per-line tail of the most recent
 * `recentLines` entries.
 *
 * Mirrors the buffer used by `BackgroundTaskRegistry` but is tracked
 * here as its own class so the process-monitor can also surface a
 * line-bounded recent tail without re-parsing the byte buffer.
 */
class RingBuffer {
  private body = '';
  private dropped = 0;
  private readonly cap: number;
  private readonly lines: string[] = [];
  private readonly linesCap: number;
  /** Partial line carried over between reads (no newline yet). */
  private partial = '';

  constructor(cap: number, linesCap: number) {
    this.cap = cap;
    this.linesCap = linesCap;
  }

  /** Append a chunk and emit each completed line via `onLine`. */
  append(chunk: string, onLine: (line: string) => void): void {
    if (chunk.length === 0) return;
    this.body = `${this.body}${chunk}`;
    if (this.body.length > this.cap) {
      const overflow = this.body.length - this.cap;
      this.body = this.body.slice(overflow);
      this.dropped += overflow;
    }
    // Line-split using the partial carry-over.
    let buf = `${this.partial}${chunk}`;
    let newlineIdx = buf.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buf.slice(0, newlineIdx).replace(/\r$/, '');
      buf = buf.slice(newlineIdx + 1);
      this.pushLine(line);
      onLine(line);
      newlineIdx = buf.indexOf('\n');
    }
    this.partial = buf;
  }

  /** Flush any trailing partial line (no newline). Called on stream close. */
  flushPartial(onLine: (line: string) => void): void {
    if (this.partial.length === 0) return;
    const line = this.partial.replace(/\r$/, '');
    this.partial = '';
    this.pushLine(line);
    onLine(line);
  }

  /** Last N retained lines. */
  recent(): readonly string[] {
    return this.lines.slice();
  }

  /** Cumulative byte count post-trim. */
  size(): number {
    return this.body.length;
  }

  private pushLine(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.linesCap) {
      this.lines.splice(0, this.lines.length - this.linesCap);
    }
  }
}

/** Internal record stored in the registry map. */
interface ProcessRecord {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly label: string;
  pid: number | null;
  health: ProcessHealth;
  exitCode: number | null;
  readonly startedAt: number;
  exitedAt: number | null;
  readonly child: ResultPromise | null;
  readonly stdout: RingBuffer;
  readonly stderr: RingBuffer;
  /** Throttle map: signature → last-emit timestamp (ms). */
  readonly throttle: Map<string, number>;
}

/** Generate a short unique watch id. */
function genId(): string {
  return `pm_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Coerce a stream chunk (Buffer / string / Uint8Array / unknown) into
 * a utf-8 string. Identical to the helper inside `background-tasks.ts`
 * — duplicated here to keep `process-monitor/` independent of the
 * tools layer.
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

/**
 * Process monitor — wraps `execa` spawns and surfaces ring-buffered
 * output, diagnostic categorisation, and a clean disposal path.
 *
 * The class extends `EventEmitter` (rather than holding one) so
 * subscribers can use the standard `.on(...)` / `.off(...)` API.
 */
export class ProcessMonitor extends EventEmitter {
  private readonly records = new Map<string, ProcessRecord>();
  private disposed = false;
  /** Override for `execa` — tests inject a fake to avoid spawning real children. */
  private readonly spawn: (
    command: string,
    args: readonly string[],
    options: { cwd: string },
  ) => ResultPromise;
  /** Allow tests to control "now" for throttle assertions. */
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly maxWatched: number;

  constructor(opts?: {
    readonly spawn?: (
      command: string,
      args: readonly string[],
      options: { cwd: string },
    ) => ResultPromise;
    readonly now?: () => number;
    readonly throttleMs?: number;
    readonly maxWatched?: number;
  }) {
    super();
    const spawnOpt = opts?.spawn;
    this.spawn =
      spawnOpt ??
      ((command, args, options): ResultPromise => execa(command, [...args], options));
    this.now = opts?.now ?? ((): number => Date.now());
    this.throttleMs = opts?.throttleMs ?? DIAGNOSTIC_THROTTLE_MS;
    this.maxWatched = opts?.maxWatched ?? MAX_WATCHED;
  }

  /**
   * Begin watching a command. Returns the generated watch id.
   *
   * On spawn failure, the record is still registered with health
   * `'exited'` and exitCode `null` so the model can see the failure.
   */
  watch(opts: WatchOptions): { readonly id: string } {
    if (this.disposed) {
      throw new Error('ProcessMonitor: disposed');
    }
    if (opts.command.trim().length === 0) {
      throw new Error('ProcessMonitor.watch: command must be non-empty');
    }
    this.evictIfOverCap();
    const id = genId();
    const cwd = path.isAbsolute(opts.cwd ?? '')
      ? (opts.cwd as string)
      : path.resolve(process.cwd(), opts.cwd ?? '.');
    const label = opts.label ?? opts.command;
    const startedAt = this.now();

    let child: ResultPromise | null = null;
    try {
      child = this.spawn('sh', ['-c', opts.command], { cwd });
    } catch {
      child = null;
    }

    const record: ProcessRecord = {
      id,
      command: opts.command,
      cwd,
      label,
      pid: child !== null && typeof child.pid === 'number' ? child.pid : null,
      health: child === null ? 'exited' : 'alive',
      exitCode: child === null ? null : null,
      startedAt,
      exitedAt: child === null ? startedAt : null,
      child,
      stdout: new RingBuffer(RING_BUFFER_CAP_BYTES, RECENT_LINES_KEPT),
      stderr: new RingBuffer(RING_BUFFER_CAP_BYTES, RECENT_LINES_KEPT),
      throttle: new Map(),
    };
    this.records.set(id, record);
    if (child !== null) {
      this.wireChild(record, child);
    } else {
      // Synthesise an immediate `exit` event so subscribers still see a terminal signal.
      queueMicrotask(() => {
        this.emit('exit', { processId: id, exitCode: null, signal: 'spawn-failed' });
      });
    }
    return { id };
  }

  /**
   * Stop watching a process: SIGTERM, then SIGKILL after `KILL_GRACE_MS`.
   * No-op for already-terminal processes. Returns whether a signal was
   * delivered.
   */
  async unwatch(id: string): Promise<boolean> {
    const rec = this.records.get(id);
    if (rec === undefined) return false;
    if (rec.health !== 'alive' || rec.child === null) {
      this.records.delete(id);
      return false;
    }
    let signalled = false;
    try {
      signalled = rec.child.kill('SIGTERM');
    } catch {
      signalled = false;
    }
    if (!signalled) {
      this.records.delete(id);
      return false;
    }
    const child = rec.child;
    const escalation = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* swallow */
      }
    }, KILL_GRACE_MS);
    // Wait for the child to settle. Errors from a SIGTERM are expected.
    try {
      await child;
    } catch {
      /* expected */
    } finally {
      clearTimeout(escalation);
    }
    // Mark killed if it didn't already flip via the exit listener.
    if (rec.health === 'alive') {
      rec.health = 'killed';
      rec.exitedAt = this.now();
    }
    return true;
  }

  /**
   * Snapshot of every watched process — `WatchedProcess` is the wire
   * type surfaced by the `process_status` tool and the TUI panel.
   */
  list(): readonly WatchedProcess[] {
    const out: WatchedProcess[] = [];
    for (const rec of this.records.values()) {
      out.push(this.toWatchedProcess(rec));
    }
    return out;
  }

  /** Snapshot a single process by id. */
  get(id: string): WatchedProcess | null {
    const rec = this.records.get(id);
    if (rec === undefined) return null;
    return this.toWatchedProcess(rec);
  }

  /** Number of currently-watched processes (any health). */
  size(): number {
    return this.records.size;
  }

  /**
   * Manually run the diagnoser against the most-recent output of a
   * watched process. Returns the signal (also emitted as a
   * `'diagnostic'` event) or null when nothing matched.
   *
   * Used by the `/diagnose` slash command. Bypasses the throttle map
   * intentionally — when a user explicitly asks for a diagnostic,
   * they get one even if the same signature was recently suppressed.
   */
  diagnoseNow(id: string, lineLimit = 200): DiagnosticSignal | null {
    const rec = this.records.get(id);
    if (rec === undefined) return null;
    const combined: string[] = [];
    for (const line of rec.stdout.recent()) combined.push(line);
    for (const line of rec.stderr.recent()) combined.push(line);
    const tail = combined.slice(-Math.max(1, lineLimit));
    const signal = diagnose({ processId: id, lines: tail, at: this.now() });
    if (signal !== null) {
      // Update the throttle map but bypass the throttle gate for explicit calls.
      rec.throttle.set(signal.signature, this.now());
      this.emit('diagnostic', signal);
    }
    return signal;
  }

  /**
   * Kill every alive process and clear the records map. Best-effort —
   * never throws. Used by the CLI / web shutdown path.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pending: Array<Promise<void>> = [];
    for (const rec of this.records.values()) {
      if (rec.health !== 'alive' || rec.child === null) continue;
      pending.push(
        (async (): Promise<void> => {
          try {
            rec.child?.kill('SIGTERM');
          } catch {
            /* swallow */
          }
          const escalation = setTimeout(() => {
            try {
              rec.child?.kill('SIGKILL');
            } catch {
              /* swallow */
            }
          }, KILL_GRACE_MS);
          try {
            await rec.child;
          } catch {
            /* expected */
          } finally {
            clearTimeout(escalation);
          }
        })(),
      );
    }
    await Promise.all(pending);
    this.records.clear();
  }

  /** Test helper — return known watch ids. */
  ids(): readonly string[] {
    return [...this.records.keys()];
  }

  // ---------- internals ----------

  /**
   * Render the live record into the public `WatchedProcess` shape. The
   * health field is computed; `recentStdout/Stderr` are bounded snapshots.
   */
  private toWatchedProcess(rec: ProcessRecord): WatchedProcess {
    return {
      id: rec.id,
      command: rec.command,
      cwd: rec.cwd,
      label: rec.label,
      pid: rec.pid,
      health: rec.health,
      startedAt: rec.startedAt,
      exitedAt: rec.exitedAt,
      exitCode: rec.exitCode,
      stdoutBytes: rec.stdout.size(),
      stderrBytes: rec.stderr.size(),
      recentStdout: rec.stdout.recent(),
      recentStderr: rec.stderr.recent(),
    };
  }

  /**
   * FIFO eviction when the registry would exceed the cap. Oldest
   * EXITED record is removed first; if every record is still alive,
   * we evict the oldest by `startedAt`.
   */
  private evictIfOverCap(): void {
    if (this.records.size < this.maxWatched) return;
    const all = [...this.records.values()];
    const exited = all.filter((r) => r.health !== 'alive');
    if (exited.length > 0) {
      exited.sort((a, b) => a.startedAt - b.startedAt);
      const victim = exited[0];
      if (victim !== undefined) {
        this.records.delete(victim.id);
        return;
      }
    }
    // All alive — evict the oldest. We do NOT kill it here because the
    // user explicitly asked us to watch it; the cap is "soft" in that
    // sense. The model still sees the record disappear from `list()`.
    all.sort((a, b) => a.startedAt - b.startedAt);
    const victim = all[0];
    if (victim !== undefined) this.records.delete(victim.id);
  }

  /** Attach stdout/stderr/exit listeners. Output flows into the ring buffers + diagnoser. */
  private wireChild(rec: ProcessRecord, child: ResultPromise): void {
    const handleLine = (stream: 'stdout' | 'stderr', line: string): void => {
      const event: ProcessEvent = {
        processId: rec.id,
        stream,
        line,
        at: this.now(),
      };
      this.emit('output', event);
      // Run the diagnoser only on the most recent few lines (the matcher
      // walks newest-first so this gives equivalent results to running
      // it over the whole buffer, with much less work per line).
      const combined: string[] = [];
      for (const recent of rec.stdout.recent()) combined.push(recent);
      for (const recent of rec.stderr.recent()) combined.push(recent);
      const signal = diagnose({
        processId: rec.id,
        lines: combined,
        at: this.now(),
      });
      if (signal === null) return;
      const last = rec.throttle.get(signal.signature);
      const now = this.now();
      if (last !== undefined && now - last < this.throttleMs) return;
      rec.throttle.set(signal.signature, now);
      this.emit('diagnostic', signal);
    };

    if (child.stdout !== null && child.stdout !== undefined) {
      child.stdout.on('data', (chunk: unknown) => {
        rec.stdout.append(coerceChunk(chunk), (line) => handleLine('stdout', line));
      });
    }
    if (child.stderr !== null && child.stderr !== undefined) {
      child.stderr.on('data', (chunk: unknown) => {
        rec.stderr.append(coerceChunk(chunk), (line) => handleLine('stderr', line));
      });
    }

    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (rec.health !== 'alive') return;
      rec.stdout.flushPartial((line) => handleLine('stdout', line));
      rec.stderr.flushPartial((line) => handleLine('stderr', line));
      rec.exitCode = typeof code === 'number' ? code : null;
      rec.exitedAt = this.now();
      rec.health = signal !== null ? 'killed' : 'exited';
      this.emit('exit', {
        processId: rec.id,
        exitCode: rec.exitCode,
        signal: signal ?? null,
      });
    };

    // execa's ResultPromise also exposes the underlying child's events.
    // Both `exit` and `error` need to be handled — `error` fires when
    // spawn itself fails after the promise was returned.
    child.on?.('exit', handleExit);
    child.on?.('error', () => {
      if (rec.health !== 'alive') return;
      rec.health = 'exited';
      rec.exitCode = null;
      rec.exitedAt = this.now();
      this.emit('exit', { processId: rec.id, exitCode: null, signal: 'error' });
    });
    // Defensive: await the promise without throwing so an unhandled
    // rejection from execa's killed-with-error path doesn't propagate.
    child.catch?.(() => {
      /* swallow — exit listener already updated state */
    });
  }
}

// ---------- process-wide singleton ----------

let singleton: ProcessMonitor | null = null;

/** Shared process-wide monitor; lazily instantiated. */
export function getProcessMonitor(): ProcessMonitor {
  if (singleton === null) {
    singleton = new ProcessMonitor();
  }
  return singleton;
}

/** Test/shutdown helper — replace or clear the process singleton. */
export function setProcessMonitor(monitor: ProcessMonitor | null): void {
  singleton = monitor;
}
