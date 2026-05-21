#!/usr/bin/env bun
/**
 * LocalCode CLI entry point.
 *
 * Parses command-line arguments, verifies the runtime environment, and
 * mounts the root <App> component via ink.
 *
 * Flags:
 *   [projectRoot]                 Positional. Defaults to process.cwd().
 *   --dangerously-allow-all       Skip approval prompts for destructive tools.
 *   --resume <sessionId>          Resume an existing session by id (or prefix).
 *   --model <name>                Override the active model for this run.
 *   --reconfigure                 Force onboarding even if a config exists.
 *   --help, -h                    Show usage and exit.
 *   --version, -v                 Print version and exit.
 *
 * R2: on clean unmount (Ctrl+C confirmed / /exit / natural exit) we print
 * a resume-hint to stdout so the user can pick the session back up later.
 */

import { resolve } from 'node:path';
import type { CliArgs, PermissionProfile } from '@/types/global';
import { PermissionProfileSchema } from '@/config/types';

interface ExtendedCliArgs extends CliArgs {
  readonly reconfigure: boolean;
  /**
   * R8 (Agent 8) — when true, skip the startup model-list refresh in
   * BOTH the cli pre-mount path and the in-mount `useEffect` in App.
   * Default false (refresh enabled). Set via `--no-refresh-models`.
   */
  readonly noRefreshModels: boolean;
  /**
   * `--web` flag (Agent A / web mode). When true the CLI skips the ink
   * TUI entirely and instead boots the local web server via
   * `startWebApp`.
   */
  readonly web: boolean;
  /** Bind host for `--web`. Default `127.0.0.1`. */
  readonly webHost: string;
  /** First port to try for `--web`. Default `7777`. */
  readonly webPort: number;
  /** When true, suppress the auto-`open` of the URL after boot. */
  readonly noOpen: boolean;
  /**
   * Optional permission-profile override for this run. `null` means
   * "use whatever is persisted in `~/.localcode/config.toml`" — the
   * usual case.
   *
   * `--dangerously-allow-all` legacy flag also maps onto this field
   * (resolving to `'dontAsk'`) — see `parseArgs` below. When BOTH are
   * supplied, `--profile` wins. A deprecation note is queued for the
   * chat log when the legacy flag is used.
   */
  readonly profileOverride: PermissionProfile | null;
  /**
   * True iff the legacy `--dangerously-allow-all` flag was supplied
   * on the command line. The TUI surfaces a deprecation note in the
   * chat log on first paint so users migrate to `--profile dontAsk`.
   */
  readonly dangerouslyAllowAllDeprecationNotice: boolean;
}

const DEFAULT_WEB_HOST = '127.0.0.1';
const DEFAULT_WEB_PORT = 7777;

// Keep in sync with package.json `version` field. CI test
// `tests/cli/version-sync.test.ts` (TODO) will guard the drift.
const PKG_VERSION = '0.19.0';

/**
 * R8 (Agent 8) — pre-mount model refresh budget. The cli does a fast,
 * silent `getModels()` call before mounting ink so the chat-screen
 * dropdown / `model.available` is correct from the very first render.
 * Anything slower than this gets abandoned and the in-mount useEffect
 * in `App` retries with user-visible logging.
 */
const PRE_MOUNT_REFRESH_TIMEOUT_MS = 3000;

/** First N chars of a session id the resume banner should show. */
const RESUME_ID_PREFIX_LEN = 12;

const HELP_TEXT = `\
localcode — a local Claude-Code-style AI coding assistant (Ollama / LM Studio)

Usage:
  localcode [projectRoot] [flags]

Positional:
  projectRoot                 Path to the project to work on.
                              Defaults to the current working directory.

Flags:
  --profile <name>            Set the active permission profile for this run.
                              One of: default, acceptEdits, plan, dontAsk,
                              bypassPermissions. Overrides the persisted
                              config for this session only.
  --dangerously-allow-all     DEPRECATED. Equivalent to --profile dontAsk.
                              Skip approval for destructive tools. Use with care.
  --resume <sessionId>        Resume a session. Accepts a full UUID or a
                              sufficiently-unique prefix (see /resume).
  --model <name>              Override the active model for this run
                              (does not modify the persisted config).
  --reconfigure               Re-run the onboarding flow, overwriting config.
  --no-refresh-models         Skip the startup model-list refresh
                              (default: refresh against the configured
                              backend so model.available stays in sync).
  --web                       Launch the browser-based UI instead of the
                              terminal interface. Boots a local server
                              (default 127.0.0.1:7777) and opens the URL
                              in your default browser.
  --web-host <host>           Bind host for --web. Default 127.0.0.1.
                              Pass 0.0.0.0 to expose on the LAN (off by
                              default for safety).
  --web-port <port>           First port to try for --web. Default 7777.
                              Subsequent ports are probed if busy.
  --no-open                   Do not auto-open the browser when --web
                              starts. The URL is still printed to stdout.
  --help, -h                  Show this help and exit.
  --version, -v               Print version and exit.

Subcommands:
  plugin <action>             Manage plugins (install / uninstall / list /
                              enable / disable). Run \`localcode plugin --help\`
                              for the full subcommand reference.

Examples:
  localcode                   # open the current directory
  localcode ~/src/my-project  # open a specific project
  localcode --resume ab12cd34 # resume a session by id prefix
  localcode --model qwen2.5-coder:32b
  localcode plugin list
`;

function parseArgs(argv: readonly string[]): ExtendedCliArgs | 'help' | 'version' {
  // argv[0] = bun runtime, argv[1] = script path. Flags/positional start at 2.
  const args = argv.slice(2);

  let projectRoot: string | null = null;
  let dangerouslyAllowAll = false;
  let resumeSessionId: string | null = null;
  let modelOverride: string | null = null;
  let reconfigure = false;
  let noRefreshModels = false;
  let web = false;
  let webHost: string = DEFAULT_WEB_HOST;
  let webPort: number = DEFAULT_WEB_PORT;
  let noOpen = false;
  let profileOverride: PermissionProfile | null = null;
  let sawDangerouslyAllowAll = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;

    if (token === '--help' || token === '-h') return 'help';
    if (token === '--version' || token === '-v') return 'version';

    if (token === '--dangerously-allow-all') {
      dangerouslyAllowAll = true;
      sawDangerouslyAllowAll = true;
      // Legacy flag → maps onto the `dontAsk` profile unless the user
      // also supplied `--profile`, which wins. The Boolean
      // `dangerouslyAllowAll` field is kept set so existing test
      // fixtures that pass it through to `<App>` continue to work.
      if (profileOverride === null) {
        profileOverride = 'dontAsk';
      }
      continue;
    }

    if (token === '--profile') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('Flag --profile requires a profile name argument');
      }
      const parsed = PermissionProfileSchema.safeParse(next);
      if (!parsed.success) {
        throw new Error(
          `Flag --profile expects one of: default, acceptEdits, plan, dontAsk, bypassPermissions; got "${next}"`,
        );
      }
      profileOverride = parsed.data;
      i += 1;
      continue;
    }

    if (token === '--reconfigure') {
      reconfigure = true;
      continue;
    }

    if (token === '--no-refresh-models') {
      noRefreshModels = true;
      continue;
    }

    if (token === '--web') {
      web = true;
      continue;
    }

    if (token === '--no-open') {
      noOpen = true;
      continue;
    }

    if (token === '--web-host') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('Flag --web-host requires a hostname argument');
      }
      webHost = next;
      i += 1;
      continue;
    }

    if (token === '--web-port') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('Flag --web-port requires a port number argument');
      }
      const parsedPort = Number.parseInt(next, 10);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error(
          `Flag --web-port expects an integer in [1, 65535]; got "${next}"`,
        );
      }
      webPort = parsedPort;
      i += 1;
      continue;
    }

    if (token === '--resume') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('Flag --resume requires a session id argument');
      }
      resumeSessionId = next;
      i += 1;
      continue;
    }

    if (token === '--model') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('Flag --model requires a model name argument');
      }
      modelOverride = next;
      i += 1;
      continue;
    }

    if (token.startsWith('--') || token.startsWith('-')) {
      throw new Error(`Unknown flag: ${token}`);
    }

    // First positional argument is the project root.
    if (projectRoot === null) {
      projectRoot = token;
      continue;
    }

    throw new Error(`Unexpected positional argument: ${token}`);
  }

  const resolvedRoot =
    projectRoot === null ? process.cwd() : resolve(process.cwd(), projectRoot);

  return {
    projectRoot: resolvedRoot,
    dangerouslyAllowAll,
    resumeSessionId,
    modelOverride,
    reconfigure,
    noRefreshModels,
    web,
    webHost,
    webPort,
    noOpen,
    profileOverride,
    dangerouslyAllowAllDeprecationNotice: sawDangerouslyAllowAll,
  };
}

function printError(message: string): void {
  process.stderr.write(`localcode: ${message}\n`);
}

function printOut(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Print the resume banner AFTER ink has unmounted so the TUI frame
 * doesn't eat the text. First N chars of the session id are enough to
 * type — /resume accepts any unambiguous prefix. We use plain stdout
 * (no chalk styling) so the banner is readable on any terminal.
 */
function printResumeBanner(sessionId: string | null): void {
  if (sessionId === null || sessionId.length === 0) return;
  const prefix = sessionId.slice(0, RESUME_ID_PREFIX_LEN);
  process.stdout.write('\n');
  process.stdout.write('Session saved. To resume:\n');
  process.stdout.write(`  localcode --resume ${prefix}\n`);
  if (prefix !== sessionId) {
    process.stdout.write('\n');
    process.stdout.write(`(Or pass --resume ${sessionId} for a specific session.)\n`);
  }
}

/**
 * R8 (Agent 8) — pre-mount silent model refresh.
 *
 * Loaded lazily so a `--help` / `--version` invocation never pulls in
 * the LLM adapter. Reads the persisted config, fires a single
 * `getModels()` call, and writes the result back via
 * `ConfigManager.update`:
 *   - If the call succeeds and the previously-current model is still
 *     present, only `model.available` is rewritten.
 *   - If the previously-current model has vanished from the new list,
 *     `model.current` falls back to the first available entry. The
 *     in-mount `useEffect` in `App` will surface a chat-log notice
 *     about the substitution; we do NOT print to stdout here because
 *     the resulting line would land ABOVE the ink frame and look like
 *     leaked debug output.
 *   - If the call fails, times out, or returns zero models, the
 *     existing config is left untouched so the in-mount retry can
 *     handle it transparently.
 *
 * Bounded by `PRE_MOUNT_REFRESH_TIMEOUT_MS` so a stale backend can't
 * stall startup. Caller (`main`) wraps this in `.catch(() => {})` —
 * but we ALSO defensively swallow internally so the caller's catch
 * never has to fire.
 */
async function preMountModelRefresh(
  ConfigManagerCls: typeof import('@/config/config-manager').ConfigManager,
): Promise<void> {
  let manager: import('@/config/config-manager').ConfigManager;
  let cfg: import('@/config/types').Config;
  try {
    manager = new ConfigManagerCls();
    cfg = manager.read();
  } catch {
    return; // no usable config → let the App handle it
  }

  let adapter: import('@/llm/adapter').LLMAdapter;
  try {
    const { LLMAdapter } = await import('@/llm/adapter');
    adapter = new LLMAdapter({
      baseUrl: cfg.backend.baseUrl,
      model: cfg.model.current,
      backend: cfg.backend.type,
    });
  } catch {
    return;
  }

  let models: readonly string[] = [];
  try {
    const timeoutPromise = new Promise<readonly string[]>((_, reject) => {
      setTimeout(
        () => reject(new Error('pre-mount refresh timed out')),
        PRE_MOUNT_REFRESH_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([adapter.getModels(), timeoutPromise]);
    models = result;
  } catch {
    return;
  }

  if (models.length === 0) return;

  const currentInList = models.includes(cfg.model.current);
  const fallback = models[0];
  const nextCurrent =
    currentInList || fallback === undefined ? cfg.model.current : fallback;

  try {
    manager.update({
      model: {
        available: [...models],
        current: nextCurrent,
      },
    });
  } catch {
    // Swallow — config write failures are non-fatal here.
  }
}

/**
 * Settings-driven `SessionStart` hooks. Loaded lazily so a `--help`
 * invocation never pulls in the hook engine. Reads `config.hooks`,
 * filters for the `SessionStart` trigger, and runs every match in
 * parallel via `HookEngine.run()`.
 *
 * Behaviour:
 *   - Non-blocking by design at this trigger — even hooks declared
 *     `blocking = true` cannot abort startup. `engine.run()` still
 *     reports the blocked flag in its outcome, but we ignore it here.
 *   - Errors are swallowed (logged to stderr via the engine logger)
 *     so a broken hook never breaks the CLI.
 */
async function fireSessionStartHooks(
  ConfigManagerCls: typeof import('@/config/config-manager').ConfigManager,
  projectRoot: string,
): Promise<void> {
  let cfg: import('@/config/types').Config;
  try {
    const manager = new ConfigManagerCls();
    cfg = manager.read();
  } catch {
    return;
  }
  const hooks = cfg.hooks ?? [];
  if (hooks.length === 0) return;
  try {
    const { HookEngine } = await import('@/hooks');
    const engine = new HookEngine({
      hooks,
      logger: {
        warn: (m): void => {
          process.stderr.write(`localcode: hook warning: ${m}\n`);
        },
      },
    });
    if (!engine.hasHooksFor('SessionStart')) return;
    await engine.run({
      trigger: 'SessionStart',
      projectRoot,
    });
  } catch {
    // Best-effort; never fail startup on hooks.
  }
}

function installGlobalErrorHandlers(): void {
  process.on('uncaughtException', (err: Error) => {
    printError(`Uncaught error: ${err.message}`);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    printError(`Unhandled rejection: ${msg}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  installGlobalErrorHandlers();

  // PLUGIN-SUBCOMMAND-SECTION — intercept `localcode plugin ...` BEFORE
  // running the main flag parser. Plugin subcommands are pure stdout
  // tools (no ink) so they finish + exit deterministically without
  // touching the TUI bootstrap path. Anything else falls through to
  // the normal flow.
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'plugin') {
    const { runPluginCli } = await import('@/cli/plugin-cli');
    const exitCode = await runPluginCli(rawArgs.slice(1));
    process.exit(exitCode);
  }

  // DAEMON-SUBCOMMAND-SECTION — opt-in cross-session cron daemon.
  // `localcode daemon` loads `~/.localcode/crons.json`, schedules each
  // enabled entry, fires them, and logs to `~/.localcode/daemon.log`.
  // Intentionally NOT auto-started by any other code path — users must
  // invoke this manually (typically `localcode daemon &` or via a
  // launchd / systemd unit). The daemon does not host an LLM session
  // itself; on fire it appends a log entry the user (or an in-session
  // /cron list) can inspect later. See src/scheduling/persistent-*.
  if (rawArgs[0] === 'daemon') {
    const { runDaemon } = await import('@/cli/daemon');
    const exitCode = await runDaemon(rawArgs.slice(1));
    process.exit(exitCode);
  }

  let parsed: ExtendedCliArgs | 'help' | 'version';
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(msg);
    printError('Run `localcode --help` for usage.');
    process.exit(1);
  }

  if (parsed === 'help') {
    printOut(HELP_TEXT);
    process.exit(0);
  }

  if (parsed === 'version') {
    printOut(`localcode ${PKG_VERSION}`);
    process.exit(0);
  }

  // ── --web branch ─────────────────────────────────────────────────────
  // When `--web` is set, skip ink entirely. The web server is the main
  // event loop; we keep the process alive on the unresolved promise of
  // a SIGINT/SIGTERM/SIGHUP handler that calls `webApp.stop()`.
  if (parsed.web) {
    const { startWebApp } = await import('@/web');
    let webApp;
    try {
      webApp = await startWebApp({
        projectRoot: parsed.projectRoot,
        host: parsed.webHost,
        port: parsed.webPort,
        openInBrowser: !parsed.noOpen,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      printError(`--web failed to start: ${msg}`);
      process.exit(1);
    }

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      process.stdout.write(`\nlocalcode web: stopping (${signal})…\n`);
      try {
        // B3 — kill any still-running background `run_command` tasks so
        // the CLI does not leak children on shutdown. Lazy-import keeps
        // the cli.tsx top-level import graph stable.
        const { getProcessBackgroundTaskRegistry } = await import('@/tools');
        await getProcessBackgroundTaskRegistry().dispose();
      } catch {
        /* swallow — best-effort cleanup */
      }
      // PROCESS-MONITOR-WIRE-SECTION — kill any still-running children
      // registered via /watch. Lazy-import mirrors the pattern above
      // so the top-level CLI import graph stays minimal.
      try {
        const { getProcessMonitor } = await import('@/process-monitor');
        await getProcessMonitor().dispose();
      } catch {
        /* swallow — best-effort cleanup */
      }
      // PROCESS-MONITOR-WIRE-SECTION-END
      try {
        await webApp.stop();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        printError(`Shutdown error: ${msg}`);
      }
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGHUP', () => void shutdown('SIGHUP'));

    // Keep the event loop alive forever; signals do the actual exit.
    await new Promise<never>(() => {});
    return;
  }

  // Lazy-load ink + app ONLY after we've handled --help / --version so a
  // simple `--help` invocation never pulls in the full TUI runtime (and
  // therefore never risks react-devtools-core side-effects in edge cases).
  const [{ render }, React, AppMod, ConfigManagerMod] = await Promise.all([
    import('ink'),
    import('react'),
    import('@/app'),
    import('@/config/config-manager'),
  ]);

  // Determine whether a config already exists. A missing config → onboarding.
  let configExists = false;
  try {
    const probe = new ConfigManagerMod.ConfigManager();
    configExists = probe.exists();
  } catch {
    configExists = false;
  }

  const startScreen: 'onboarding' | 'chat' =
    !configExists || parsed.reconfigure ? 'onboarding' : 'chat';

  // R8 (Agent 8) — pre-mount silent model refresh. Only when we're
  // heading STRAIGHT into the chat screen (config exists, not
  // reconfiguring, refresh not skipped). Bounded by a 3s timeout so a
  // stale/unreachable backend never blocks startup. Failures are
  // swallowed here because the in-mount `useEffect` in `App` retries
  // the same probe with user-visible logging.
  if (startScreen === 'chat' && !parsed.noRefreshModels) {
    await preMountModelRefresh(ConfigManagerMod.ConfigManager).catch(() => {
      // intentional silent fallthrough
    });
  }

  // Settings-driven SessionStart hooks. Fire-and-forget — these run
  // ONCE per CLI boot (after config load, before the UI mounts) and
  // we never block startup on a hook failure. Hooks that throw or
  // exit non-zero are logged via the engine's logger; we do not
  // surface a fatal error to the user.
  //
  // TODO(web): wire SessionStart at the web server boot too — that
  // entry point lives in `src/web/index.ts` and is owned by a parallel
  // agent. We only touch the TUI/CLI path here.
  if (configExists && !parsed.reconfigure) {
    await fireSessionStartHooks(
      ConfigManagerMod.ConfigManager,
      parsed.projectRoot,
    ).catch(() => {
      // intentional silent fallthrough — non-blocking
    });
  }

  // Last known session id so the banner survives both process.exit and
  // React unmount paths. Updated via the onSessionExit callback from App.
  let lastSessionId: string | null = null;

  try {
    // R7 (FIX #8) — disable ink's built-in Ctrl+C handler so App owns
    // the exit flow. Without this, ink intercepts Ctrl+C in the raw-mode
    // input stream BEFORE our `useInput` handler runs and unmounts
    // immediately, which means `onSessionExit` never fires and
    // `lastSessionId` stays null → no banner.
    const { waitUntilExit } = render(
      React.createElement(AppMod.default, {
        projectRoot: parsed.projectRoot,
        dangerouslyAllowAll: parsed.dangerouslyAllowAll,
        resumeSessionId: parsed.resumeSessionId,
        modelOverride: parsed.modelOverride,
        startScreen,
        noRefreshModels: parsed.noRefreshModels,
        // Permission profile override + deprecation notice are threaded
        // through as props so App can persist the override into config
        // on first paint and surface the `--dangerously-allow-all`
        // deprecation as the first chat-log line (NOT to stdout, which
        // would land above the ink frame).
        profileOverride: parsed.profileOverride,
        dangerouslyAllowAllDeprecationNotice:
          parsed.dangerouslyAllowAllDeprecationNotice,
        onSessionExit: (sid: string | null) => {
          if (sid !== null && sid.length > 0) lastSessionId = sid;
        },
      }),
      { exitOnCtrlC: false },
    );

    await waitUntilExit();
    // Print the resume banner AFTER ink fully unmounts so the TUI frame
    // doesn't swallow the text.
    printResumeBanner(lastSessionId);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`Startup failed: ${msg}`);
    process.exit(1);
  }
}

void main();
