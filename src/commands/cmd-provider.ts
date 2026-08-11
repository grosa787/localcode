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
 *   /provider unsloth             → switch backend to Unsloth Studio
 *                                   (localhost, but it DOES need an API
 *                                   key — set it via /provider overlay
 *                                   or UNSLOTH_API_KEY).
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
import { PROVIDER_DEFAULTS } from '@/config/defaults';
// LOCALE-APPLY-SECTION — the Unsloth `--disable-tools` warning is the one
// print on this command a user must actually read, so it is localised.
import { t } from '@/i18n';
// LOCALE-APPLY-SECTION-END

export interface ProviderDeps {
  configManager: ConfigManager;
}

/** Backends this command can switch to by name (URL-only verbs excluded). */
type SwitchTarget = 'ollama' | 'lmstudio' | 'unsloth';

const PROVIDER_NAME = 'provider';
const PROVIDER_DESCRIPTION =
  'Switch between Ollama, LM Studio, Unsloth Studio, or a custom backend URL.';
const PROVIDER_USAGE =
  '/provider [show | ollama | lmstudio | unsloth | custom <url>]';

// Default URLs come from PROVIDER_DEFAULTS — a local copy would silently
// drift from the onboarding screen and the /provider overlay.

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
          'Use /provider ollama | lmstudio | unsloth | custom <url> to switch.',
        );
        return;
      }

      const parts = trimmed.split(/\s+/).filter((s) => s.length > 0);
      const verb = parts[0]?.toLowerCase() ?? '';

      if (verb === 'show') {
        printCurrent(ctx, configManager);
        return;
      }

      if (verb === 'ollama' || verb === 'lmstudio' || verb === 'unsloth') {
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
  target: SwitchTarget,
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
  const defaultUrl = PROVIDER_DEFAULTS[target].baseUrl;
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

  // Unsloth's own server-side tool loop swallows tool calls unless the
  // server was launched with --disable-tools; LocalCode then looks dead
  // rather than misconfigured. Say so at the moment of the switch.
  if (target === 'unsloth') {
    // LOCALE-APPLY-SECTION
    ctx.print(t('provider.cmd.unslothDisableTools'));
    // LOCALE-APPLY-SECTION-END
  }
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
