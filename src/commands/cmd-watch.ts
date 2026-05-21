/**
 * /watch — manage long-running processes the model can observe.
 *
 * Forms:
 *   /watch <cmd…>           Begin watching a command (the rest of the
 *                           input is treated verbatim as the shell
 *                           command). Spawns via the ProcessMonitor.
 *   /watch list             List currently-watched processes.
 *   /watch tail <id> [N]    Print the last N lines from the watched
 *                           process (default 25). Combines stderr after
 *                           stdout.
 *   /watch stop <id>        Send SIGTERM (3s grace, then SIGKILL).
 *
 * The command is a thin wrapper around the `ProcessMonitor` singleton.
 * Tests inject a custom monitor instance via `WatchDeps.monitor` so
 * they never spawn real children.
 */

import type { CommandContext, SlashCommand } from '@/types/global';
import {
  ProcessMonitor,
  getProcessMonitor,
} from '@/process-monitor';

export interface WatchDeps {
  /** Project root forwarded as the spawn cwd unless the model overrides it. */
  readonly projectRoot: string;
  /**
   * Optional monitor override. Tests inject a fresh instance; the
   * default falls back to the process-wide singleton.
   */
  readonly monitor?: ProcessMonitor;
}

const NAME = 'watch';
const DESCRIPTION =
  'Watch a long-running process and surface diagnostic signals into chat.';
const USAGE = '/watch <cmd…> | /watch list | /watch tail <id> [N] | /watch stop <id>';

const DEFAULT_TAIL_LINES = 25;

function formatHealth(p: { health: string; exitCode: number | null }): string {
  if (p.health === 'alive') return 'alive';
  const code = p.exitCode === null ? '' : ` exit=${p.exitCode}`;
  return `${p.health}${code}`;
}

function formatAgeMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

export function createWatchCommand(deps: WatchDeps): SlashCommand {
  const monitor = deps.monitor ?? getProcessMonitor();
  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        ctx.print(`Usage: ${USAGE}`);
        return;
      }
      const firstSpace = trimmed.indexOf(' ');
      const head = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

      if (head === 'list') {
        const all = monitor.list();
        if (all.length === 0) {
          ctx.print('No processes are being watched.');
          return;
        }
        ctx.print(`Watched processes (${all.length}):`);
        const now = Date.now();
        for (const p of all) {
          const age = formatAgeMs(now - p.startedAt);
          ctx.print(`  ${p.id}  ${formatHealth(p)}  ${age}  ${p.label}`);
        }
        return;
      }

      if (head === 'tail') {
        const tokens = rest.split(/\s+/).filter((t) => t.length > 0);
        const id = tokens[0];
        if (id === undefined) {
          ctx.print('Usage: /watch tail <id> [N]');
          return;
        }
        const nRaw = tokens[1];
        const n =
          nRaw === undefined
            ? DEFAULT_TAIL_LINES
            : Number.isFinite(Number.parseInt(nRaw, 10))
              ? Math.max(1, Math.min(500, Number.parseInt(nRaw, 10)))
              : DEFAULT_TAIL_LINES;
        const snap = monitor.get(id);
        if (snap === null) {
          ctx.print(`Unknown watch id: ${id}`);
          return;
        }
        ctx.print(
          `${snap.id} (${formatHealth(snap)}) — ${snap.label}`,
        );
        const stdout = snap.recentStdout.slice(-n);
        const stderr = snap.recentStderr.slice(-n);
        if (stdout.length > 0) {
          ctx.print('  [stdout]');
          for (const line of stdout) ctx.print(`    ${line}`);
        }
        if (stderr.length > 0) {
          ctx.print('  [stderr]');
          for (const line of stderr) ctx.print(`    ${line}`);
        }
        if (stdout.length === 0 && stderr.length === 0) {
          ctx.print('  (no output captured yet)');
        }
        return;
      }

      if (head === 'stop') {
        const id = rest.trim();
        if (id.length === 0) {
          ctx.print('Usage: /watch stop <id>');
          return;
        }
        const snap = monitor.get(id);
        if (snap === null) {
          ctx.print(`Unknown watch id: ${id}`);
          return;
        }
        const sent = await monitor.unwatch(id);
        if (sent) {
          ctx.print(`Sent SIGTERM to ${id} (will SIGKILL after 3s if needed).`);
        } else {
          ctx.print(`Process ${id} was not alive; nothing to stop.`);
        }
        return;
      }

      // Anything else is treated as a verbatim shell command. The user
      // can pass `tail` / `list` / `stop` as command names via
      // `/watch -- list` for completeness, but the common case is just
      // `/watch bun test --watch`.
      let cmdText = trimmed;
      if (cmdText.startsWith('-- ')) cmdText = cmdText.slice(3).trim();
      try {
        const { id } = monitor.watch({
          command: cmdText,
          cwd: deps.projectRoot,
          label: cmdText,
        });
        ctx.print(`Watching ${id}: ${cmdText}`);
        ctx.print(
          `Use \`/watch list\`, \`/watch tail ${id}\`, or \`/watch stop ${id}\`.`,
        );
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        ctx.print(`Failed to start watch: ${msg}`);
      }
    },
  };
}
