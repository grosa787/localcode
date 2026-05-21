/**
 * HookEngine — extended triggers: `PreCompact`, `SessionEnd`, `Stop`.
 *
 * Verifies:
 *   - Each new trigger only fires hooks configured for the SAME trigger
 *     (filtering by `HookConfig.trigger`).
 *   - LocalCode-specific env vars (`LOCALCODE_CONTEXT_TOKENS`,
 *     `LOCALCODE_MAX_CONTEXT_TOKENS`, `LOCALCODE_SESSION_END_REASON`,
 *     `LOCALCODE_STOP_USAGE_PROMPT` / `_COMPLETION` / `_CACHED`)
 *     propagate to the spawned shell.
 *
 * Uses real `sh -c` like the existing `engine.test.ts` — `sh` is
 * reliably present on CI per the workflow file. Commands stay tiny so
 * the suite remains fast.
 */

import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';

import {
  HookEngine,
  type HookConfig,
  type HookContext,
} from '@/hooks';

const TMP = os.tmpdir();

function ctx(overrides: Partial<HookContext>): HookContext {
  return {
    trigger: 'SessionEnd',
    projectRoot: TMP,
    ...overrides,
  };
}

describe('HookEngine — PreCompact / SessionEnd / Stop filter by trigger', () => {
  test('PreCompact hook does not fire on SessionEnd / Stop', async () => {
    const hooks: HookConfig[] = [
      { trigger: 'PreCompact', command: 'echo pre' },
    ];
    const engine = new HookEngine({ hooks });
    expect(engine.hasHooksFor('PreCompact')).toBe(true);
    expect(engine.hasHooksFor('SessionEnd')).toBe(false);
    expect(engine.hasHooksFor('Stop')).toBe(false);
    const outSe = await engine.run(ctx({ trigger: 'SessionEnd', reason: 'user_quit' }));
    expect(outSe.length).toBe(0);
    const outStop = await engine.run(ctx({ trigger: 'Stop' }));
    expect(outStop.length).toBe(0);
    const outPc = await engine.run(
      ctx({ trigger: 'PreCompact', contextTokens: 100, maxContextTokens: 1000 }),
    );
    expect(outPc.length).toBe(1);
  });

  test('SessionEnd hook does not fire on PreCompact / Stop', async () => {
    const hooks: HookConfig[] = [
      { trigger: 'SessionEnd', command: 'echo end' },
    ];
    const engine = new HookEngine({ hooks });
    const outPc = await engine.run(
      ctx({ trigger: 'PreCompact', contextTokens: 1, maxContextTokens: 2 }),
    );
    expect(outPc.length).toBe(0);
    const outStop = await engine.run(ctx({ trigger: 'Stop' }));
    expect(outStop.length).toBe(0);
    const outSe = await engine.run(ctx({ trigger: 'SessionEnd', reason: 'user_quit' }));
    expect(outSe.length).toBe(1);
  });

  test('Stop hook does not fire on PreCompact / SessionEnd', async () => {
    const hooks: HookConfig[] = [
      { trigger: 'Stop', command: 'echo stop' },
    ];
    const engine = new HookEngine({ hooks });
    const outPc = await engine.run(
      ctx({ trigger: 'PreCompact', contextTokens: 1, maxContextTokens: 2 }),
    );
    expect(outPc.length).toBe(0);
    const outSe = await engine.run(ctx({ trigger: 'SessionEnd', reason: 'evicted' }));
    expect(outSe.length).toBe(0);
    const outStop = await engine.run(ctx({ trigger: 'Stop' }));
    expect(outStop.length).toBe(1);
  });
});

describe('HookEngine — env propagation for extended triggers', () => {
  test('LOCALCODE_CONTEXT_TOKENS + LOCALCODE_MAX_CONTEXT_TOKENS surface to PreCompact', async () => {
    const engine = new HookEngine({
      hooks: [
        {
          trigger: 'PreCompact',
          command:
            'printf "ctx=%s max=%s" "$LOCALCODE_CONTEXT_TOKENS" "$LOCALCODE_MAX_CONTEXT_TOKENS"',
        },
      ],
    });
    const outcomes = await engine.run(
      ctx({ trigger: 'PreCompact', contextTokens: 1234, maxContextTokens: 9999 }),
    );
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.exitCode).toBe(0);
    expect(outcomes[0]?.stdout).toBe('ctx=1234 max=9999');
  });

  test('LOCALCODE_SESSION_END_REASON surfaces to SessionEnd', async () => {
    const engine = new HookEngine({
      hooks: [
        {
          trigger: 'SessionEnd',
          command: 'printf "%s" "$LOCALCODE_SESSION_END_REASON"',
        },
      ],
    });
    const cases: Array<HookContext['reason']> = [
      'user_quit',
      'session_switch',
      'shutdown',
      'evicted',
    ];
    for (const reason of cases) {
      const outcomes = await engine.run(
        ctx({ trigger: 'SessionEnd', reason }),
      );
      expect(outcomes[0]?.exitCode).toBe(0);
      expect(outcomes[0]?.stdout).toBe(reason);
    }
  });

  test('LOCALCODE_STOP_USAGE_* surface to Stop', async () => {
    const engine = new HookEngine({
      hooks: [
        {
          trigger: 'Stop',
          command:
            'printf "p=%s c=%s ch=%s" "$LOCALCODE_STOP_USAGE_PROMPT" "$LOCALCODE_STOP_USAGE_COMPLETION" "$LOCALCODE_STOP_USAGE_CACHED"',
        },
      ],
    });
    const outcomes = await engine.run(
      ctx({
        trigger: 'Stop',
        usage: {
          promptTokens: 500,
          completionTokens: 250,
          cachedInputTokens: 100,
        },
      }),
    );
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.exitCode).toBe(0);
    expect(outcomes[0]?.stdout).toBe('p=500 c=250 ch=100');
  });

  test('Stop env vars are absent when usage snapshot omits them', async () => {
    const engine = new HookEngine({
      hooks: [
        {
          trigger: 'Stop',
          command:
            'printf "p=[%s] c=[%s] ch=[%s]" "${LOCALCODE_STOP_USAGE_PROMPT-unset}" "${LOCALCODE_STOP_USAGE_COMPLETION-unset}" "${LOCALCODE_STOP_USAGE_CACHED-unset}"',
        },
      ],
    });
    // No `usage` field at all → all env vars absent.
    const outA = await engine.run(ctx({ trigger: 'Stop' }));
    expect(outA[0]?.stdout).toBe('p=[unset] c=[unset] ch=[unset]');
    // Partial usage — only `promptTokens`.
    const outB = await engine.run(
      ctx({ trigger: 'Stop', usage: { promptTokens: 7 } }),
    );
    expect(outB[0]?.stdout).toBe('p=[7] c=[unset] ch=[unset]');
  });
});

describe('HookEngine — blocking semantics survive the new triggers', () => {
  test('blocking SessionEnd hook still reports blocked=true', async () => {
    const engine = new HookEngine({
      hooks: [
        { trigger: 'SessionEnd', command: 'exit 1', blocking: true },
      ],
    });
    const outcomes = await engine.run(
      ctx({ trigger: 'SessionEnd', reason: 'user_quit' }),
    );
    expect(outcomes[0]?.exitCode).toBe(1);
    expect(outcomes[0]?.blocked).toBe(true);
  });

  test('non-blocking Stop hook never blocks even on non-zero exit', async () => {
    const engine = new HookEngine({
      hooks: [
        { trigger: 'Stop', command: 'exit 2', blocking: false },
      ],
    });
    const outcomes = await engine.run(ctx({ trigger: 'Stop' }));
    expect(outcomes[0]?.exitCode).toBe(2);
    expect(outcomes[0]?.blocked).toBe(false);
  });
});
