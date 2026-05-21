/**
 * `localcode daemon` — long-running process that fires persistent crons
 * even when the TUI is not open.
 *
 * Wire-up:
 *   - Load `~/.localcode/crons.json` via `PersistentScheduler`.
 *   - On fire, append a JSON line to `~/.localcode/daemon.log` with the
 *     entry id, prompt preview, and projected project root. Daemon mode
 *     v1 does NOT run an LLM session itself — firing a real chat turn
 *     requires inter-process coordination with the TUI / web runtime
 *     that's out of scope here. Users get an observable "this fired"
 *     trail they can act on later.
 *   - Watch the store file with `fs.watch` so external edits (from a
 *     running TUI's `/cron add`) re-arm the schedule promptly.
 *   - Handle `SIGINT` / `SIGTERM` / `SIGHUP` to stop cleanly.
 *
 * Subcommands:
 *   localcode daemon            run in the foreground (default)
 *   localcode daemon --help     print this help and exit 0
 *
 * v1 explicitly does NOT install itself as a systemd / launchd service
 * — the user is responsible for backgrounding the process. The CLI
 * binary does not auto-launch the daemon under any code path.
 */

import { promises as fs, watch, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PersistentScheduler,
  type PersistentCronDispatchContext,
} from '@/scheduling';
import { defaultCronStorePath } from '@/scheduling';

export interface DaemonOptions {
  /** Override the store path (tests). */
  storePath?: string;
  /** Override the log path (tests). */
  logPath?: string;
  /** Inject a dispatch handler (tests). */
  dispatch?: (ctx: PersistentCronDispatchContext) => Promise<void> | void;
  /** Inject a stop signal (tests) — when resolves, the daemon exits. */
  stopSignal?: Promise<void>;
  /** When true, never install signal handlers. Default false. */
  noSignalHandlers?: boolean;
  /** stdout writer (tests). */
  stdout?: (s: string) => void;
  /** stderr writer (tests). */
  stderr?: (s: string) => void;
}

const HELP_TEXT = `\
localcode daemon — persistent cron runner.

Loads ~/.localcode/crons.json, schedules each enabled entry, and
records fires to ~/.localcode/daemon.log. Run in the foreground;
the binary does not auto-launch this and does not install as a system
service.

Usage:
  localcode daemon              run the daemon
  localcode daemon --help, -h   show this help and exit
`;

function defaultLogPath(): string {
  return path.join(os.homedir(), '.localcode', 'daemon.log');
}

async function appendLogLine(logPath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${line}\n`, 'utf8');
}

function nowIso(): string {
  try {
    return new Date().toISOString();
  } catch {
    return String(Date.now());
  }
}

/**
 * Run the daemon. Returns the desired process exit code. Suitable for
 * being awaited from `cli.tsx` via `process.exit(await runDaemon(...))`.
 */
export async function runDaemon(args: readonly string[]): Promise<number> {
  const stdout = (s: string): void => {
    process.stdout.write(s);
  };
  const stderr = (s: string): void => {
    process.stderr.write(s);
  };
  if (args.includes('--help') || args.includes('-h')) {
    stdout(`${HELP_TEXT}\n`);
    return 0;
  }
  return runDaemonWithOptions({ stdout, stderr });
}

/**
 * Lower-level entry — tests call this with injected hooks. Default
 * implementation is the one wired by `runDaemon`.
 */
export async function runDaemonWithOptions(opts: DaemonOptions = {}): Promise<number> {
  const storePath = opts.storePath ?? defaultCronStorePath();
  const logPath = opts.logPath ?? defaultLogPath();
  const stdout = opts.stdout ?? ((s: string): void => {
    process.stdout.write(s);
  });
  const stderr = opts.stderr ?? ((s: string): void => {
    process.stderr.write(s);
  });

  stdout(`localcode daemon: store=${storePath} log=${logPath}\n`);
  await appendLogLine(
    logPath,
    JSON.stringify({ event: 'daemon_start', ts: nowIso(), storePath }),
  );

  const dispatch =
    opts.dispatch ??
    (async (ctx: PersistentCronDispatchContext): Promise<void> => {
      const line = JSON.stringify({
        event: 'cron_fire',
        ts: nowIso(),
        id: ctx.entry.id,
        cronSpec: ctx.entry.cronSpec,
        prompt: ctx.entry.prompt,
        model: ctx.entry.model,
        projectRoot: ctx.entry.projectRoot,
        firedAt: ctx.firedAt,
      });
      try {
        await appendLogLine(logPath, line);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        stderr(`localcode daemon: log append failed: ${msg}\n`);
      }
    });

  const scheduler = new PersistentScheduler({
    filePath: storePath,
    dispatch,
    logger: {
      warn: (msg): void => {
        stderr(`localcode daemon: ${msg}\n`);
      },
    },
  });

  try {
    await scheduler.start();
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    stderr(`localcode daemon: failed to start scheduler: ${msg}\n`);
    return 1;
  }

  // Re-arm the schedule when the store file changes (e.g. TUI /cron
  // add). fs.watch is best-effort across platforms; failures are
  // swallowed because the daemon still works without it (it just won't
  // pick up external edits until the next fire).
  let watcher: FSWatcher | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    watcher = watch(path.dirname(storePath), (_event, filename) => {
      if (filename !== path.basename(storePath)) return;
      // Debounce — multiple events fire for a single atomic rename.
      if (watchTimer !== null) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        void scheduler.refresh().catch(() => {
          // best-effort; refresh logs internally
        });
      }, 250);
    });
  } catch {
    // Watch optional — continue without it.
  }

  const stopPromise = new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      stdout(`localcode daemon: stopping (${signal})\n`);
      void appendLogLine(
        logPath,
        JSON.stringify({ event: 'daemon_stop', ts: nowIso(), signal }),
      ).catch(() => undefined);
      resolve();
    };
    if (opts.noSignalHandlers !== true) {
      process.once('SIGINT', () => stop('SIGINT'));
      process.once('SIGTERM', () => stop('SIGTERM'));
      process.once('SIGHUP', () => stop('SIGHUP'));
    }
    if (opts.stopSignal !== undefined) {
      void opts.stopSignal.then(() => stop('test-stop'));
    }
  });

  await stopPromise;
  scheduler.stop();
  if (watcher !== null) {
    try {
      watcher.close();
    } catch {
      // best-effort
    }
  }
  if (watchTimer !== null) clearTimeout(watchTimer);
  return 0;
}
