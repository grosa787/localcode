/**
 * /update — in-session wrapper around the Wave A/B `Updater` singleton.
 *
 * Subcommand surface:
 *
 *   /update                  → check for a newer release + render status.
 *   /update apply            → apply the staged update right now and exit
 *                              so the next launch picks up the new binary.
 *   /update download         → force download even when not yet flagged
 *                              available (still no-op when up-to-date).
 *   /update skip <version>   → persist <version> into the skipped list.
 *
 * The command never blocks the chat loop on a slow network: every call
 * into the updater is wrapped in a 5s timeout. On timeout we print a
 * friendly message and return — the in-process updater state is
 * untouched and the next user-initiated check can try again.
 *
 * The command is dep-injected via a narrow `UpdaterFacade` interface so
 * tests do not need to spin up the full singleton or talk to GitHub.
 * The live `Updater` class from `@/updater` satisfies the facade.
 */

import type { SlashCommand, CommandContext } from '@/types/global';
import type { UpdateState } from '@/updater';

/**
 * Minimal subset of the `Updater` singleton surface that `/update`
 * needs. Each method maps 1:1 to a method on the production class —
 * defined locally so tests can supply lightweight stubs without
 * importing the full updater module graph.
 */
export interface UpdaterFacade {
  getState(): UpdateState;
  checkNow(): Promise<UpdateState>;
  downloadLatest(): Promise<{ ok: boolean; error?: string }>;
  applyPending(): Promise<{ ok: boolean; appliedVersion?: string; error?: string }>;
  skipVersion(version: string): Promise<void>;
}

export interface UpdateCommandDeps {
  /**
   * Thunk returning the live `Updater` (or facade) — `null` when the
   * feature is disabled via config or the wiring effect hasn't booted
   * yet. The thunk pattern matches the rest of the wiring (cmd-compress,
   * cmd-review) so the command always sees the most-recent instance
   * after a hot rebuild.
   */
  getUpdater: () => UpdaterFacade | null;
  /** Trigger ink unmount after a successful `/update apply`. */
  exit: () => void;
  /**
   * Wall-clock timeout for the network-touching subcommands (`check`
   * and `download`). Defaults to 5_000 ms (matches the rest of the
   * codebase's "don't block the chat loop" guidance). Tests can shrink
   * to keep them fast.
   */
  timeoutMs?: number;
  /**
   * Override `setTimeout` (tests). Production callers omit and the
   * default platform timer is used.
   */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

const UPDATE_NAME = 'update';
const UPDATE_DESCRIPTION =
  'Check for a newer LocalCode release and apply a staged update.';
const UPDATE_USAGE =
  '/update | /update apply | /update download | /update skip <version>';

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Build the `/update` SlashCommand from the injected deps. The returned
 * object is referentially stable (callers register it once at boot).
 */
export function createUpdateCommand(deps: UpdateCommandDeps): SlashCommand {
  return {
    name: UPDATE_NAME,
    description: UPDATE_DESCRIPTION,
    usage: UPDATE_USAGE,
    execute: async (args: string, ctx: CommandContext): Promise<void> => {
      const trimmed = args.trim();
      const [sub, ...rest] = trimmed.length === 0 ? [''] : trimmed.split(/\s+/);

      const updater = deps.getUpdater();
      if (updater === null) {
        ctx.print(
          'Auto-update is disabled. Re-enable via `localcode update enable` or set updater.enabled = true.',
        );
        return;
      }

      switch (sub) {
        case '':
          await runCheck(updater, deps, ctx);
          return;
        case 'apply':
          await runApply(updater, deps, ctx);
          return;
        case 'download':
          await runDownload(updater, deps, ctx);
          return;
        case 'skip':
          await runSkip(updater, ctx, rest.join(' '));
          return;
        default:
          ctx.print(`Unknown subcommand: /update ${sub}`);
          ctx.print(`Usage: ${UPDATE_USAGE}`);
          return;
      }
    },
  };
}

// ---------- subcommand runners ----------

async function runCheck(
  updater: UpdaterFacade,
  deps: UpdateCommandDeps,
  ctx: CommandContext,
): Promise<void> {
  const initial = safeState(updater);
  if (initial === null) {
    ctx.print('Could not read updater state.');
    return;
  }

  // If we already have a cached release-check result, skip the network
  // round-trip — the user sees instant feedback. Otherwise run a
  // timed-out check.
  let state: UpdateState | null = initial;
  if (initial.lastCheckedAt === null || initial.latestRelease === null) {
    ctx.print('Checking for updates…');
    state = await withTimeout(updater.checkNow(), deps);
    if (state === null) {
      ctx.print('Update check timed out (network unreachable?). Try again later.');
      return;
    }
  }

  const latest = state.latestRelease;
  if (latest === null) {
    if (state.lastError !== null && state.lastError.length > 0) {
      ctx.print(`Could not check for updates: ${state.lastError}`);
      return;
    }
    ctx.print(`✅ LocalCode v${state.currentVersion} is up-to-date.`);
    return;
  }

  // `latestRelease` may equal current after a successful check.
  if (!isNewer(latest.version, state.currentVersion)) {
    ctx.print(`✅ LocalCode v${state.currentVersion} is up-to-date.`);
    return;
  }

  const pendingMatches =
    state.pending !== null && state.pending.version === latest.version;
  const lines: string[] = [];
  lines.push(`Update available: v${state.currentVersion} → v${latest.version}`);
  if (latest.name.length > 0 && latest.name !== latest.tagName) {
    lines.push(`Release: ${latest.name}`);
  }
  lines.push(`Tag: ${latest.tagName}`);
  if (pendingMatches) {
    lines.push('Status: downloaded — use `/update apply` to install.');
  } else {
    lines.push('Status: not downloaded — use `/update download` to fetch.');
  }
  ctx.print(lines.join('\n'));
}

async function runApply(
  updater: UpdaterFacade,
  deps: UpdateCommandDeps,
  ctx: CommandContext,
): Promise<void> {
  const state = safeState(updater);
  if (state === null) {
    ctx.print('Could not read updater state.');
    return;
  }
  if (state.pending === null) {
    ctx.print('No update staged. Run /update to check.');
    return;
  }
  const targetVersion = state.pending.version;
  ctx.print(`Applying staged update v${targetVersion}…`);
  let result: { ok: boolean; appliedVersion?: string; error?: string };
  try {
    result = await updater.applyPending();
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Apply failed: ${msg}`);
    return;
  }
  if (!result.ok) {
    ctx.print(`Apply failed: ${result.error ?? 'unknown error'}`);
    return;
  }
  const applied = result.appliedVersion ?? targetVersion;
  ctx.print(
    `🔄 Updating to v${applied}. Re-run localcode to pick up the new version.`,
  );
  // Trigger ink unmount so the user is dropped back to the shell.
  try {
    deps.exit();
  } catch {
    /* swallow — if exit throws, the message above is still useful */
  }
}

async function runDownload(
  updater: UpdaterFacade,
  deps: UpdateCommandDeps,
  ctx: CommandContext,
): Promise<void> {
  // Make sure we have release info first — bounded by the same timeout.
  let state = safeState(updater);
  if (state === null) {
    ctx.print('Could not read updater state.');
    return;
  }
  if (state.latestRelease === null) {
    ctx.print('Checking for updates…');
    const checked = await withTimeout(updater.checkNow(), deps);
    if (checked === null) {
      ctx.print('Update check timed out (network unreachable?). Try again later.');
      return;
    }
    state = checked;
  }
  const latest = state.latestRelease;
  if (latest === null) {
    ctx.print('No release info available.');
    return;
  }
  if (!isNewer(latest.version, state.currentVersion)) {
    ctx.print(`✅ LocalCode v${state.currentVersion} is up-to-date.`);
    return;
  }
  ctx.print(`Downloading v${latest.version}…`);
  const dl = await withTimeout(updater.downloadLatest(), deps);
  if (dl === null) {
    ctx.print('Download timed out. Try again later.');
    return;
  }
  if (!dl.ok) {
    ctx.print(`Download failed: ${dl.error ?? 'unknown error'}`);
    return;
  }
  ctx.print(
    `Downloaded v${latest.version}. Use /update apply to install it now.`,
  );
}

async function runSkip(
  updater: UpdaterFacade,
  ctx: CommandContext,
  rawVersion: string,
): Promise<void> {
  const version = rawVersion.trim();
  if (version.length === 0) {
    ctx.print('Usage: /update skip <version>');
    ctx.print('Example: /update skip 0.21.0');
    return;
  }
  try {
    await updater.skipVersion(version);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    ctx.print(`Failed to skip version: ${msg}`);
    return;
  }
  const normalised =
    version.startsWith('v') || version.startsWith('V')
      ? version.slice(1)
      : version;
  ctx.print(`Skipped v${normalised}. Future checks will not surface it.`);
}

// ---------- helpers ----------

function safeState(updater: UpdaterFacade): UpdateState | null {
  try {
    return updater.getState();
  } catch {
    return null;
  }
}

/**
 * Compare two semver-shaped strings (leading `v` allowed). Returns
 * `true` when `candidate` is strictly newer than `current`. Falls back
 * to string compare on malformed input — the GitHub side already
 * validates the tag shape, so this only protects the local arg-parsing
 * path.
 */
function isNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (a === null || b === null) {
    return candidate !== current && candidate > current;
  }
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch > b.patch;
}

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(raw: string): SemverParts | null {
  const stripped = raw.startsWith('v') || raw.startsWith('V') ? raw.slice(1) : raw;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(stripped);
  if (m === null) return null;
  const majorRaw = m[1];
  const minorRaw = m[2];
  const patchRaw = m[3];
  if (majorRaw === undefined || minorRaw === undefined || patchRaw === undefined) {
    return null;
  }
  const major = Number.parseInt(majorRaw, 10);
  const minor = Number.parseInt(minorRaw, 10);
  const patch = Number.parseInt(patchRaw, 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Race a promise against the configured timeout. Returns `null` when
 * the deadline elapses first. Used to keep `/update` snappy even when
 * GitHub is slow.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  deps: UpdateCommandDeps,
): Promise<T | null> {
  const ms = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const setTimeoutFn: (cb: () => void, ms: number) => unknown =
    deps.setTimeoutFn ?? ((cb, t): unknown => setTimeout(cb, t));
  const clearTimeoutFn: (handle: unknown) => void =
    deps.clearTimeoutFn ?? ((handle): void => {
      // Both Bun/Node `clearTimeout` accept the opaque handle returned
      // by their own `setTimeout`. Casting through `unknown` keeps the
      // signature stable across platforms.
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  let handle: unknown = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    handle = setTimeoutFn(() => resolve(null), ms);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    if (handle !== null) {
      try {
        clearTimeoutFn(handle);
      } catch {
        /* swallow */
      }
    }
  }
}
