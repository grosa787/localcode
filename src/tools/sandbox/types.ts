/**
 * Sandbox layer for `run_command` — shared interfaces.
 *
 * Defense-in-depth on top of the existing approval flow. Even when a
 * command is pre-approved (via `autoApprove`, the `dontAsk` permission
 * profile, or `--dangerously-allow-all`), the sandbox runner restricts
 * filesystem writes and network access by default.
 *
 * Each backend (sandbox-exec, firejail, docker, none) implements
 * `SandboxRunner.run` returning the executed command's stdout, stderr,
 * exit code, and a `sandboxed: boolean` flag so the UI can surface
 * whether the call ran inside an isolation envelope or fell back to a
 * direct spawn.
 */

/** Options passed to a single sandboxed execution. */
export interface SandboxOpts {
  /** Working directory for the spawned shell. */
  cwd: string;
  /** When false, the runner blocks outbound network sockets. */
  allowNetwork: boolean;
  /**
   * Absolute paths the command may freely write to. The `cwd` is always
   * implicitly allowed in addition to whatever the user adds here.
   * Empty array (with `cwd` only) is the safest default.
   */
  allowWritePaths: string[];
  /** Wall-clock timeout in milliseconds. */
  timeoutMs?: number;
  /** Extra environment variables forwarded to the child. */
  env?: Record<string, string>;
}

/** Result returned by every backend. */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Whether the command actually ran inside an isolation envelope. When
   * a runner is requested but unavailable (e.g. firejail missing on
   * Linux), it falls back to a direct spawn and reports `false` so the
   * caller can surface a warning.
   */
  sandboxed: boolean;
  /** True when the runner's wall-clock timeout fired. */
  timedOut?: boolean;
}

/** Pluggable backend contract. */
export interface SandboxRunner {
  /** Backend identifier ('sandbox-exec' | 'firejail' | 'docker' | 'none'). */
  readonly id: SandboxBackend;
  /**
   * Execute `cmd` in the sandbox envelope. Implementations MUST resolve
   * with a structured `SandboxResult` — they should NEVER throw on a
   * non-zero exit. The only legitimate rejection is a genuine spawn
   * failure (missing binary, OS-level fork error). Callers fall back to
   * the `none` backend on rejection.
   */
  run(cmd: string, opts: SandboxOpts): Promise<SandboxResult>;
}

/** Backend identifiers exposed via config. */
export type SandboxBackend =
  | 'auto'
  | 'sandbox-exec'
  | 'firejail'
  | 'docker'
  | 'none';

/**
 * Static configuration consumed by `createSandboxRunner`. Mirrors the
 * `SandboxConfig` Zod shape in `src/config/types.ts`. Decoupled from the
 * config type so the sandbox module doesn't need to import the wider
 * config surface and can be unit-tested in isolation.
 */
export interface SandboxRuntimeConfig {
  backend: SandboxBackend;
  allowNetwork: boolean;
  allowWritePaths: string[];
  timeoutMs: number;
  /**
   * Opt-in image override for the `docker` backend. Default `alpine:latest`
   * — the smallest image that ships with `sh`. Unused by other backends.
   */
  dockerImage?: string;
}
