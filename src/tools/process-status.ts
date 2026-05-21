/**
 * `process_status` tool — read-only inspection of long-running
 * processes registered via the `ProcessMonitor`.
 *
 * Single-phase: no approval, no commit. The model uses this to learn
 * which dev servers / watch builds / test runners are currently being
 * tracked (and whether any have failed) without having to ask the
 * user to copy-paste logs.
 *
 * Inputs:
 *   id?      — optional watch id. When set, only that process is
 *              returned (404 → success:false with explanatory error).
 *              When omitted, every watched process is returned.
 *
 * Output payload — a short single-line header followed by one block
 * per watched process:
 *   processes=N
 *   - id=<id> health=<state> exit=<code> cmd="<command>"
 *     stdout/stderr line counts; last 5 lines from each stream.
 *
 * Returning a structured envelope (instead of just JSON) keeps the
 * payload model-friendly without forcing the model to parse JSON.
 */

import { z } from 'zod';

import type { ToolContext, ToolResult } from './types';
import {
  ProcessMonitor,
  getProcessMonitor,
} from '@/process-monitor';
import type { WatchedProcess } from '@/process-monitor';

export const ProcessStatusArgsSchema = z.object({
  id: z.string().min(1).optional(),
});

export type ProcessStatusArgs = z.infer<typeof ProcessStatusArgsSchema>;

/**
 * Extended context — when set, overrides the process-singleton monitor.
 * Tests use this to inject a fresh monitor.
 */
export interface ProcessStatusContext extends ToolContext {
  processMonitor?: ProcessMonitor;
}

function resolveMonitor(ctx: ProcessStatusContext): ProcessMonitor {
  return ctx.processMonitor ?? getProcessMonitor();
}

/** Render a single watched process into a model-friendly text block. */
function renderProcess(p: WatchedProcess): string {
  const exit = p.exitCode === null ? 'null' : String(p.exitCode);
  const pid = p.pid === null ? 'null' : String(p.pid);
  const head = `- id=${p.id} pid=${pid} health=${p.health} exit=${exit} label="${p.label}" cmd="${p.command}"`;
  const tailStdout = p.recentStdout.slice(-5);
  const tailStderr = p.recentStderr.slice(-5);
  const parts: string[] = [head, `  cwd=${p.cwd}`];
  parts.push(`  stdoutBytes=${p.stdoutBytes} stderrBytes=${p.stderrBytes}`);
  if (tailStdout.length > 0) {
    parts.push('  [stdout tail]');
    for (const line of tailStdout) parts.push(`    ${line}`);
  }
  if (tailStderr.length > 0) {
    parts.push('  [stderr tail]');
    for (const line of tailStderr) parts.push(`    ${line}`);
  }
  return parts.join('\n');
}

/**
 * Tool body. Validates args, optionally narrows to a single id, then
 * renders the payload.
 */
export async function processStatus(
  args: unknown,
  ctx: ProcessStatusContext,
): Promise<ToolResult> {
  const parsed = ProcessStatusArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      output: '',
      error: `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  const monitor = resolveMonitor(ctx);
  const { id } = parsed.data;
  if (id !== undefined) {
    const snap = monitor.get(id);
    if (snap === null) {
      return {
        success: false,
        output: '',
        error: `Unknown watch id: ${id}`,
      };
    }
    return {
      success: true,
      output: `processes=1\n${renderProcess(snap)}`,
    };
  }
  const all = monitor.list();
  if (all.length === 0) {
    return {
      success: true,
      output: 'processes=0\n(no processes are being watched)',
    };
  }
  const blocks = [...all].map(renderProcess);
  return {
    success: true,
    output: `processes=${all.length}\n${blocks.join('\n')}`,
  };
}
