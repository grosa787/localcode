/**
 * schedule_wakeup tool handler — Claude-Code-style in-session deferred
 * continuation.
 *
 * The model uses this to pause its own loop for N seconds and resume
 * with a self-supplied prompt. Useful for:
 *   - "wait for the build to finish, then check the output"
 *   - "poll this endpoint every 5 minutes"
 *   - "retry the rate-limited request in 30 minutes"
 *
 * Single-phase, read-only-flavoured: no approval prompt, no commit step.
 * The actual side effect (scheduling) happens during preview because it
 * has no destructive consequence — the worst case is a self-prompt fires
 * later, which the user can cancel via `/wakeups cancel <id>`.
 */

import { z } from 'zod';

import type { ToolContext, ToolResult } from './types';
import type { WakeupRegistry } from '@/scheduling';
import {
  WAKEUP_MAX_DELAY_MS,
  WAKEUP_MIN_DELAY_MS,
} from '@/scheduling';

// ---------- Zod schema ----------

const WAKEUP_MIN_SECONDS = WAKEUP_MIN_DELAY_MS / 1000;
const WAKEUP_MAX_SECONDS = WAKEUP_MAX_DELAY_MS / 1000;

export const ScheduleWakeupArgsSchema = z.object({
  delaySeconds: z
    .number({ invalid_type_error: 'delaySeconds must be a number' })
    .int('delaySeconds must be an integer')
    .min(
      WAKEUP_MIN_SECONDS,
      `delaySeconds must be >= ${WAKEUP_MIN_SECONDS}`,
    )
    .max(
      WAKEUP_MAX_SECONDS,
      `delaySeconds must be <= ${WAKEUP_MAX_SECONDS}`,
    ),
  reason: z
    .string({ required_error: 'reason is required' })
    .min(1, 'reason must be non-empty'),
  prompt: z
    .string({ required_error: 'prompt is required' })
    .min(1, 'prompt must be non-empty'),
});

export type ScheduleWakeupArgs = z.infer<typeof ScheduleWakeupArgsSchema>;

// ---------- Structural narrowing for the registry on ctx ----------

interface WakeupRegistryLike {
  schedule(
    sessionId: string,
    args: { delayMs: number; prompt: string; reason: string },
  ): string;
}

function isWakeupRegistry(value: unknown): value is WakeupRegistryLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    'schedule' in value &&
    typeof (value as Record<string, unknown>)['schedule'] === 'function'
  );
}

// ---------- Handler ----------

/**
 * Execute the `schedule_wakeup` tool. Always single-phase: no preview /
 * commit split, no approval surface.
 *
 * Requires `ctx.wakeupRegistry` and `ctx.sessionId`. When either is
 * absent the call returns a friendly error so unit tests (and any
 * misconfigured caller) get a clear signal rather than a TypeError.
 */
export async function scheduleWakeup(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = ScheduleWakeupArgsSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return {
      success: false,
      output: '',
      error: `Invalid schedule_wakeup arguments: ${issues}`,
    };
  }
  const { delaySeconds, reason, prompt } = parsed.data;

  const registry = ctx.wakeupRegistry;
  if (!isWakeupRegistry(registry)) {
    return {
      success: false,
      output: '',
      error: 'schedule_wakeup is not available in this context (no registry wired)',
    };
  }
  const { sessionId } = ctx;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return {
      success: false,
      output: '',
      error: 'schedule_wakeup requires an active session',
    };
  }

  let wakeupId: string;
  try {
    wakeupId = registry.schedule(sessionId, {
      delayMs: delaySeconds * 1000,
      prompt,
      reason,
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    return {
      success: false,
      output: '',
      error: `Failed to schedule wakeup: ${msg}`,
    };
  }

  return {
    success: true,
    output:
      `Scheduled wakeup ${wakeupId} in ${delaySeconds}s; will resume with: ${prompt}`,
  };
}
