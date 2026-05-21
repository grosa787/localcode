/**
 * Type definitions for the process-monitor subsystem.
 *
 * The process monitor watches long-running developer commands (dev
 * servers, watch-mode builds, test runners) and surfaces diagnostic
 * signals (compile failures, runtime stack traces, failing tests) into
 * the chat loop so the model can react without the user having to
 * copy-paste log lines.
 *
 * The exported types here are the wire contract between the registry,
 * diagnoser, slash commands, and TUI panel. They are intentionally free
 * of implementation details so tests can construct fakes directly.
 */

/** Health status of a watched process. */
export type ProcessHealth = 'alive' | 'exited' | 'killed';

/**
 * Severity surfaced by the diagnoser when it categorises a chunk of
 * captured output. Mirrors the LSP-ish lint severity ladder we already
 * use elsewhere (`LintDiagnostic.severity`).
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * Diagnoser category — what kind of failure the pattern matched. Used
 * by the slash command + auto-injector to decide how loud the synthetic
 * message should be. Categories are stable strings; new ones may be
 * added without breaking existing consumers.
 */
export type DiagnosticSource =
  | 'typescript'
  | 'runtime'
  | 'test'
  | 'vite'
  | 'webpack'
  | 'generic';

/**
 * A watched long-running process registered with the monitor. Returned
 * by `ProcessMonitor.list()` and surfaced verbatim through the
 * `process_status` tool so the model can inspect what's running.
 *
 * The `recentStdout` / `recentStderr` fields contain the last 50 lines
 * of each stream so the model has enough context to reason about a
 * failure without paging through the full ring buffer.
 */
export interface WatchedProcess {
  /** Stable id returned by `watch()`. Used by all subsequent calls. */
  readonly id: string;
  /** Original command string (verbatim — pre-shell-split). */
  readonly command: string;
  /** Working directory (absolute) the command was spawned in. */
  readonly cwd: string;
  /** Optional human-readable label supplied at `watch()` time. */
  readonly label: string;
  /** PID when the spawn succeeded; null on spawn failure. */
  readonly pid: number | null;
  /** Current process health. */
  readonly health: ProcessHealth;
  /** Epoch-ms the process was registered. */
  readonly startedAt: number;
  /** Epoch-ms the process exited (null while alive). */
  readonly exitedAt: number | null;
  /** Final exit code when exited, else null. */
  readonly exitCode: number | null;
  /** Total bytes captured on stdout (post ring-buffer trim). */
  readonly stdoutBytes: number;
  /** Total bytes captured on stderr (post ring-buffer trim). */
  readonly stderrBytes: number;
  /** Last 50 lines of stdout. */
  readonly recentStdout: readonly string[];
  /** Last 50 lines of stderr. */
  readonly recentStderr: readonly string[];
}

/**
 * A single output line emitted by a watched process. Carried over the
 * registry's `output` EventEmitter event for any subscriber that wants
 * a live tail (currently only the diagnoser).
 */
export interface ProcessEvent {
  readonly processId: string;
  readonly stream: 'stdout' | 'stderr';
  readonly line: string;
  readonly at: number;
}

/**
 * Result of running the diagnoser on a batch of recent output lines.
 *
 * The diagnoser categorises the batch into one canonical source +
 * severity and returns a `digest` (a short single-line summary the auto
 * injector embeds into the synthetic system message) plus an optional
 * `file:line:column` triple when the matched pattern carried that.
 *
 * `signature` is a stable hash-able string the registry uses to
 * deduplicate identical errors within the throttle window — same
 * signature within 30s suppresses a second `'diagnostic'` emission.
 */
export interface DiagnosticSignal {
  readonly processId: string;
  readonly severity: DiagnosticSeverity;
  readonly source: DiagnosticSource;
  /** Short single-line summary (e.g. "tsc: error TS2322 in src/foo.ts:12"). */
  readonly digest: string;
  /** Optional file path captured by the matched pattern. */
  readonly file: string | null;
  /** Optional 1-based line number. */
  readonly line: number | null;
  /** Optional 1-based column number. */
  readonly column: number | null;
  /** Full original message line from the captured output. */
  readonly message: string;
  /** A few lines of trailing context (after the match) for richer signals. */
  readonly contextLines: readonly string[];
  /** Throttle key — same key within the throttle window suppresses re-emit. */
  readonly signature: string;
  /** Epoch-ms the diagnostic was detected. */
  readonly at: number;
}

/**
 * Compile-error digest payload — a CompileErrorDigest is just a
 * `DiagnosticSignal` constrained to the categories the model treats
 * as "fix this in code". Exposed as a named alias so the auto-injector
 * can be explicit about what it forwards into the chat loop.
 */
export type CompileErrorDigest = DiagnosticSignal;
