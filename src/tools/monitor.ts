/**
 * `monitor` tool — read status / output for a background task started by
 * `run_command` with `runInBackground: true`.
 *
 * Single-phase: the tool is read-only with one exception (sending
 * SIGTERM via `killTask: true`). Even the SIGTERM is intentionally
 * exempt from the approval gate — the destructive action that created
 * the process already passed through `run_command`'s approval gate, and
 * forcing a second prompt to stop a runaway task would defeat the point.
 *
 * Inputs:
 *   taskId      — id returned by `run_command` when `runInBackground=true`.
 *   wait        — optional poll-wait in ms (0..30000). When the task is
 *                 still `running`, the call resolves whichever comes
 *                 first: new output, status change, or timeout.
 *   killTask    — when true, deliver SIGTERM and return immediately.
 *
 * The output payload is a deterministic single-line summary followed by
 * the captured stdout/stderr blocks. The leading single-line summary
 * lets the model parse the state without parsing the body.
 */

import { z } from 'zod';

import type { ToolContext, ToolResult } from './types';
import {
  type BackgroundTaskRegistry,
  type BackgroundTaskSnapshot,
  getProcessBackgroundTaskRegistry,
} from './background-tasks';

/** Wait cap. 30 seconds is the same envelope as run_command's sync timeout. */
const MAX_WAIT_MS = 30_000;

export const MonitorArgsSchema = z.object({
  taskId: z.string().min(1, 'taskId must be a non-empty string'),
  wait: z.number().min(0).max(MAX_WAIT_MS).optional(),
  killTask: z.boolean().optional(),
});

export type MonitorArgs = z.infer<typeof MonitorArgsSchema>;

/**
 * Extended context — when set, overrides the process-singleton registry.
 * Tests use this to inject a fresh registry.
 */
export interface MonitorContext extends ToolContext {
  backgroundTasks?: BackgroundTaskRegistry;
}

function resolveRegistry(ctx: MonitorContext): BackgroundTaskRegistry {
  return ctx.backgroundTasks ?? getProcessBackgroundTaskRegistry();
}

/**
 * Render the snapshot as a model-friendly text envelope. The first line
 * is deterministic key=value pairs; the body sections only appear when
 * non-empty so a quick-completing task doesn't return three blank
 * sections.
 */
function renderSnapshot(snap: BackgroundTaskSnapshot): string {
  const head =
    snap.status === 'running'
      ? `taskId=${snap.taskId} status=running durationMs=${snap.durationMs}`
      : `taskId=${snap.taskId} status=${snap.status} exitCode=${
          snap.exitCode ?? 'null'
        } durationMs=${snap.durationMs}`;
  const parts: string[] = [head];
  if (snap.stdout.length > 0) parts.push(`[stdout]\n${snap.stdout}`);
  if (snap.stderr.length > 0) parts.push(`[stderr]\n${snap.stderr}`);
  return parts.join('\n');
}

/**
 * Tool body. Validates args, optionally kills the task, optionally
 * blocks on `waitForChange`, then returns a snapshot of the current
 * state.
 */
export async function monitorTask(
  args: unknown,
  ctx: MonitorContext,
): Promise<ToolResult> {
  const parsed = MonitorArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const registry = resolveRegistry(ctx);
  const { taskId, wait, killTask } = parsed.data;

  const snap = registry.get(taskId);
  if (snap === null) {
    return {
      success: false,
      output: '',
      error: `Unknown taskId: ${taskId}`,
    };
  }

  if (killTask === true) {
    const killed = registry.kill(taskId);
    const afterKill = registry.get(taskId);
    const body =
      afterKill === null
        ? `taskId=${taskId} status=unknown (after kill)`
        : renderSnapshot(afterKill);
    return {
      success: true,
      output: killed
        ? `Sent SIGTERM to ${taskId}.\n${body}`
        : `Task ${taskId} not running; nothing to kill.\n${body}`,
    };
  }

  if (wait !== undefined && wait > 0 && snap.status === 'running') {
    await registry.waitForChange(taskId, wait);
  }

  const finalSnap = registry.get(taskId);
  if (finalSnap === null) {
    return {
      success: false,
      output: '',
      error: `Task ${taskId} disappeared while monitoring.`,
    };
  }

  return {
    success: true,
    output: renderSnapshot(finalSnap),
  };
}
