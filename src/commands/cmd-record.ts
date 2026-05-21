/**
 * /record — capture user-model exchanges to a file for later replay.
 *
 * Forms:
 *   /record start                 begin capture (idempotent).
 *   /record stop                  finalize + save to the default path.
 *   /record save <file>           explicit save path (saves current
 *                                 in-flight recording without stopping).
 *   /record list                  list saved recordings under
 *                                 `<projectRoot>/.localcode/recordings/`.
 *
 * Captured entries flow into the recorder via host-side event
 * subscriptions wired in the composition root (TUI / web). This command
 * is intentionally a thin wrapper over the `Recorder` API so it can be
 * unit-tested against a fake recorder + fake fs.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommandContext, SlashCommand } from '@/types/global';
import type { Recording } from '@/recordings';
import { Recorder, defaultRecordingPath, saveRecording } from '@/recordings';

export interface RecordDeps {
  /** Process-scoped recorder singleton wired by the composition root. */
  recorder: Recorder;
  /** Project root — used to resolve the default save directory. */
  projectRoot: string;
  /**
   * Optional override for the fs save call — tests inject a memory
   * fake so they don't touch real disk.
   */
  saveFn?: (rec: Recording, target: string) => Promise<void>;
  /**
   * Optional override for listing existing recordings. Returns absolute
   * paths. Defaults to scanning `<projectRoot>/.localcode/recordings/`.
   */
  listFn?: (dir: string) => Promise<string[]>;
}

const NAME = 'record';
const DESCRIPTION =
  'Capture user-model exchanges to a file for later /replay demo.';
const USAGE = '/record <start|stop|save <file>|list>';

async function defaultListRecordings(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((e) => e.endsWith('.lcrec'))
      .map((e) => path.join(dir, e))
      .sort();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw cause;
  }
}

export function createRecordCommand(deps: RecordDeps): SlashCommand {
  const { recorder, projectRoot } = deps;
  const saveFn = deps.saveFn ?? saveRecording;
  const listFn = deps.listFn ?? defaultListRecordings;

  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        ctx.print(`Usage: ${USAGE}`);
        ctx.print(
          recorder.isRecording
            ? `Recording is active (session ${recorder.activeSessionId ?? 'unknown'}).`
            : 'No recording in progress.',
        );
        return;
      }
      const firstSpace = trimmed.indexOf(' ');
      const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

      if (verb === 'start') {
        const sessionId = ctx.sessionId ?? 'unknown-session';
        if (recorder.isRecording) {
          ctx.print(
            `Already recording (session ${recorder.activeSessionId ?? 'unknown'}). Use \`/record stop\` to finalize.`,
          );
          return;
        }
        const rec = recorder.start(sessionId);
        ctx.print(`Recording started: ${rec.id} (session ${rec.sessionId}).`);
        return;
      }

      if (verb === 'stop') {
        if (!recorder.isRecording) {
          ctx.print('No active recording — use `/record start` first.');
          return;
        }
        const rec = recorder.stop();
        const target = defaultRecordingPath(projectRoot, rec.id);
        try {
          await saveFn(rec, target);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Recording stopped but save failed: ${msg}`);
          return;
        }
        ctx.print(
          `Recording stopped. ${rec.entries.length} entries saved to ${target}`,
        );
        return;
      }

      if (verb === 'save') {
        if (rest.length === 0) {
          ctx.print('Usage: /record save <file>');
          return;
        }
        if (!recorder.isRecording) {
          ctx.print('No active recording — nothing to save.');
          return;
        }
        const rec = recorder.snapshot();
        const target = path.isAbsolute(rest)
          ? rest
          : path.resolve(projectRoot, rest);
        try {
          await saveFn(rec, target);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Save failed: ${msg}`);
          return;
        }
        ctx.print(
          `Saved ${rec.entries.length} entries to ${target} (recording still active).`,
        );
        return;
      }

      if (verb === 'list') {
        const dir = path.join(projectRoot, '.localcode', 'recordings');
        let files: string[];
        try {
          files = await listFn(dir);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          ctx.print(`Failed to list recordings: ${msg}`);
          return;
        }
        if (files.length === 0) {
          ctx.print(`No recordings found under ${dir}.`);
          return;
        }
        ctx.print(`Recordings (${files.length}):`);
        for (const f of files) ctx.print(`  ${f}`);
        return;
      }

      ctx.print(`Unknown subcommand: ${verb}. Usage: ${USAGE}`);
    },
  };
}
