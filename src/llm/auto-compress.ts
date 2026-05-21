/**
 * Auto-compress trigger policy.
 *
 * Pure module — no I/O, no side effects, no LLM calls. Exposes a
 * single decision function that integration code (the chat-state
 * reducer / `app.tsx` composition root) calls each turn to decide
 * whether to dispatch a `/compress` action automatically before the
 * next request goes out.
 *
 * Why split this out: the compression mechanism (summarising the
 * older portion of the history) lives on `ContextManager.compress`
 * and is wired through `cmd-compress.ts`. The TRIGGER — "should we
 * compress *now*?" — is a small policy that we want to unit-test
 * in isolation, without touching the manager, the LLM, or the UI.
 *
 * Integration point (out of scope for this module): the chat-state
 * reducer / `app.tsx` should call `shouldAutoCompress` after every
 * assistant turn (using either the server-reported `usage.total_tokens`
 * or `estimateContextTokens(messages, systemPrompt)` from
 * `@/llm/context-manager`) and, on `true`, dispatch the same code path
 * `/compress` would. A parallel agent owns `app.tsx` so the wiring
 * lands there in a separate change.
 *
 * Default trigger: 80% of `maxContextTokens`. Mirrors the existing
 * `DEFAULTS.summarizeAt` constant (0.8) used by
 * `ContextManager.maybeSummarize`. Picked so the user has headroom
 * for the next turn after compression rather than slamming into the
 * server's hard limit.
 */

export const DEFAULT_AUTO_COMPRESS_TRIGGER_PERCENT = 0.8;

export interface ShouldAutoCompressArgs {
  /** Estimated token count of the current context (system + history). */
  contextTokens: number;
  /** Configured `num_ctx` / context window (must be > 0 to trigger). */
  maxContextTokens: number;
  /**
   * Threshold in [0, 1]. Trigger fires when
   * `contextTokens / maxContextTokens >= triggerAtPercent`. Defaults to
   * {@link DEFAULT_AUTO_COMPRESS_TRIGGER_PERCENT} (0.80) if omitted.
   */
  triggerAtPercent?: number;
}

/**
 * Decide whether to dispatch an automatic compression now.
 *
 * Returns `false` for any non-finite / non-positive input — defensive
 * defaults so a transient bad reading (e.g. NaN from a server that
 * didn't return usage) never accidentally triggers compression.
 *
 * Pure: same inputs always yield the same output. No side effects.
 */
export function shouldAutoCompress(args: ShouldAutoCompressArgs): boolean {
  const { contextTokens, maxContextTokens } = args;
  const triggerAtPercent =
    args.triggerAtPercent ?? DEFAULT_AUTO_COMPRESS_TRIGGER_PERCENT;

  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return false;
  if (!Number.isFinite(maxContextTokens) || maxContextTokens <= 0) return false;
  if (!Number.isFinite(triggerAtPercent)) return false;
  // Clamp to [0, 1]. A misconfigured triggerAtPercent of 0 would
  // trivially fire on any non-empty context — clamp to 0 still
  // returns true (intentional: caller asked for "always compress")
  // but values >1 would never fire — clamp to 1 so the predicate
  // can still trigger when the context exactly fills.
  const clamped =
    triggerAtPercent < 0 ? 0 : triggerAtPercent > 1 ? 1 : triggerAtPercent;

  const ratio = contextTokens / maxContextTokens;
  return ratio >= clamped;
}

/**
 * Default cooldown (ms) between auto-compress invocations. Mirrored
 * by `app.tsx`'s `AUTO_COMPRESS_COOLDOWN_MS` constant — extracted
 * here so the cooldown predicate is unit-testable without standing
 * up the React tree.
 */
export const DEFAULT_AUTO_COMPRESS_COOLDOWN_MS = 60_000;

export interface AutoCompressCooldownArgs {
  /** `Date.now()`-style timestamp of the LAST successful auto-compress, or 0 if never. */
  lastCompressAt: number;
  /** Current `Date.now()`-style timestamp. */
  now: number;
  /** Minimum gap between compresses. Defaults to {@link DEFAULT_AUTO_COMPRESS_COOLDOWN_MS}. */
  cooldownMs?: number;
}

/**
 * Cooldown predicate. Returns `true` when an auto-compress is allowed
 * (cooldown elapsed); `false` when the previous compress is still
 * inside the cooldown window. Pure / no I/O.
 */
export function autoCompressCooldownElapsed(
  args: AutoCompressCooldownArgs,
): boolean {
  const cooldown = args.cooldownMs ?? DEFAULT_AUTO_COMPRESS_COOLDOWN_MS;
  if (!Number.isFinite(args.lastCompressAt) || args.lastCompressAt <= 0) {
    return true;
  }
  if (!Number.isFinite(args.now)) return false;
  if (!Number.isFinite(cooldown) || cooldown < 0) return true;
  return args.now - args.lastCompressAt >= cooldown;
}
