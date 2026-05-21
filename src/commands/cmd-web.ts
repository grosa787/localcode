/**
 * /web — boot the local web UI from inside the TUI and load the current
 * session in the browser. The TUI keeps running; both surfaces talk to
 * the same SQLite database (WAL mode + busy_timeout already enabled)
 * so messages, tool calls, and approval state mirror in real time.
 *
 * Subcommands:
 *   /web              boot the server (if not already running) and open
 *                     the browser at the active session
 *   /web stop         kill the spawned server
 *
 * Implementation notes:
 *   - The server boots IN-PROCESS via `startWebApp`. The composition
 *     root in `src/web/index.ts` already idempotently handles port
 *     probing, CSRF generation, and signal teardown.
 *   - The host injects a `launchWeb(sessionId)` callback that owns the
 *     actual lifecycle. The command itself never imports `@/web` so
 *     tests can swap a fake launcher without dragging in Bun.serve.
 */

import type { SlashCommand, CommandContext } from '@/types/global';

export interface LaunchedWeb {
  /** Base URL including the CSRF + session fragment. */
  readonly url: string;
  /** Idempotent stop function. Resolves once the server has fully torn down. */
  readonly stop: () => Promise<void>;
}

export interface WebCommandDeps {
  /**
   * Start (or return the already-running) web server bound to the
   * current TUI's SQLite database, then resolve the URL the browser
   * should open with `#token=…&session=<id>` already embedded. Optional
   * `sessionId` — when supplied the SPA auto-selects that session on
   * bootstrap; when null the SPA opens to its usual empty state.
   *
   * Implementations are responsible for not double-spawning the server
   * on subsequent invocations — return the same handle.
   */
  launchWeb: (sessionId: string | null) => Promise<LaunchedWeb>;
  /**
   * Stop the server (if any). Idempotent — safe to call when nothing
   * is running.
   */
  stopWeb: () => Promise<void>;
  /**
   * Optional opener — defaults to a no-op so tests don't pop a browser.
   * Production wiring routes this to `openBrowser` from `@/web/server/open-browser`.
   */
  openBrowser?: (url: string) => Promise<void>;
}

const NAME = 'web';
const DESCRIPTION = 'Open the current session in the local web UI';
const USAGE = '/web [stop]';

export function createWebCommand(deps: WebCommandDeps): SlashCommand {
  return {
    name: NAME,
    description: DESCRIPTION,
    usage: USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim().toLowerCase();
      if (trimmed === 'stop') {
        try {
          await deps.stopWeb();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.print(`Failed to stop web server: ${msg}`);
          return;
        }
        ctx.print('Web server stopped.');
        return;
      }
      if (trimmed.length > 0 && trimmed !== 'start') {
        ctx.print(`Unknown subcommand: ${trimmed}. Usage: ${USAGE}`);
        return;
      }

      let launched: LaunchedWeb;
      try {
        launched = await deps.launchWeb(ctx.sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.print(`Failed to start web server: ${msg}`);
        return;
      }

      // Strip the fragment so we don't print the CSRF token to the chat
      // log. The browser-open call still uses the full URL (token +
      // session fragment) so auto-resume works.
      const printableUrl = stripFragment(launched.url);
      const noteLines: string[] = [
        `🌐 Web server running at ${printableUrl}`,
        ctx.sessionId !== null
          ? '   Current session opened in the browser. Both sides are live.'
          : '   Open in the browser; no active session yet.',
        '   Run `/web stop` to shut the server down.',
      ];
      for (const line of noteLines) ctx.print(line);

      if (deps.openBrowser !== undefined) {
        try {
          await deps.openBrowser(launched.url);
        } catch {
          // Browser-open is best-effort: the URL was already printed,
          // the user can copy/paste manually if the OS shortcut fails.
        }
      }
    },
  };
}

/**
 * Drop the `#...` fragment from a URL so it can be safely printed into
 * the chat log without leaking the per-boot CSRF token. The token still
 * rides into the user's browser via the open-browser call.
 */
function stripFragment(url: string): string {
  const hashAt = url.indexOf('#');
  return hashAt === -1 ? url : url.slice(0, hashAt);
}
