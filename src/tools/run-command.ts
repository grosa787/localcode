/**
 * `run_command` tool — shell execution with a 30s timeout.
 *
 * Two-phase: `previewCommand` returns a human-readable summary plus
 * `requiresApproval: true`. After approval, `executeCommand` actually runs
 * the command via `execa('sh', ['-c', command])`.
 *
 * Output caps (ROADMAP #1):
 *   - stdout and stderr are each truncated independently when their
 *     length exceeds `STREAM_CAP_BYTES` (50 KB). The trimmed payload is
 *     followed by an actionable footer explaining how to inspect the
 *     full output via `grep`/`head`/`tail`.
 *   - The combined `output` (stdout + optional stderr block) is also
 *     bounded by `TOTAL_CAP_BYTES` (100 KB) as a final safety net so a
 *     single command can never blow up the model's context window.
 */

import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';

import type { RunCommandArgs, ToolContext, ToolResult } from './types';
import {
  type BackgroundTaskRegistry,
  getProcessBackgroundTaskRegistry,
} from './background-tasks';

/** Zod schema for `run_command` arguments. */
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
});

/**
 * Extended context — when set, overrides the process-singleton
 * background-task registry. Tests inject a fresh registry through this.
 */
export interface RunCommandContext extends ToolContext {
  backgroundTasks?: BackgroundTaskRegistry;
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
 * Actually execute the command via `sh -c`. Honours the 30s timeout and
 * reports stdout + stderr. Non-zero exit becomes `success: false`, timeouts
 * surface a dedicated error message.
 *
 * When `runInBackground` is true, the child is spawned, registered with
 * the `BackgroundTaskRegistry`, and the call returns immediately with a
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
    const result = await execa('sh', ['-c', parsed.data.command], {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      reject: false,
      all: false,
    });

    const rawStdout = typeof result.stdout === 'string' ? result.stdout : '';
    const rawStderr = typeof result.stderr === 'string' ? result.stderr : '';

    if (result.timedOut) {
      return {
        success: false,
        output: '',
        error: 'Command timed out after 30s',
        requiresApproval: true,
      };
    }

    const stdout = trimStream(rawStdout, 'stdout');
    const stderr = trimStream(rawStderr, 'stderr');

    if (result.exitCode === 0) {
      const combined = stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout;
      return {
        success: true,
        output: trimCombined(combined),
        requiresApproval: true,
      };
    }

    const code = result.exitCode ?? -1;
    return {
      success: false,
      output: trimCombined(stdout),
      error: `Exit ${code}: ${stderr}`,
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
