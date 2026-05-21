/**
 * `localcode update <subcommand>` — argv handlers for the auto-updater
 * sub-CLI. Pure stdout tools (no ink) so each subcommand finishes and
 * exits deterministically.
 *
 * Subcommands:
 *   - check            Check GitHub for a newer release. Prints result.
 *   - apply            Apply the staged update right now (no restart).
 *   - download         Manually trigger a background download.
 *   - status           Print the current updater state (no network).
 *   - disable          Set `updater.enabled = false` in config.toml.
 *   - enable           Set `updater.enabled = true` in config.toml.
 *
 * Tests invoke `runUpdateCli(argv, { writers, currentVersion, ... })`
 * with captured writers + a stub fetch so they assert behaviour without
 * hitting the network or mutating the user's real `~/.localcode/`.
 */

import { ConfigManager } from '@/config/config-manager';

import {
  getProcessUpdater,
  resetProcessUpdater,
  compareSemver,
  fetchLatestRelease,
  applyStagedUpdate,
  readPendingManifest,
  type Updater,
} from '@/updater';

export interface UpdateCliWriters {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface UpdateCliOptions {
  /** Override version string (tests). Defaults to `PKG_VERSION` from cli.tsx. */
  readonly currentVersion?: string;
  /** Override repo (tests). Defaults to the bundled DEFAULT_GITHUB_REPO. */
  readonly repo?: string;
  /** Override fetch (tests). */
  readonly fetchFn?: typeof globalThis.fetch;
  /** Inject writers. Production callers omit; defaults to stdout/stderr. */
  readonly writers?: Partial<UpdateCliWriters>;
  /**
   * When true the singleton is rebuilt (`forceNew`) before use. The
   * production CLI does this on every invocation because each
   * subcommand is a one-shot process, but tests pass `false` when they
   * are driving the same singleton across multiple calls.
   */
  readonly forceNewSingleton?: boolean;
  /**
   * Optional pre-constructed updater (tests). When set, `forceNewSingleton`
   * is ignored.
   */
  readonly injectedUpdater?: Updater;
  /**
   * Override ConfigManager (tests). When omitted, a default ConfigManager
   * is constructed.
   */
  readonly configManager?: ConfigManager;
}

const HELP_TEXT = `localcode update <subcommand>

Subcommands:
  check          Check GitHub for a newer release of LocalCode.
  apply          Apply the most recently downloaded update.
  download       Download the latest release in the background.
  status         Show updater status (no network call).
  enable         Enable auto-update (writes config.toml).
  disable        Disable auto-update (writes config.toml).
  --help, -h     Show this help and exit.
`;

/**
 * Run the `update` sub-CLI with the given argv tail (everything after
 * `localcode update`). Returns a numeric exit code suitable for
 * `process.exit`.
 */
export async function runUpdateCli(
  argv: readonly string[],
  opts: UpdateCliOptions = {},
): Promise<number> {
  const out = opts.writers?.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = opts.writers?.err ?? ((line) => process.stderr.write(`${line}\n`));
  const currentVersion = opts.currentVersion ?? '0.0.0';

  const sub = argv[0] ?? '';
  if (sub === '' || sub === '--help' || sub === '-h' || sub === 'help') {
    out(HELP_TEXT);
    return 0;
  }

  const ensureUpdater = (): Updater => {
    if (opts.injectedUpdater !== undefined) return opts.injectedUpdater;
    const force = opts.forceNewSingleton ?? true;
    const updaterOpts: {
      currentVersion: string;
      forceNew: boolean;
      autoDownload: boolean;
      repo?: string;
      fetchFn?: typeof globalThis.fetch;
    } = {
      currentVersion,
      forceNew: force,
      autoDownload: true,
    };
    if (opts.repo !== undefined) updaterOpts.repo = opts.repo;
    if (opts.fetchFn !== undefined) updaterOpts.fetchFn = opts.fetchFn;
    return getProcessUpdater(updaterOpts);
  };

  try {
    switch (sub) {
      case 'check': {
        const updater = ensureUpdater();
        const state = await updater.checkNow();
        if (state.latestRelease === null) {
          out('No release info available (offline or upstream error).');
          return 1;
        }
        if (compareSemver(state.latestRelease.version, currentVersion) === 1) {
          out(
            `Update available: v${currentVersion} → v${state.latestRelease.version} (${state.latestRelease.tagName})`,
          );
          if (state.pending !== null && state.pending.version === state.latestRelease.version) {
            out(`Downloaded; run \`localcode update apply\` to install.`);
          } else {
            out(`Run \`localcode update download\` to fetch it now.`);
          }
          return 0;
        }
        out(`Already up to date (v${currentVersion}).`);
        return 0;
      }
      case 'download': {
        const updater = ensureUpdater();
        // Make sure we have release info first.
        const state = await updater.checkNow();
        if (state.latestRelease === null) {
          err('Cannot download: no release info loaded.');
          return 1;
        }
        if (compareSemver(state.latestRelease.version, currentVersion) !== 1) {
          out(`Already up to date (v${currentVersion}).`);
          return 0;
        }
        const result = await updater.downloadLatest();
        if (!result.ok) {
          err(`Download failed: ${result.error ?? 'unknown error'}`);
          return 1;
        }
        out(`Downloaded v${state.latestRelease.version}. Run \`localcode update apply\` to install.`);
        return 0;
      }
      case 'apply': {
        const pending = await readPendingManifest();
        if (pending === null) {
          err('No staged update found. Run `localcode update download` first.');
          return 1;
        }
        const result = await applyStagedUpdate();
        if (!result.ok) {
          err(`Apply failed: ${result.error ?? 'unknown error'}`);
          return 1;
        }
        out(`Applied v${result.appliedVersion ?? pending.version}.`);
        return 0;
      }
      case 'status': {
        const pending = await readPendingManifest();
        out(`Current version: v${currentVersion}`);
        if (pending !== null) {
          out(`Staged update: v${pending.version} (ready to apply)`);
        } else {
          out('Staged update: none');
        }
        return 0;
      }
      case 'enable':
      case 'disable': {
        const manager = opts.configManager ?? new ConfigManager();
        try {
          const enabled = sub === 'enable';
          const existing = manager.read().updater ?? {
            enabled: true,
            channel: 'stable' as const,
            checkIntervalHours: 6,
            autoDownload: true,
            checkOnLaunch: true,
            silentBackground: true,
          };
          manager.update({
            updater: {
              enabled,
              channel: existing.channel,
              checkIntervalHours: existing.checkIntervalHours,
              autoDownload: existing.autoDownload,
              checkOnLaunch: existing.checkOnLaunch,
              silentBackground: existing.silentBackground,
            },
          });
          out(`Auto-update ${enabled ? 'enabled' : 'disabled'}.`);
          return 0;
        } catch (e) {
          err(`Failed to update config: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
      }
      default: {
        err(`Unknown subcommand: ${sub}`);
        err('Run `localcode update --help` for usage.');
        return 1;
      }
    }
  } catch (e) {
    err(`Update command failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    if (opts.forceNewSingleton !== false && opts.injectedUpdater === undefined) {
      // Each one-shot invocation tears down the singleton so a follow-
      // up subcommand starts clean.
      try {
        resetProcessUpdater();
      } catch {
        /* swallow */
      }
    }
  }
}

void fetchLatestRelease;
