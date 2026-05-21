/**
 * /model — list, switch, or refresh the active LLM model.
 *
 * Subcommands:
 *   /model               → open the model-select screen
 *   /model refresh       → re-fetch the list from the server, persist it
 *   /model <name>        → if `<name>` matches a cached model exactly,
 *                          switch to it and persist; otherwise open the
 *                          model-select overlay PRE-FILTERED with `<name>`
 *                          (R13 — Agent 8). The overlay opens in browse
 *                          mode with the filter already applied so arrows
 *                          navigate the narrowed list immediately.
 *
 * R13 rationale (Agent 8): with OpenRouter exposing 200+ models, the
 * exact-match-only switch path was hostile — typing `/model claude`
 * silently switched to a literal "claude" string the server then
 * rejected. The new behaviour treats `<name>` as either an exact id (no
 * UI surfaces) or a query (overlay opens narrowed). Hosts that don't
 * supply `showOverlay` fall back to the legacy "warn + persist" path
 * for backward compatibility.
 */

import type { LLMAdapter } from '@/llm/adapter';
import type { ConfigManager } from '@/config/config-manager';
import type {
  Screen,
  SlashCommand,
  CommandContext,
} from '@/types/global';

export interface ModelDeps {
  llm: LLMAdapter;
  configManager: ConfigManager;
  setScreen: (screen: Screen) => void;
}

const MODEL_NAME = 'model';
const MODEL_DESCRIPTION = 'List, switch, or refresh the active model';
const MODEL_USAGE = '/model [name|refresh]';

export function createModelCommand(deps: ModelDeps): SlashCommand {
  const { llm, configManager, setScreen } = deps;

  return {
    name: MODEL_NAME,
    description: MODEL_DESCRIPTION,
    usage: MODEL_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();

      // /model  -> open the ModelOverlay when available (FIX #32);
      // falls back to the full-screen modelSelect route for legacy
      // hosts that don't wire `showOverlay`.
      if (trimmed.length === 0) {
        if (ctx.showOverlay !== undefined) {
          ctx.showOverlay('model');
          return;
        }
        setScreen('modelSelect');
        return;
      }

      // /model refresh -> re-fetch the server's model list.
      if (trimmed.toLowerCase() === 'refresh') {
        ctx.print('Fetching available models from server...');
        try {
          const available = await llm.getModels();
          configManager.update({ model: { available } });
          ctx.print(`✓ Refreshed ${available.length} model(s).`);
          if (available.length > 0) {
            const preview = available.slice(0, 10).join(', ');
            const suffix = available.length > 10 ? ', ...' : '';
            ctx.print(`  ${preview}${suffix}`);
          }
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to refresh models: ${msg}`);
        }
        return;
      }

      // /model <name> -> switch to the named model and persist.
      const requested = trimmed;
      const cached = ctx.config.model.available;
      const isExactMatch = cached.includes(requested);

      // R13 (Agent 8) — when `<name>` is NOT an exact match against the
      // cached registry, treat it as a filter query and open the model
      // overlay narrowed to it (preserves user intent — they were
      // probably typing a search, not a full id). The overlay handles
      // the actual selection from there. Hosts without `showOverlay`
      // fall back to the legacy "warn + persist" path so non-interactive
      // contexts (tests, scripts) keep working.
      if (!isExactMatch && cached.length > 0 && ctx.showOverlay !== undefined) {
        ctx.showOverlay('model', { filter: requested });
        return;
      }

      // Legacy fall-through: either the registry is empty (we trust the
      // server to validate at chat time), the host doesn't supply an
      // overlay dispatcher, or the name matched exactly. The original
      // FIX-#15 warning path is preserved for the empty-registry case so
      // headless callers still get feedback.
      if (cached.length > 0 && !isExactMatch) {
        ctx.print(
          `Warning: '${requested}' is not in the cached model list. ` +
            `Run /model refresh to update, or proceed anyway — the server may still accept it.`,
        );
      }

      try {
        configManager.update({ model: { current: requested } });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to save model selection: ${msg}`);
        return;
      }

      ctx.print(`✓ Model switched to ${requested}`);
    },
  };
}
