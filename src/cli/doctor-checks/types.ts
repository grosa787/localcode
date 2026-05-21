/**
 * Shared types for `localcode doctor` checks.
 *
 * Every check exports an async function that returns a `DoctorCheckResult`.
 * The runner (`src/cli/doctor.ts`) wraps each call in try/catch so a thrown
 * exception is always downgraded to a `fail` result with the error message
 * — checks themselves never need to worry about crashing the whole report.
 */

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheckResult {
  /** Short human-readable check name (e.g. `"Bun runtime"`). */
  readonly name: string;
  /** Outcome — `ok` (pass), `warn` (degraded but usable), `fail` (broken). */
  readonly status: DoctorStatus;
  /** One-line user-facing explanation. */
  readonly message: string;
  /** Wall-clock duration of the check in milliseconds. */
  readonly durationMs: number;
  /**
   * Optional extra detail surfaced under the message in verbose / json
   * output. Kept narrow on purpose — heavy diagnostic data belongs in
   * a separate command, not the doctor summary.
   */
  readonly detail?: string;
}

/**
 * Side-channel injected into every check so tests can stub the
 * filesystem / network / process surface without monkey-patching node
 * built-ins. Production callers omit it and each check falls back to
 * the real implementation.
 */
export interface DoctorCheckEnv {
  /** Override `os.homedir()` for tests. */
  readonly homedir?: () => string;
  /** Override `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Override `process.env` lookups. */
  readonly env?: NodeJS.ProcessEnv;
  /** Override `process.execPath`. */
  readonly execPath?: string;
  /** Override `process.argv[1]` (the CLI entry point on disk). */
  readonly argv1?: string;
  /** Override `globalThis.fetch` for the latest-version + ping checks. */
  readonly fetchFn?: typeof globalThis.fetch;
  /**
   * Override the spawn helper used by sub-process checks (bun --version,
   * which localcode, git --version). Returning a structured object lets
   * tests assert behaviour without spawning a real shell.
   */
  readonly spawn?: (
    command: string,
    args: readonly string[],
  ) => Promise<DoctorSpawnResult>;
  /**
   * Override the disk-stats fetcher (free bytes for the localcode dir).
   * `null` means "unable to determine" — the check downgrades to warn.
   */
  readonly diskFreeBytes?: (path: string) => Promise<number | null>;
}

export interface DoctorSpawnResult {
  /** Exit status (0 on success). */
  readonly status: number;
  /** Captured stdout (utf8). */
  readonly stdout: string;
  /** Captured stderr (utf8). */
  readonly stderr: string;
  /** When true, the command could not be spawned (ENOENT etc.). */
  readonly notFound: boolean;
}
