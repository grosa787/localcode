/**
 * `run_command` tool — shell execution with a 30s timeout.
 *
 * Two-phase: `previewCommand` returns a human-readable summary plus
 * `requiresApproval: true`. After approval, `executeCommand` actually runs
 * the command — routed through a pluggable `SandboxRunner` (sandbox-exec
 * on macOS, firejail on Linux, optional docker, or passthrough) so even
 * pre-approved commands cannot freely write outside the project root or
 * open network sockets when the user has tightened the policy.
 *
 * Output caps (ROADMAP #1):
 *   - stdout and stderr are each truncated independently when their
 *     length exceeds `STREAM_CAP_BYTES` (50 KB). The trimmed payload is
 *     followed by an actionable footer explaining how to inspect the
 *     full output via `grep`/`head`/`tail`.
 *   - The combined `output` (stdout + optional stderr block) is also
 *     bounded by `TOTAL_CAP_BYTES` (100 KB) as a final safety net so a
 *     single command can never blow up the model's context window.
 *
 * Sandbox fallback: when the requested backend is unavailable (e.g.
 * firejail not installed on Linux), the factory falls back to a
 * passthrough runner and logs a warning. Sandboxing is best-effort and
 * never blocks tool execution.
 */

import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';

import type {
  RunCommandArgs as SharedRunCommandArgs,
  ToolContext,
  ToolResult,
} from './types';
import {
  type BackgroundTaskRegistry,
  getProcessBackgroundTaskRegistry,
} from './background-tasks';
import {
  buildSandboxOpts,
  createSandboxRunner,
  type SandboxRunner,
  type SandboxRuntimeConfig,
} from './sandbox';

/**
 * Local extension of the shared `RunCommandArgs` interface that adds
 * the per-call `sandbox: false` opt-out. The shared interface in
 * `src/tools/types.ts` is touched by multiple tools; this file owns
 * the sandbox-aware shape and threads it through validation via the
 * Zod schema below.
 */
export type RunCommandArgs = SharedRunCommandArgs & {
  /** Per-call sandbox opt-out. Default true (use the configured backend). */
  sandbox?: boolean;
};

/**
 * Zod schema for `run_command` arguments.
 *
 * The optional `sandbox: false` per-call override lets the model
 * request a passthrough execution for a single command the user
 * approves — useful for legitimate cases where the sandbox profile is
 * too tight (e.g. docker-only commands run from outside docker).
 */
export const RunCommandArgsSchema = z.object({
  command: z.string().min(1, 'command must be a non-empty string'),
  cwd: z.string().min(1).optional(),
  /**
   * When true, spawn the command without awaiting it and return a
   * `taskId` immediately. Output is captured into a ring buffer and
   * surfaced via the `monitor` tool. Approval rules are unchanged — a
   * destructive command still passes through the same approval gate.
   */
  runInBackground: z.boolean().optional(),
  /**
   * Per-call sandbox opt-out. When `false`, the sandbox layer is
   * bypassed for this single invocation regardless of `config.sandbox`.
   * Defaults to `true` (use whatever backend the config selects).
   */
  sandbox: z.boolean().optional(),
});

/**
 * Extended context — when set, overrides the process-singleton
 * background-task registry. Tests inject a fresh registry through this.
 *
 * Optional `sandboxConfig` lets the composition root push the user's
 * sandbox preferences down into the tool. Absent → the tool builds a
 * runtime config from the in-built defaults (backend='auto' on the
 * host platform, allowNetwork=true, no extra write paths) which
 * preserves the legacy behaviour for any call site that hasn't been
 * updated yet.
 *
 * `sandboxRunner` is a test-only seam — production callers go through
 * the factory inside `commit`. When set, it short-circuits the factory.
 */
export interface RunCommandContext extends ToolContext {
  backgroundTasks?: BackgroundTaskRegistry;
  sandboxConfig?: SandboxRuntimeConfig;
  sandboxRunner?: SandboxRunner;
}

const COMMAND_TIMEOUT_MS = 30_000;

/** Per-stream byte cap — applied to stdout and stderr independently. */
const STREAM_CAP_BYTES = 50_000;
/** Total combined output byte cap — final safety net after both streams trimmed. */
const TOTAL_CAP_BYTES = 100_000;

/**
 * Denylist of obviously dangerous command patterns. Matched against the
 * raw `command` string BEFORE handing it to `execa`. Each regex covers a
 * canonical attack shape; the list is intentionally small and high-signal
 * so it does not become a moving target. A blocked command surfaces a
 * generic "matches dangerous pattern" error — we do not echo back which
 * pattern matched so the model cannot trivially probe the filter.
 */
const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  /curl[^\n]*\|\s*(sh|bash|zsh)/i,
  /wget[^\n]*\|\s*(sh|bash|zsh)/i,
  /\brm\s+-rf\s+\/(?!\S)/,
  /\bnc\s+-[el]/i,
  /mkfifo[^\n]*\/dev\/tcp/i,
  /bash\s+-i\s+>&\s*\/dev\/tcp/i,
];

/** Returns `true` if the raw command string matches a known dangerous shape. */
function isDangerousCommand(command: string): boolean {
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) return true;
  }
  return false;
}

/**
 * Trim a single stream (stdout or stderr) to `STREAM_CAP_BYTES` if it
 * exceeds the cap. Returns the original string when within the cap.
 *
 * The footer is appended after the truncated body and includes the
 * original byte count so the caller knows roughly how much was dropped
 * and the suggested follow-up command shape.
 */
function trimStream(text: string, label: string): string {
  if (text.length <= STREAM_CAP_BYTES) return text;
  const origBytes = text.length;
  const head = text.slice(0, STREAM_CAP_BYTES);
  const kb = (origBytes / 1024).toFixed(1);
  const footer = `\n[${label} truncated, ${origBytes} bytes (${kb}KB) total — re-run with grep/head/tail to see specific parts]`;
  return `${head}${footer}`;
}

/**
 * Apply the combined-output safety net. After per-stream trimming the
 * sum still might exceed `TOTAL_CAP_BYTES` (e.g. both streams are at
 * the per-stream cap). In that case we slice the combined string to
 * the total cap and append a final footer explaining the cut.
 */
function trimCombined(text: string): string {
  if (text.length <= TOTAL_CAP_BYTES) return text;
  const origBytes = text.length;
  const head = text.slice(0, TOTAL_CAP_BYTES);
  const kb = (origBytes / 1024).toFixed(1);
  return `${head}\n[combined output truncated, ${origBytes} bytes (${kb}KB) total — re-run with grep/head/tail to see specific parts]`;
}

function resolveCwd(ctx: ToolContext, requested?: string): string {
  if (!requested) return ctx.projectRoot;
  if (path.isAbsolute(requested)) return requested;
  return path.resolve(ctx.projectRoot, requested);
}

/**
 * Resolve the sandbox runtime config for the current call. Falls back
 * to safe defaults (auto-detect backend, network allowed, no extra
 * write paths, 2-minute upper bound) when the context doesn't supply
 * one. Keeps behaviour identical to the pre-sandbox baseline on hosts
 * where no native backend exists — the `none` runner spawns the
 * command directly through execa.
 */
function resolveSandboxConfig(
  ctx: RunCommandContext,
): SandboxRuntimeConfig {
  if (ctx.sandboxConfig !== undefined) return ctx.sandboxConfig;
  return {
    backend: 'auto',
    allowNetwork: true,
    allowWritePaths: [],
    timeoutMs: COMMAND_TIMEOUT_MS,
  };
}

/**
 * Resolve (or short-circuit to) the sandbox runner. Honours the
 * per-call `sandbox: false` opt-out by returning a synthetic runner
 * that runs the command directly through execa (same as the `none`
 * backend but without the once-per-process warning, since the user
 * explicitly opted out).
 */
async function executeThroughSandbox(
  ctx: RunCommandContext,
  command: string,
  cwd: string,
  perCallSandbox: boolean | undefined,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxed: boolean;
  timedOut: boolean;
}> {
  // Per-call opt-out — bypass sandbox entirely for this command.
  if (perCallSandbox === false) {
    const direct = await execa('sh', ['-c', command], {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      reject: false,
      all: false,
    });
    return {
      stdout: typeof direct.stdout === 'string' ? direct.stdout : '',
      stderr: typeof direct.stderr === 'string' ? direct.stderr : '',
      exitCode: direct.exitCode ?? -1,
      sandboxed: false,
      timedOut: direct.timedOut === true,
    };
  }

  const cfg = resolveSandboxConfig(ctx);
  const runner = ctx.sandboxRunner ?? createSandboxRunner(cfg);
  const opts = buildSandboxOpts(cfg, cwd);
  try {
    const r = await runner.run(command, opts);
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      sandboxed: r.sandboxed,
      timedOut: r.timedOut === true,
    };
  } catch (err) {
    // Spawn-level failure (e.g. missing binary not detected by the
    // factory). Fall back to direct exec rather than blocking the
    // tool. Log to stderr so users notice.
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[localcode] sandbox runner '${runner.id}' failed (${message}); falling back to direct exec.`,
    );
    const direct = await execa('sh', ['-c', command], {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      reject: false,
      all: false,
    });
    return {
      stdout: typeof direct.stdout === 'string' ? direct.stdout : '',
      stderr: typeof direct.stderr === 'string' ? direct.stderr : '',
      exitCode: direct.exitCode ?? -1,
      sandboxed: false,
      timedOut: direct.timedOut === true,
    };
  }
}

/**
 * Cheap preview: validates args, resolves cwd, returns a "will run" message
 * and `requiresApproval: true`. Does NOT execute.
 */
export async function previewCommand(
  args: RunCommandArgs,
  ctx: RunCommandContext,
): Promise<ToolResult> {
  const parsed = RunCommandArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      requiresApproval: true,
    };
  }

  if (isDangerousCommand(parsed.data.command)) {
    return {
      success: false,
      output: '',
      error: 'Command blocked by security policy: matches dangerous pattern',
    };
  }

  const cwd = resolveCwd(ctx, parsed.data.cwd);
  const bgSuffix =
    parsed.data.runInBackground === true ? '\n(background task)' : '';
  return {
    success: true,
    output: `Will run: ${parsed.data.command}\nIn: ${cwd}${bgSuffix}`,
    requiresApproval: true,
  };
}

/**
 * Actually execute the command via the configured sandbox runner.
 * Honours the 30s timeout and reports stdout + stderr. Non-zero exit
 * becomes `success: false`, timeouts surface a dedicated error message.
 *
 * When `runInBackground` is true, the child is spawned (UNSANDBOXED —
 * background tasks long-outlive the sandbox profile lifetime and the
 * isolation requirements are different), registered with the
 * `BackgroundTaskRegistry`, and the call returns immediately with a
 * `Started background task ...` line. The model is expected to poll via
 * the `monitor` tool.
 */
export async function executeCommand(
  args: RunCommandArgs,
  ctx: RunCommandContext,
): Promise<ToolResult> {
  const parsed = RunCommandArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      requiresApproval: true,
    };
  }

  // Defense-in-depth: re-check the denylist BEFORE invoking execa. The
  // preview phase has already rejected obvious cases, but a custom caller
  // could skip preview, and a clever model could mutate args between the
  // two phases. Either way, this guard must hold.
  if (isDangerousCommand(parsed.data.command)) {
    return {
      success: false,
      output: '',
      error: 'Command blocked by security policy: matches dangerous pattern',
    };
  }

  const cwd = resolveCwd(ctx, parsed.data.cwd);

  if (parsed.data.runInBackground === true) {
    try {
      const child = execa('sh', ['-c', parsed.data.command], {
        cwd,
        reject: false,
        all: false,
        buffer: false,
        // Detach so the child is independent of the parent's process
        // group — a Ctrl+C at the TUI shouldn't reliably SIGINT the
        // backgrounded task. Disposal walks the registry on shutdown.
      });
      const registry = ctx.backgroundTasks ?? getProcessBackgroundTaskRegistry();
      // Swallow the ResultPromise rejection — failure surfaces via the
      // `exit` listener inside the registry, not as an unhandled rejection.
      child.catch(() => {
        /* swallow — observed via child.on('exit') in registry */
      });
      const taskId = registry.register(child);
      return {
        success: true,
        output: `Started background task ${taskId}. Use monitor tool with taskId="${taskId}" to check status.`,
        requiresApproval: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: '',
        error: `Failed to spawn background task: ${message}`,
        requiresApproval: true,
      };
    }
  }

  try {
    const result = await executeThroughSandbox(
      ctx,
      parsed.data.command,
      cwd,
      parsed.data.sandbox,
    );

    if (result.timedOut) {
      return {
        success: false,
        output: '',
        error: 'Command timed out after 30s',
        requiresApproval: true,
      };
    }

    const stdout = trimStream(result.stdout, 'stdout');
    const stderr = trimStream(result.stderr, 'stderr');

    if (result.exitCode === 0) {
      const combined = stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout;
      return {
        success: true,
        output: trimCombined(combined),
        requiresApproval: true,
      };
    }

    return {
      success: false,
      output: trimCombined(stdout),
      error: `Exit ${result.exitCode}: ${stderr}`,
      requiresApproval: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: '',
      error: `Command failed: ${message}`,
      requiresApproval: true,
    };
  }
}
