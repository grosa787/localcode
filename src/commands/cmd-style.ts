/**
 * /style — switch the active "output style" preamble that nudges how
 * the model narrates its responses.
 *
 * Usage:
 *   /style                  → print current style + available options.
 *   /style <name>           → switch to one of:
 *       - `concise`     — minimal narration, direct answers (default).
 *       - `explanatory` — adds rationale, tradeoffs, and alternatives.
 *       - `verbose`     — full step-by-step commentary.
 *
 * The selected style is persisted at the TOP level of the config
 * (`outputStyle`) and injected into the system prompt via
 * `ContextManager.buildSystemPrompt({ outputStyle })`. The preamble
 * occupies a single line — keeping the prefix-cache stable for any
 * given style.
 */

import type { ConfigManager } from '@/config/config-manager';
import { OutputStyleSchema } from '@/config/types';
import type { CommandContext, OutputStyle, SlashCommand } from '@/types/global';

export interface StyleDeps {
  configManager: ConfigManager;
}

const STYLE_NAME = 'style';
const STYLE_DESCRIPTION =
  'Switch the active output style (concise / explanatory / verbose).';
const STYLE_USAGE = '/style [name]';

const STYLE_NAMES: readonly OutputStyle[] = [
  'concise',
  'explanatory',
  'verbose',
];

const STYLE_DESCRIPTIONS: Record<OutputStyle, string> = {
  concise: 'minimal narration, direct answers',
  explanatory: 'include rationale, tradeoffs, and alternatives where relevant',
  verbose: 'detailed step-by-step commentary',
};

function isOutputStyle(value: string): value is OutputStyle {
  return OutputStyleSchema.safeParse(value).success;
}

export function createStyleCommand(deps: StyleDeps): SlashCommand {
  const { configManager } = deps;

  return {
    name: STYLE_NAME,
    description: STYLE_DESCRIPTION,
    usage: STYLE_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const arg = args.trim();
      const current: OutputStyle = ctx.config.outputStyle ?? 'concise';

      if (arg.length === 0) {
        ctx.print(`Current output style: ${current}`);
        ctx.print('Available styles:');
        for (const name of STYLE_NAMES) {
          const marker = name === current ? '*' : ' ';
          ctx.print(`  ${marker} ${name} — ${STYLE_DESCRIPTIONS[name]}`);
        }
        ctx.print('Switch with `/style <name>`.');
        return;
      }

      if (!isOutputStyle(arg)) {
        ctx.print(
          `Unknown style: '${arg}'. Valid styles: ${STYLE_NAMES.join(', ')}.`,
        );
        return;
      }

      if (arg === current) {
        ctx.print(`Already on style '${arg}'.`);
        return;
      }

      try {
        configManager.update({ outputStyle: arg });
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to switch output style: ${msg}`);
        return;
      }

      ctx.print(`Output style set to '${arg}' — ${STYLE_DESCRIPTIONS[arg]}.`);
    },
  };
}
