/**
 * Coverage for the `schedule_wakeup` tool handler.
 *   - Zod schema rejects out-of-range / non-integer delaySeconds + empty
 *     prompt/reason,
 *   - handler returns a success ToolResult when the registry accepts the
 *     schedule,
 *   - handler returns a friendly error when the context lacks a
 *     registry or sessionId.
 */

import { describe, expect, test } from 'bun:test';
import {
  ScheduleWakeupArgsSchema,
  scheduleWakeup,
} from '@/tools/schedule-wakeup';
import type { ToolContext } from '@/tools/types';

function fakeRegistry(opts?: {
  throwOnSchedule?: boolean;
}): { calls: Array<{ sessionId: string; args: unknown }>; schedule: (sid: string, a: unknown) => string } {
  const calls: Array<{ sessionId: string; args: unknown }> = [];
  return {
    calls,
    schedule(sessionId: string, args: unknown): string {
      if (opts?.throwOnSchedule === true) {
        throw new Error('boom');
      }
      calls.push({ sessionId, args });
      return 'wkup-test-id';
    },
  };
}

function ctxWith(overrides: Partial<ToolContext>): ToolContext {
  return {
    projectRoot: '/tmp/project',
    dangerouslyAllowAll: false,
    ...overrides,
  };
}

describe('ScheduleWakeupArgsSchema', () => {
  test('rejects delaySeconds below the minimum', () => {
    const res = ScheduleWakeupArgsSchema.safeParse({
      delaySeconds: 30,
      reason: 'wait',
      prompt: 'check',
    });
    expect(res.success).toBe(false);
  });

  test('rejects delaySeconds above the maximum', () => {
    const res = ScheduleWakeupArgsSchema.safeParse({
      delaySeconds: 7200,
      reason: 'wait',
      prompt: 'check',
    });
    expect(res.success).toBe(false);
  });

  test('rejects non-integer delaySeconds', () => {
    const res = ScheduleWakeupArgsSchema.safeParse({
      delaySeconds: 90.5,
      reason: 'wait',
      prompt: 'check',
    });
    expect(res.success).toBe(false);
  });

  test('rejects empty prompt / reason', () => {
    expect(
      ScheduleWakeupArgsSchema.safeParse({
        delaySeconds: 120,
        reason: '',
        prompt: 'p',
      }).success,
    ).toBe(false);
    expect(
      ScheduleWakeupArgsSchema.safeParse({
        delaySeconds: 120,
        reason: 'r',
        prompt: '',
      }).success,
    ).toBe(false);
  });

  test('accepts a valid set of arguments', () => {
    const res = ScheduleWakeupArgsSchema.safeParse({
      delaySeconds: 120,
      reason: 'long build',
      prompt: 'check build status',
    });
    expect(res.success).toBe(true);
  });
});

describe('scheduleWakeup handler', () => {
  test('returns success + delegates to the registry', async () => {
    const reg = fakeRegistry();
    const result = await scheduleWakeup(
      { delaySeconds: 120, reason: 'long build', prompt: 'check status' },
      ctxWith({ sessionId: 'sess-1', wakeupRegistry: reg }),
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('wkup-test-id');
    expect(reg.calls).toHaveLength(1);
    expect(reg.calls[0]?.sessionId).toBe('sess-1');
  });

  test('error result on invalid args', async () => {
    const reg = fakeRegistry();
    const result = await scheduleWakeup(
      { delaySeconds: 5, reason: 'r', prompt: 'p' },
      ctxWith({ sessionId: 'sess-1', wakeupRegistry: reg }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid schedule_wakeup arguments');
  });

  test('error result when no registry is wired', async () => {
    const result = await scheduleWakeup(
      { delaySeconds: 120, reason: 'r', prompt: 'p' },
      ctxWith({ sessionId: 'sess-1' }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('no registry wired');
  });

  test('error result when no sessionId on ctx', async () => {
    const reg = fakeRegistry();
    const result = await scheduleWakeup(
      { delaySeconds: 120, reason: 'r', prompt: 'p' },
      ctxWith({ wakeupRegistry: reg }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('active session');
  });

  test('handles registry.schedule throwing', async () => {
    const reg = fakeRegistry({ throwOnSchedule: true });
    const result = await scheduleWakeup(
      { delaySeconds: 120, reason: 'r', prompt: 'p' },
      ctxWith({ sessionId: 's', wakeupRegistry: reg }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to schedule wakeup');
  });
});
