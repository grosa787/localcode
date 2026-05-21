/**
 * /ctxsize — inspect and tune the context window + keep-alive values.
 *
 *   /ctxsize                      → show current max-tokens + keep-alive
 *   /ctxsize <N>                  → set max tokens (integer, 1024..1_048_576)
 *   /ctxsize keepalive <seconds>  → set keep-alive seconds (0..86_400)
 *
 * The underlying knobs live at `config.context.maxTokens` and
 * `config.context.keepAliveSeconds` in `~/.localcode/config.toml`.
 *
 * Behavioural notes surfaced to the user after a change:
 *   - Ollama: the `num_ctx` / `keep_alive` options take effect on the
 *     NEXT request — the model reloads with the new window.
 *   - LM Studio: context length is configured at model load time in
 *     LM Studio itself; our `/ctxsize` value is advisory (used purely for
 *     the message-history budgeting on our side).
 */

import type { Backend, SlashCommand, CommandContext } from '@/types/global';
import type { ConfigManager } from '@/config/config-manager';

export interface CtxSizeDeps {
  configManager: ConfigManager;
}

const CTXSIZE_NAME = 'ctxsize';
const CTXSIZE_DESCRIPTION =
  'Show or change the model context window (num_ctx) and keep-alive';
const CTXSIZE_USAGE = '/ctxsize [N | keepalive <seconds>]';

// Reasonable clamps. 1024 is the smallest widely-used Llama ctx; ~1M
// covers the long-context frontier (Qwen2.5-1M, etc.).
const MIN_MAX_TOKENS = 1024;
const MAX_MAX_TOKENS = 1_048_576;
// Keep-alive: 0 means unload immediately; 24h upper bound prevents typos.
const MIN_KEEP_ALIVE = 0;
const MAX_KEEP_ALIVE = 86_400;

export function createCtxSizeCommand(deps: CtxSizeDeps): SlashCommand {
  const { configManager } = deps;

  return {
    name: CTXSIZE_NAME,
    description: CTXSIZE_DESCRIPTION,
    usage: CTXSIZE_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const parts = args.trim().split(/\s+/).filter((s) => s.length > 0);

      // FIX #32 — no-args opens the CtxSizeOverlay when the host wires
      // the `showOverlay` dispatcher. Falls back to the text snapshot
      // for legacy callers (tests, non-interactive contexts).
      if (parts.length === 0) {
        if (ctx.showOverlay !== undefined) {
          ctx.showOverlay('ctxsize');
          return;
        }
        printCurrent(ctx);
        return;
      }

      const first = parts[0]?.toLowerCase() ?? '';

      if (first === 'keepalive' || first === 'keep-alive' || first === 'keep_alive') {
        const raw = parts[1];
        if (raw === undefined) {
          ctx.print('Usage: /ctxsize keepalive <seconds>');
          return;
        }
        await setKeepAlive(ctx, configManager, raw);
        return;
      }

      // Otherwise treat the first token as an integer max-tokens value.
      await setMaxTokens(ctx, configManager, first);
    },
  };
}

function printCurrent(ctx: CommandContext): void {
  const { maxTokens, keepAliveSeconds } = ctx.config.context;
  ctx.print(`Context window: ${maxTokens} tokens`);
  ctx.print(
    `Keep-alive: ${keepAliveSeconds}s (${formatSecondsHuman(keepAliveSeconds)})`,
  );
  ctx.print(`Backend: ${ctx.config.backend.type}`);
  ctx.print(backendHint(ctx.config.backend.type));
}

async function setMaxTokens(
  ctx: CommandContext,
  configManager: ConfigManager,
  rawValue: string,
): Promise<void> {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== rawValue) {
    ctx.print(
      `Invalid context size '${rawValue}'. Expected an integer, e.g. /ctxsize 32768.`,
    );
    return;
  }
  if (parsed < MIN_MAX_TOKENS || parsed > MAX_MAX_TOKENS) {
    ctx.print(
      `Context size out of range: ${parsed}. Must be between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}.`,
    );
    return;
  }

  try {
    configManager.update({ context: { maxTokens: parsed } });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to update context size: ${msg}`);
    return;
  }

  ctx.print(`Context window set to ${parsed} tokens.`);
  ctx.print(backendHint(ctx.config.backend.type));
}

async function setKeepAlive(
  ctx: CommandContext,
  configManager: ConfigManager,
  rawValue: string,
): Promise<void> {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== rawValue) {
    ctx.print(
      `Invalid keep-alive value '${rawValue}'. Expected an integer number of seconds.`,
    );
    return;
  }
  if (parsed < MIN_KEEP_ALIVE || parsed > MAX_KEEP_ALIVE) {
    ctx.print(
      `Keep-alive out of range: ${parsed}. Must be between ${MIN_KEEP_ALIVE} and ${MAX_KEEP_ALIVE} seconds.`,
    );
    return;
  }

  try {
    configManager.update({ context: { keepAliveSeconds: parsed } });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to update keep-alive: ${msg}`);
    return;
  }

  ctx.print(
    `Keep-alive set to ${parsed}s (${formatSecondsHuman(parsed)}).`,
  );
  ctx.print(keepAliveHint(ctx.config.backend.type));
}

function formatSecondsHuman(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) {
    return rem === 0 ? `${minutes}m` : `${minutes}m${rem}s`;
  }
  const hours = Math.floor(minutes / 60);
  const mrem = minutes % 60;
  return mrem === 0 ? `${hours}h` : `${hours}h${mrem}m`;
}

/**
 * Per-backend hint surfaced after a `/ctxsize` change.
 *
 * R12 (Agent F): widened from `'ollama' | 'lmstudio'` to the full
 * {@link Backend} enum so cloud providers (OpenAI, Anthropic, OpenRouter,
 * Google, custom) get an accurate explanation of how their per-model
 * context window is managed. Cloud providers don't accept a num_ctx knob
 * — the value is advisory and used only for message-history budgeting on
 * our side.
 */
function backendHint(backend: Backend): string {
  switch (backend) {
    case 'ollama':
      return 'Ollama: model will reload with the new num_ctx on the next prompt.';
    case 'lmstudio':
      return 'LM Studio: context length is configured at model load in LM Studio; /ctxsize here is advisory only for message-history budgeting.';
    case 'openai':
    case 'anthropic':
    case 'openrouter':
    case 'google':
      return 'Cloud provider: per-model context windows are fixed server-side; /ctxsize here is advisory only for message-history budgeting.';
    case 'custom':
      return 'Custom endpoint: /ctxsize here is advisory only — your endpoint controls its own context window.';
    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      return '/ctxsize value is advisory for message-history budgeting.';
    }
  }
}

/**
 * Per-backend keep-alive hint for `/ctxsize keepalive <seconds>`.
 *
 * Only Ollama honours `keep_alive` natively (forwarded as `keep_alive`
 * on each request). Every other backend ignores the value — we surface
 * that explicitly so the user knows their setting is local-only.
 */
function keepAliveHint(backend: Backend): string {
  if (backend === 'ollama') {
    return 'Ollama: the model will stay resident for this duration after each request.';
  }
  if (backend === 'lmstudio') {
    return 'LM Studio: keep-alive is managed by LM Studio itself; this value is advisory.';
  }
  return 'Cloud / custom backend: keep-alive is managed server-side; this value is local-only.';
}
