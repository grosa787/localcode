/**
 * /statusline — view or edit the user-customizable footer template
 * rendered under assistant messages (TUI) and in the web composer.
 *
 * Subcommands:
 *
 *   /statusline                  → print current template, enabled flag,
 *                                  and the list of recognised placeholders.
 *   /statusline set <template>   → persist `<template>` as the new format.
 *   /statusline enable           → set `statusline.enabled = true`.
 *   /statusline disable          → set `statusline.enabled = false` (fall
 *                                  back to the compact usage footer).
 *   /statusline reset            → restore the default template.
 *
 * The template is rendered via `renderStatusline(template, vars)` in
 * `src/ui/statusline-template.ts`. Recognised placeholders: `{model}`,
 * `{tokens}`, `{maxTokens}`, `{pct}`, `{cachedTokens}`, `{cost}`,
 * `{profile}`, `{provider}`, `{sessionId}`, `{branch}`, `{cwd}`. Missing
 * variables are rendered as empty strings; unknown placeholders are
 * left untouched so the user can spot typos in the rendered output.
 */

import type { ConfigManager } from '@/config/config-manager';
import type { CommandContext, SlashCommand } from '@/types/global';
import { PLACEHOLDER_NAMES } from '@/ui/statusline-template';

export interface StatuslineDeps {
  configManager: ConfigManager;
}

const STATUSLINE_NAME = 'statusline';
const STATUSLINE_DESCRIPTION =
  'View or edit the assistant footer template (placeholders: {model}, {tokens}, {pct}, etc).';
const STATUSLINE_USAGE = '/statusline [set <template> | enable | disable | reset]';

const DEFAULT_TEMPLATE =
  '{provider} · {model} · {tokens}/{maxTokens} ({pct}%) · {profile}';

export function createStatuslineCommand(deps: StatuslineDeps): SlashCommand {
  const { configManager } = deps;

  return {
    name: STATUSLINE_NAME,
    description: STATUSLINE_DESCRIPTION,
    usage: STATUSLINE_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      const cur = ctx.config.statusline ?? {
        enabled: true,
        template: DEFAULT_TEMPLATE,
      };

      if (trimmed.length === 0) {
        ctx.print(`Statusline: ${cur.enabled ? 'enabled' : 'disabled'}`);
        ctx.print(`Template: ${cur.template}`);
        ctx.print('');
        ctx.print('Placeholders:');
        for (const name of PLACEHOLDER_NAMES) {
          ctx.print(`  {${name}}`);
        }
        ctx.print('');
        ctx.print('Edit with `/statusline set <template>` (use placeholders above).');
        return;
      }

      // Split first word (the verb) from the rest (the template body).
      const firstSpace = trimmed.indexOf(' ');
      const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

      if (verb === 'set') {
        if (rest.length === 0) {
          ctx.print('Usage: /statusline set <template>');
          return;
        }
        try {
          configManager.update({
            statusline: {
              enabled: cur.enabled,
              template: rest,
            },
          });
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to update statusline template: ${msg}`);
          return;
        }
        ctx.print(`Statusline template set to: ${rest}`);
        return;
      }

      if (verb === 'enable') {
        try {
          configManager.update({
            statusline: { enabled: true, template: cur.template },
          });
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to enable statusline: ${msg}`);
          return;
        }
        ctx.print('Statusline enabled.');
        return;
      }

      if (verb === 'disable') {
        try {
          configManager.update({
            statusline: { enabled: false, template: cur.template },
          });
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to disable statusline: ${msg}`);
          return;
        }
        ctx.print('Statusline disabled — falling back to the compact usage footer.');
        return;
      }

      if (verb === 'reset') {
        try {
          configManager.update({
            statusline: { enabled: true, template: DEFAULT_TEMPLATE },
          });
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to reset statusline: ${msg}`);
          return;
        }
        ctx.print(`Statusline reset to default template: ${DEFAULT_TEMPLATE}`);
        return;
      }

      ctx.print(`Unknown subcommand: ${verb}. Usage: ${STATUSLINE_USAGE}`);
    },
  };
}
