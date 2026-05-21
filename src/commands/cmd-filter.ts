/**
 * /filter — output visibility presets.
 *
 * Usage:
 *   /filter           Print the active preset.
 *   /filter all       Show everything (thinking + tool calls + system notes).
 *   /filter concise   Hide thinking only.
 *   /filter clean     Hide thinking + tool calls (keep system notes).
 *
 * The renderer reads `chatState.outputFilters` and skips matching rows.
 * The persisted message log is never mutated — disabling a category
 * just hides the rows from view; re-enabling them brings them back
 * intact.
 *
 * Implementation note: the command needs to dispatch reducer actions
 * but `CommandContext` deliberately doesn't expose dispatch. We thread
 * the setter callbacks via the deps closure so the host (app.tsx)
 * owns the reducer write and the command stays a thin wrapper.
 */

import type { SlashCommand, CommandContext } from '@/types/global';

/** Mirror of the slice shape — kept in sync with `ChatState.outputFilters`. */
export interface OutputFiltersSnapshot {
  readonly thinking: boolean;
  readonly toolCalls: boolean;
  readonly systemNotes: boolean;
}

export interface FilterDeps {
  /** Read the current filter slice (so /filter with no args can echo). */
  readonly getOutputFilters: () => OutputFiltersSnapshot;
  /** Write a new explicit filter preset. The reducer normalises. */
  readonly setOutputFilters: (filters: OutputFiltersSnapshot) => void;
}

const FILTER_NAME = 'filter';
const FILTER_DESCRIPTION = 'Toggle output visibility presets (all|concise|clean)';
const FILTER_USAGE = '/filter [all|concise|clean]';

/** Resolve a textual preset to the matching boolean triple. */
function presetToFilters(preset: string): OutputFiltersSnapshot | null {
  const norm = preset.trim().toLowerCase();
  if (norm === 'all') {
    return { thinking: true, toolCalls: true, systemNotes: true };
  }
  if (norm === 'concise') {
    return { thinking: false, toolCalls: true, systemNotes: true };
  }
  if (norm === 'clean') {
    return { thinking: false, toolCalls: false, systemNotes: true };
  }
  return null;
}

/** Inverse — describe the currently-active preset for the no-arg echo. */
function describeFilters(f: OutputFiltersSnapshot): string {
  if (f.thinking && f.toolCalls && f.systemNotes) return 'all';
  if (!f.thinking && f.toolCalls && f.systemNotes) return 'concise (thinking hidden)';
  if (!f.thinking && !f.toolCalls && f.systemNotes) {
    return 'clean (thinking + tool calls hidden)';
  }
  if (!f.thinking && !f.toolCalls && !f.systemNotes) {
    return 'minimal (everything hidden)';
  }
  return 'custom';
}

export function createFilterCommand(deps: FilterDeps): SlashCommand {
  const { getOutputFilters, setOutputFilters } = deps;
  return {
    name: FILTER_NAME,
    description: FILTER_DESCRIPTION,
    usage: FILTER_USAGE,
    execute: (args: string, ctx: CommandContext): void => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        const current = getOutputFilters();
        ctx.print(
          `Output filter: ${describeFilters(current)}. Usage: ${FILTER_USAGE}`,
        );
        return;
      }
      const next = presetToFilters(trimmed);
      if (next === null) {
        ctx.print(
          `Unknown preset "${trimmed}". Valid: all | concise | clean.`,
        );
        return;
      }
      setOutputFilters(next);
      ctx.print(`Output filter set to ${describeFilters(next)}.`);
    },
  };
}
