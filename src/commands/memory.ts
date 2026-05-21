/**
 * /memory — list all memory entries in the TUI (text summary by type).
 *
 * In the TUI there is no overlay, so the command prints a compact
 * grouped summary of the current project's memory entries. The web
 * frontend exposes a dedicated MemoryOverlay instead.
 *
 * Usage:
 *   /memory              — list all entries grouped by type
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import { MemoryStore } from '@/memory/store';
import { MEMORY_TYPES } from '@/memory/types';
import type { MemoryType } from '@/memory/types';

export interface MemoryDeps {
  projectRoot: string;
}

export function createMemoryCommand(deps: MemoryDeps): SlashCommand {
  return {
    name: 'memory',
    description: 'List project memory entries grouped by type',
    usage: '/memory',
    execute: async (_args: string, ctx: CommandContext): Promise<void> => {
      const store = new MemoryStore(deps.projectRoot);
      const entries = await store.list();

      if (entries.length === 0) {
        ctx.print('No memory entries yet. Use the web UI (/memory overlay) or write entries to .localcode/memory/ directly.');
        return;
      }

      const grouped = new Map<MemoryType, typeof entries>();
      for (const type of MEMORY_TYPES) {
        grouped.set(type, []);
      }
      for (const entry of entries) {
        const bucket = grouped.get(entry.type);
        if (bucket !== undefined) {
          bucket.push(entry);
        }
      }

      const lines: string[] = [`Memory (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`];
      for (const type of MEMORY_TYPES) {
        const bucket = grouped.get(type);
        if (bucket === undefined || bucket.length === 0) continue;
        lines.push('');
        lines.push(`[${type}]`);
        for (const e of bucket) {
          lines.push(`  • ${e.name} — ${e.description}`);
        }
      }
      ctx.print(lines.join('\n'));
    },
  };
}
