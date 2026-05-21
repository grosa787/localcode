/**
 * /provider — switch backend (Ollama, LM Studio, or a custom OpenAI-compat
 * endpoint) and/or edit the base URL used for each.
 *
 * Subcommands:
 *   /provider                     → open the ProviderOverlay (FIX #33)
 *                                   when the host supplies an overlay
 *                                   dispatcher; otherwise prints the
 *                                   current backend + instructions.
 *   /provider show                → print the current backend + URL.
 *   /provider ollama              → switch backend to Ollama (keeps
 *                                   current URL if already Ollama, else
 *                                   resets to the default).
 *   /provider lmstudio            → switch backend to LM Studio (keeps
 *                                   current URL if already LM Studio,
 *                                   else resets to the default).
 *   /provider custom <http(s)://> → keep the current backend type and
 *                                   point it at the supplied URL. The
 *                                   user is responsible for choosing a
 *                                   compatible server.
 *
 * The ProviderOverlay (when present) owns interactive switching: this
 * command just dispatches it. All persistence lives in ConfigManager —
 * we never mutate `ctx.config` directly so the app picks up the change
 * on the next read.
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import type { ConfigManager } from '@/config/config-manager';

export interface ProviderDeps {
  configManager: ConfigManager;
}

const PROVIDER_NAME = 'provider';
const PROVIDER_DESCRIPTION =
  'Switch between Ollama, LM Studio, or a custom backend URL.';
const PROVIDER_USAGE =
  '/provider [show | ollama | lmstudio | custom <url>]';

const OLLAMA_DEFAULT_URL = 'http://localhost:11434';
const LMSTUDIO_DEFAULT_URL = 'http://localhost:1234/v1';

// Match what ProviderOverlay (and ConfigSchema) accept: http(s):// only.
const URL_SHAPE = /^https?:\/\//;

export function createProviderCommand(deps: ProviderDeps): SlashCommand {
  const { configManager } = deps;

  return {
    name: PROVIDER_NAME,
    description: PROVIDER_DESCRIPTION,
    usage: PROVIDER_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();

      // No args → overlay when available; text fallback otherwise.
      if (trimmed.length === 0) {
        if (ctx.showOverlay !== undefined) {
          ctx.showOverlay('provider');
          return;
        }
        printCurrent(ctx, configManager);
        ctx.print(
          'Use /provider ollama | lmstudio | custom <url> to switch.',
        );
        return;
      }

      const parts = trimmed.split(/\s+/).filter((s) => s.length > 0);
      const verb = parts[0]?.toLowerCase() ?? '';

      if (verb === 'show') {
        printCurrent(ctx, configManager);
        return;
      }

      if (verb === 'ollama' || verb === 'lmstudio') {
        switchBackend(ctx, configManager, verb);
        return;
      }

      if (verb === 'custom') {
        const url = parts.slice(1).join(' ');
        setCustomUrl(ctx, configManager, url);
        return;
      }

      ctx.print(
        `Unknown subcommand: ${verb}. Usage: ${PROVIDER_USAGE}`,
      );
    },
  };
}

function printCurrent(
  ctx: CommandContext,
  configManager: ConfigManager,
): void {
  let backendType: string;
  let baseUrl: string;
  try {
    const cfg = configManager.read();
    backendType = cfg.backend.type;
    baseUrl = cfg.backend.baseUrl;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to read current provider: ${msg}`);
    return;
  }
  ctx.print(`Backend: ${backendType}  ${baseUrl}`);
}

function switchBackend(
  ctx: CommandContext,
  configManager: ConfigManager,
  target: 'ollama' | 'lmstudio',
): void {
  let current;
  try {
    current = configManager.read();
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to read current provider: ${msg}`);
    return;
  }

  // If the user is already on the target backend, preserve their current
  // URL. Otherwise fall back to the default for the new backend —
  // sticking the old URL onto the wrong backend type would silently
  // break requests.
  const defaultUrl =
    target === 'ollama' ? OLLAMA_DEFAULT_URL : LMSTUDIO_DEFAULT_URL;
  const newBaseUrl =
    current.backend.type === target ? current.backend.baseUrl : defaultUrl;

  try {
    configManager.update({
      backend: { type: target, baseUrl: newBaseUrl },
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to switch backend: ${msg}`);
    return;
  }

  ctx.print(`✓ Backend switched to ${target}: ${newBaseUrl}`);
}

function setCustomUrl(
  ctx: CommandContext,
  configManager: ConfigManager,
  rawUrl: string,
): void {
  const url = rawUrl.trim();
  if (url.length === 0 || !URL_SHAPE.test(url)) {
    ctx.print('Usage: /provider custom <http(s)://...>');
    return;
  }

  let current;
  try {
    current = configManager.read();
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to read current provider: ${msg}`);
    return;
  }

  try {
    // Preserve the existing backend type — the user is telling us to
    // point at a non-default endpoint but isn't specifying whether the
    // wire protocol matches Ollama or LM Studio. The ProviderOverlay
    // handles the richer case interactively; this subcommand is a fast
    // URL override only.
    configManager.update({
      backend: { type: current.backend.type, baseUrl: url },
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to update backend URL: ${msg}`);
    return;
  }

  ctx.print(`✓ Backend URL updated: ${url}`);
}
