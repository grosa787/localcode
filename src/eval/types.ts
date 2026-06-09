/**
 * Golden-task eval harness — shared types.
 *
 * This module is the keystone instrument that makes every reliability
 * feature measurable: it runs real, multi-step agent tasks end-to-end
 * against a LIVE adapter + ToolExecutor loop and records whether the
 * agent actually SUCCEEDED (not whether a unit test passed).
 *
 * A {@link GoldenTask} is fully self-contained: it scaffolds a tiny tmp
 * repo, hands the agent a prompt, and defines a deterministic, OFFLINE
 * success check (a shell command's exit code, or a substring in a file).
 * No network is involved in the success check — only the model call is.
 */

/**
 * How a task's success is verified after the agent loop terminates.
 *
 *   - `command`     — run a shell command inside the scaffolded repo.
 *                     The task passes iff the process exits with
 *                     `expectExit` (default 0). Use offline runners only
 *                     (`bun test`, `node`, `bun x tsc`, `grep`) — never
 *                     a network call.
 *   - `fileContains`— read a file relative to the repo root and assert it
 *                     contains `needle`. Pure string match, no exec.
 */
export type SuccessCheck =
  | {
      readonly kind: 'command';
      /** Shell command run with cwd = scaffolded repo root. */
      readonly cmd: string;
      /** Expected exit code. Defaults to 0 when omitted. */
      readonly expectExit?: number;
    }
  | {
      readonly kind: 'fileContains';
      /** Path relative to the repo root. */
      readonly path: string;
      /** Substring the file must contain for the task to pass. */
      readonly needle: string;
    };

/**
 * A single golden task. Deterministic + offline-runnable by construction.
 *
 * The `scaffold.files` map is written verbatim into a fresh tmp repo
 * (keys are repo-relative paths, values are file contents). The agent is
 * then given `prompt` and allowed up to `maxTurns` streaming turns to
 * mutate the repo via its tools. Finally the `success` check runs.
 */
export interface GoldenTask {
  /** Stable, unique kebab-case identifier (used by `/eval <task-id>`). */
  readonly id: string;
  /** Human-readable one-line title for report rows. */
  readonly title: string;
  /** Free-form tags for grouping (`'test'`, `'refactor'`, `'types'`, ...). */
  readonly tags: readonly string[];
  /** Initial repo contents — relative path → file body. */
  readonly scaffold: {
    readonly files: Readonly<Record<string, string>>;
  };
  /** Instruction handed to the agent as the first user message. */
  readonly prompt: string;
  /** Deterministic, offline pass/fail check run after the loop. */
  readonly success: SuccessCheck;
  /** Hard cap on streaming turns before the task is recorded as failed. */
  readonly maxTurns: number;
}

/**
 * Outcome of running a single {@link GoldenTask}. Carries the pass/fail
 * verdict plus the cost/latency metrics that make model+config combos
 * comparable.
 */
export interface TaskResult {
  readonly taskId: string;
  /** True iff the success check passed. */
  readonly passed: boolean;
  /** Streaming turns the agent consumed before terminating. */
  readonly turns: number;
  /** Prompt (input) tokens summed across every turn. */
  readonly tokensIn: number;
  /** Completion (output) tokens summed across every turn. */
  readonly tokensOut: number;
  /** Estimated USD cost (0 for local providers / unknown models). */
  readonly costUsd: number;
  /** Wall-clock duration of the whole task in milliseconds. */
  readonly wallMs: number;
  /**
   * Populated when the task did NOT pass cleanly — a stream error, a
   * maxTurns hit, or a failed success check. Absent on a clean pass.
   */
  readonly error?: string;
}

/**
 * Aggregate report for a suite run against ONE model+backend combo.
 * `formatReport` / `toJson` (see `report.ts`) render this.
 */
export interface EvalReport {
  /** Model id the suite ran against (e.g. `gpt-4o-mini`). */
  readonly model: string;
  /** Backend the model ran on (e.g. `openai`, `lmstudio`). */
  readonly backend: string;
  /** Epoch ms when the suite started. */
  readonly ranAt: number;
  /** One entry per task, in input order. */
  readonly results: readonly TaskResult[];
  /** Fraction of tasks that passed, 0..1. */
  readonly passRate: number;
  readonly totalTokensIn: number;
  readonly totalTokensOut: number;
  readonly totalCostUsd: number;
  readonly totalWallMs: number;
}
