/**
 * HookEngine — runs user-authored shell hooks at four trigger points.
 *
 * Behaviour:
 *   - `run(ctx)` filters the configured hooks by `trigger` and (for
 *     tool triggers) the optional `toolPattern` glob.
 *   - Matching hooks are spawned in PARALLEL via `Bun.spawn(['sh', '-c',
 *     cmd], { cwd, signal })`. The aggregate latency is `max(individual)`
 *     plus a small dispatch overhead — not the sum.
 *   - Per-hook timeout (default 10s) is enforced via an `AbortSignal`
 *     scheduled with `setTimeout`. Timed-out processes report
 *     `exitCode: -1, timedOut: true`.
 *   - `${TOOL_ARG_<name>}` placeholders inside `command` are replaced
 *     with the corresponding value from `ctx.toolArgs`, single-quote
 *     shell-escaped so user-supplied data can't break out into a
 *     separate command.
 *   - All outcomes are returned; the engine never throws on a hook
 *     failure. Callers inspect `outcome.blocked` to decide whether to
 *     reject the action.
 *
 * Backwards-compat: when no hooks are configured the engine short-
 * circuits with zero overhead (no shell, no spawn) — matches the
 * "empty hooks config = identical behaviour to before" requirement.
 */

import { spawn, type SpawnOptions, type Subprocess } from 'bun';

import {
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookConfig,
  type HookContext,
  type HookLogger,
  type HookOutcome,
} from './types';
import { matchesGlob } from './matchers';
// BUILTIN-HOOKS-SECTION
import {
  runSecretScannerBuiltin,
  SECRET_SCANNER_BUILTIN,
} from '@/security/builtin-hook';
// BUILTIN-HOOKS-SECTION-END

/**
 * Internal spawn surface used by the engine. Production code uses
 * `Bun.spawn`; tests can inject a fake to avoid touching `/bin/sh`.
 */
export type SpawnFn = (
  cmd: readonly string[],
  options: SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'>,
) => Subprocess<'ignore', 'pipe', 'pipe'>;

export interface HookEngineOptions {
  /** Configured hooks (typically from `config.hooks`). May be empty. */
  hooks: readonly HookConfig[];
  /** Optional logger — defaults to a no-op. */
  logger?: HookLogger;
  /** Override `Bun.spawn` for tests. */
  spawn?: SpawnFn;
  /**
   * Override the clock for deterministic duration tests. Defaults to
   * `() => Date.now()`. The clock is sampled twice per hook (before
   * spawn, after termination) so injecting a monotonic fake makes
   * `durationMs` predictable.
   */
  now?: () => number;
}

const PLACEHOLDER_RE = /\$\{TOOL_ARG_([A-Za-z_][A-Za-z0-9_]*)\}/g;

export class HookEngine {
  private readonly hooks: readonly HookConfig[];
  private readonly logger: HookLogger;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;

  constructor(opts: HookEngineOptions) {
    this.hooks = opts.hooks;
    this.logger = opts.logger ?? {};
    this.spawnFn = opts.spawn ?? (spawn as unknown as SpawnFn);
    this.now = opts.now ?? ((): number => Date.now());
  }

  /**
   * Quick predicate — true iff at least one configured hook listens on
   * `trigger`. Lets integration sites short-circuit before doing any
   * work to build the context (especially useful in the hot tool-call
   * path).
   */
  hasHooksFor(trigger: HookConfig['trigger']): boolean {
    if (this.hooks.length === 0) return false;
    for (const h of this.hooks) {
      if (h.trigger === trigger) return true;
    }
    return false;
  }

  /**
   * Number of hooks that would match for the given context, BEFORE
   * spawning anything. Useful for fast-path tests + observability.
   */
  countMatches(ctx: HookContext): number {
    let n = 0;
    for (const h of this.hooks) {
      if (!isMatch(h, ctx)) continue;
      n += 1;
    }
    return n;
  }

  /**
   * Execute every hook that matches `ctx` in parallel. Returns an
   * outcome per executed hook. Empty input → empty output (zero-cost
   * fast path).
   *
   * Never throws on a hook failure — exceptions are converted into
   * structured `HookOutcome` records so the caller's flow stays
   * predictable.
   */
  async run(ctx: HookContext): Promise<HookOutcome[]> {
    if (this.hooks.length === 0) return [];
    const matched: HookConfig[] = [];
    for (const h of this.hooks) {
      if (isMatch(h, ctx)) matched.push(h);
    }
    if (matched.length === 0) return [];
    const tasks = matched.map((h) => this.runOne(h, ctx));
    return Promise.all(tasks);
  }

  // ---------- internals ----------

  // BUILTIN-HOOKS-SECTION
  /**
   * Dispatch a built-in hook. Unknown builtin names produce a structured
   * error outcome (`exitCode: -1`, descriptive stderr) so a stale config
   * surfaces clearly rather than silently no-op'ing.
   */
  private async runBuiltin(hook: HookConfig, ctx: HookContext): Promise<HookOutcome> {
    const startedAt = this.now();
    const name = hook.builtin ?? '';
    try {
      if (name === SECRET_SCANNER_BUILTIN) {
        const r = runSecretScannerBuiltin({ projectRoot: ctx.projectRoot });
        return {
          hook,
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          durationMs: this.now() - startedAt,
          blocked: hook.blocking === true && r.exitCode !== 0,
          timedOut: false,
        };
      }
      this.logger.warn?.(`[hooks] unknown builtin "${name}"`);
      return {
        hook,
        exitCode: -1,
        stdout: '',
        stderr: `unknown builtin hook: ${name}`,
        durationMs: this.now() - startedAt,
        blocked: hook.blocking === true,
        timedOut: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn?.(`[hooks] builtin "${name}" errored: ${msg}`);
      return {
        hook,
        exitCode: -1,
        stdout: '',
        stderr: msg,
        durationMs: this.now() - startedAt,
        blocked: hook.blocking === true,
        timedOut: false,
      };
    }
  }
  // BUILTIN-HOOKS-SECTION-END

  private async runOne(hook: HookConfig, ctx: HookContext): Promise<HookOutcome> {
    // BUILTIN-HOOKS-SECTION
    // Dispatch built-in hooks BEFORE shell spawn — they have no command
    // line, no env expansion, and no subprocess. Aborts can't be applied
    // (the handlers are synchronous CPU + a single `git diff` exec), but
    // they're bounded by the diff size cap inside the handler.
    if (hook.builtin !== undefined && hook.builtin.length > 0) {
      return this.runBuiltin(hook, ctx);
    }
    // BUILTIN-HOOKS-SECTION-END
    const command = expandPlaceholders(hook.command, ctx.toolArgs);
    const timeoutMs = hook.timeout ?? DEFAULT_HOOK_TIMEOUT_MS;
    const startedAt = this.now();

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let proc: Subprocess<'ignore', 'pipe', 'pipe'>;
    try {
      proc = this.spawnFn(['sh', '-c', command], {
        cwd: ctx.projectRoot,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: buildEnv(ctx),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn?.(`[hooks] failed to spawn "${hook.command}": ${msg}`);
      return {
        hook,
        exitCode: -1,
        stdout: '',
        stderr: msg,
        durationMs: this.now() - startedAt,
        blocked: hook.blocking === true,
        timedOut: false,
      };
    }

    let stdout = '';
    let stderr = '';
    try {
      const [out, errStream, exitCode] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
        proc.exited,
      ]);
      stdout = out;
      stderr = errStream;
      clearTimeout(timer);
      const code = typeof exitCode === 'number' ? exitCode : -1;
      const effectiveCode = timedOut ? -1 : code;
      const blocked = hook.blocking === true && effectiveCode !== 0;
      return {
        hook,
        exitCode: effectiveCode,
        stdout,
        stderr: timedOut && stderr.length === 0
          ? `Hook timed out after ${timeoutMs}ms`
          : stderr,
        durationMs: this.now() - startedAt,
        blocked,
        timedOut,
      };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn?.(`[hooks] "${hook.command}" errored: ${msg}`);
      return {
        hook,
        exitCode: -1,
        stdout,
        stderr: stderr.length > 0 ? stderr : msg,
        durationMs: this.now() - startedAt,
        blocked: hook.blocking === true,
        timedOut,
      };
    }
  }
}

/**
 * Single-quote shell-escape: wrap in `'…'` and replace any embedded
 * single quotes with the canonical close-quote-escape-open dance
 * (`'\''`). Resulting string is safe to interpolate into a `sh -c`
 * command line — no metacharacter inside the value retains its shell
 * meaning.
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Expand `${TOOL_ARG_xxx}` placeholders in `command`. Missing args
 * resolve to the empty string. Non-string values are coerced via
 * `String()` before escaping. Exported for the test suite.
 */
export function expandPlaceholders(
  command: string,
  args: Record<string, unknown> | undefined,
): string {
  return command.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const raw = args === undefined ? undefined : args[name];
    if (raw === undefined || raw === null) return shellEscape('');
    if (typeof raw === 'string') return shellEscape(raw);
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      return shellEscape(String(raw));
    }
    try {
      return shellEscape(JSON.stringify(raw));
    } catch {
      return shellEscape(String(raw));
    }
  });
}

/**
 * Predicate matching a hook against a context: trigger equality plus
 * optional `toolPattern` glob match. `UserPromptSubmit` /
 * `SessionStart` ignore `toolPattern` entirely.
 */
function isMatch(hook: HookConfig, ctx: HookContext): boolean {
  if (hook.trigger !== ctx.trigger) return false;
  if (hook.trigger === 'PreToolUse' || hook.trigger === 'PostToolUse') {
    return matchesGlob(hook.toolPattern, ctx.toolName ?? '');
  }
  return true;
}

/**
 * Environment vars exposed to the hook subprocess. Inherits the
 * parent's env so the user's PATH / HOME / etc. propagate, then layers
 * in LocalCode-specific names so hooks can pivot on context without
 * relying on the inline `${TOOL_ARG_*}` substitution.
 */
function buildEnv(ctx: HookContext): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env['LOCALCODE_HOOK_TRIGGER'] = ctx.trigger;
  if (ctx.toolName !== undefined) {
    env['LOCALCODE_TOOL_NAME'] = ctx.toolName;
  }
  if (ctx.sessionId !== undefined) {
    env['LOCALCODE_SESSION_ID'] = ctx.sessionId;
  }
  if (ctx.userPrompt !== undefined) {
    env['LOCALCODE_USER_PROMPT'] = ctx.userPrompt;
  }
  env['LOCALCODE_PROJECT_ROOT'] = ctx.projectRoot;
  // PreCompact — current and max context tokens at the moment the
  // engine fired. Stringified so the spawned shell can compare via $(()).
  if (typeof ctx.contextTokens === 'number' && Number.isFinite(ctx.contextTokens)) {
    env['LOCALCODE_CONTEXT_TOKENS'] = String(ctx.contextTokens);
  }
  if (
    typeof ctx.maxContextTokens === 'number' &&
    Number.isFinite(ctx.maxContextTokens)
  ) {
    env['LOCALCODE_MAX_CONTEXT_TOKENS'] = String(ctx.maxContextTokens);
  }
  // SessionEnd — surface the reason so a single hook command can react
  // differently to `/quit` vs LRU eviction.
  if (ctx.reason !== undefined) {
    env['LOCALCODE_SESSION_END_REASON'] = ctx.reason;
  }
  // Stop — usage snapshot for the just-finished assistant turn.
  if (ctx.usage !== undefined) {
    if (
      typeof ctx.usage.promptTokens === 'number' &&
      Number.isFinite(ctx.usage.promptTokens)
    ) {
      env['LOCALCODE_STOP_USAGE_PROMPT'] = String(ctx.usage.promptTokens);
    }
    if (
      typeof ctx.usage.completionTokens === 'number' &&
      Number.isFinite(ctx.usage.completionTokens)
    ) {
      env['LOCALCODE_STOP_USAGE_COMPLETION'] = String(ctx.usage.completionTokens);
    }
    if (
      typeof ctx.usage.cachedInputTokens === 'number' &&
      Number.isFinite(ctx.usage.cachedInputTokens)
    ) {
      env['LOCALCODE_STOP_USAGE_CACHED'] = String(ctx.usage.cachedInputTokens);
    }
  }
  return env;
}

/**
 * Drain a Bun ReadableStream of bytes to a UTF-8 string. Returns an
 * empty string when the stream is undefined (some spawn callers pass
 * `stdout: 'inherit'`, but the engine always pipes — keeping this
 * defensive avoids crashing on a future config change).
 */
async function readStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
): Promise<string> {
  if (stream === null || stream === undefined) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  return result;
}
