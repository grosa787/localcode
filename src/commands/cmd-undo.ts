/**
 * /undo — roll back recent file mutations.
 *
 * Snapshots are captured by the `ToolExecutor` immediately before a
 * `write_file` / `edit_file` / `multi_edit` commit runs. `/undo` pops
 * the most recent snapshot and restores the file contents (or deletes
 * the file when the mutation created it new).
 *
 * Forms:
 *   /undo            — restore the most recent snapshot.
 *   /undo <n>        — restore the last `n` snapshots in LIFO order.
 *   /undo list       — print the snapshot stack with paths + timestamps.
 *
 * **In-memory only.** The snapshot stack is process-scoped: restarting
 * LocalCode drops every snapshot. There is no persistent on-disk
 * history. This is documented in the command's printed help text.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { CommandContext, SlashCommand } from '@/types/global';
import { type FileSnapshotStack } from '@/sessions/file-snapshot-stack';

export interface UndoDeps {
  /**
   * The process-wide snapshot stack. Wired by the composition root via
   * `getProcessFileSnapshotStack()` so tests can inject a fresh stack.
   */
  stack: FileSnapshotStack;
  /** Project root — used to resolve relative paths from snapshots. */
  projectRoot: string;
}

const NAME = 'undo';
const DESCRIPTION =
  'Restore files mutated by the most recent write_file / edit_file / multi_edit call (in-memory; not persisted across restarts).';
const USAGE = '/undo [<n>|list]';

function resolveAbsolute(projectRoot: string, relOrAbs: string): string {
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(projectRoot, relOrAbs);
}

function formatTimestamp(ms: number): string {
  // Local-time `HH:MM:SS` is enough — the stack only carries the last 10
  // entries by default so we never need a date.
  try {
    const d = new Date(ms);
    const pad = (n: number): string => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return String(ms);
  }
}

/**
 * Restore a single snapshot. Returns a short status string for the
 * caller to print. Never throws — restore failures are surfaced as
 * status strings so the model / UI can react gracefully.
 */
async function restoreOne(
  entry: { path: string; contentBefore: string | null; toolName: string },
  projectRoot: string,
): Promise<string> {
  const abs = resolveAbsolute(projectRoot, entry.path);
  try {
    if (entry.contentBefore === null) {
      // The mutation created a new file — undoing means deleting it.
      try {
        await fs.unlink(abs);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return `↶ ${entry.path} — already absent (skipped)`;
        }
        throw err;
      }
      return `↶ ${entry.path} — deleted (was created by ${entry.toolName})`;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, entry.contentBefore, 'utf8');
    return `↶ ${entry.path} — restored (${entry.contentBefore.length} bytes)`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `✗ ${entry.path} — restore failed: ${msg}`;
  }
}

export function createUndoCommand(deps: UndoDeps): SlashCommand {
  const { stack, projectRoot } = deps;

  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();

      // /undo list — read-only print
      if (trimmed.toLowerCase() === 'list') {
        const entries = stack.list();
        if (entries.length === 0) {
          ctx.print('No file mutations recorded yet.');
          ctx.print('(snapshots are in-memory; restarting LocalCode drops them.)');
          return;
        }
        ctx.print(`File snapshot stack (newest first; capacity ${stack.maxCapacity}):`);
        entries.forEach((entry, i) => {
          const flag = entry.contentBefore === null ? ' [new file]' : '';
          ctx.print(
            `  ${i + 1}. ${formatTimestamp(entry.timestamp)}  ${entry.toolName}  ${entry.path}${flag}`,
          );
        });
        return;
      }

      // /undo or /undo <n>
      let count = 1;
      if (trimmed.length > 0) {
        const parsed = Number.parseInt(trimmed, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          ctx.print(`Usage: ${USAGE}`);
          return;
        }
        count = Math.min(parsed, stack.size);
      }

      if (stack.size === 0) {
        ctx.print('No file mutations to undo.');
        ctx.print('(snapshots are in-memory; restarting LocalCode drops them.)');
        return;
      }

      const restored: string[] = [];
      for (let i = 0; i < count; i++) {
        const entry = stack.pop();
        if (entry === null) break;
        restored.push(await restoreOne(entry, projectRoot));
      }
      if (restored.length === 0) {
        ctx.print('Nothing was restored.');
        return;
      }
      ctx.print(`Restored ${restored.length} snapshot${restored.length === 1 ? '' : 's'}:`);
      for (const line of restored) ctx.print(`  ${line}`);
    },
  };
}
