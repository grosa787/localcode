/**
 * /site — open the LocalCode landing page in the default browser.
 *
 * Pure local action (no LLM round-trip): we just shell out to the
 * platform-appropriate URL opener (`open` on macOS, `xdg-open` on Linux,
 * `cmd /c start` on Windows). If the launcher fails we print the URL so
 * the user can copy/paste it.
 */

import { execa } from 'execa';
import type { SlashCommand, CommandContext } from '@/types/global';

const NAME = 'site';
const DESCRIPTION = 'Open the LocalCode landing page in your default browser.';
const USAGE = '/site';

const SITE_URL = 'https://grosa787.github.io/localcode';

interface OpenResult {
  readonly ok: boolean;
  readonly stderr?: string;
}

async function openUrl(url: string): Promise<OpenResult> {
  // platform → command/args. We pick by `process.platform` instead of
  // sniffing the UA because this runs in Bun on a workstation.
  let cmd: string;
  let args: ReadonlyArray<string>;
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    await execa(cmd, args, { stdio: 'ignore', timeout: 5_000 });
    return { ok: true };
  } catch (cause) {
    const stderr = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, stderr };
  }
}

export function createSiteCommand(): SlashCommand {
  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (_args: string, ctx: CommandContext): Promise<void> => {
      ctx.print(`Opening ${SITE_URL} …`);
      const result = await openUrl(SITE_URL);
      if (result.ok) return;
      // Graceful degrade: surface the URL so the user can copy it.
      ctx.print(`Could not launch a browser: ${result.stderr ?? 'unknown error'}`);
      ctx.print(`Visit manually: ${SITE_URL}`);
    },
  };
}
