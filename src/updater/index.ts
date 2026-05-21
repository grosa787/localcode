/**
 * Public barrel for the auto-updater module + process-wide singleton.
 *
 * Consumers (TUI / web / CLI subcommand) interact ONLY through
 * `getProcessUpdater()`. The singleton owns the scheduler, dedupes
 * `update-available` notifications across check ticks, and persists the
 * pending-update manifest before emitting `update-downloaded`.
 *
 * Strict design contract: every public method on the singleton swallows
 * its own failures and surfaces them via `update-error` events. The
 * process should never crash because of an updater glitch.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  fetchLatestRelease,
  compareSemver,
  isNewerThan,
} from './github-releases';
import {
  downloadTarball,
  getStagingDir,
  pickDownloadTarget,
} from './downloader';
import {
  applyManifest,
  readPendingManifest,
  writePendingManifest,
} from './applier';
import {
  scheduleBackgroundCheck,
  type SchedulerHandle,
} from './scheduler';
import type {
  ReleaseInfo,
  PendingUpdate,
  UpdateEvent,
  UpdateEventListener,
  UpdateState,
} from './types';

export type {
  ReleaseInfo,
  PendingUpdate,
  UpdateEvent,
  UpdateEventListener,
  UpdateState,
  ReleaseAssetInfo,
} from './types';
export {
  fetchLatestRelease,
  compareSemver,
  isNewerThan,
  stripVersionPrefix,
  getReleaseCheckCachePath,
  CACHE_TTL_MS,
} from './github-releases';
export {
  downloadTarball,
  pickDownloadTarget,
  getStagingDir,
  getPendingManifestPath,
} from './downloader';
export {
  applyStagedUpdate,
  applyManifest,
  readPendingManifest,
  writePendingManifest,
  resolveLiveBinaryPath,
  getUpdatesRoot,
} from './applier';
export { scheduleBackgroundCheck } from './scheduler';

/**
 * Default GitHub repo. Embedded in the binary; can be overridden via
 * `config.updater.repo` (not yet exposed in the public schema — we
 * leave a hook so an enterprise fork can point at its own repo
 * without changing code).
 */
export const DEFAULT_GITHUB_REPO = 'grosa787/localcode';

export interface UpdaterSingletonOptions {
  readonly currentVersion: string;
  readonly repo?: string;
  readonly autoDownload?: boolean;
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
  /** Inject fetch (tests). */
  readonly fetchFn?: typeof globalThis.fetch;
  /** Inject clock (tests). */
  readonly nowFn?: () => number;
  /**
   * Override release-cache path (tests). Production callers omit and
   * the default `~/.localcode/cache/release-check.json` is used.
   */
  readonly cachePath?: string;
  /** When true, every check bypasses the disk cache (tests). */
  readonly skipCache?: boolean;
  /** Inject scheduler timers (tests). */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * In-process singleton implementing the update lifecycle.
 *
 * The constructor is intentionally cheap so the TUI/web boot path can
 * always materialise the object even when the feature is disabled
 * (subscribers / state queries still work; `start()` is a no-op when
 * `autoDownload === false`).
 */
export class Updater {
  private readonly listeners = new Set<UpdateEventListener>();
  private readonly seenAvailableVersions = new Set<string>();
  private readonly opts: UpdaterSingletonOptions;
  private scheduler: ReturnType<typeof scheduleBackgroundCheck> | null = null;
  private latestRelease: ReleaseInfo | null = null;
  private pending: PendingUpdate | null = null;
  private lastCheckedAt: number | null = null;
  private lastError: string | null = null;
  private downloadingVersion: string | null = null;

  constructor(opts: UpdaterSingletonOptions) {
    this.opts = opts;
  }

  /**
   * Arm the background scheduler. Idempotent — calling twice has no
   * additional effect. When `autoDownload === false` the scheduler is
   * still armed (we want to surface a notice even when the user opted
   * out of background downloads).
   */
  start(): void {
    if (this.scheduler !== null) return;
    this.scheduler = scheduleBackgroundCheck({
      ...(this.opts.initialDelayMs !== undefined
        ? { initialDelayMs: this.opts.initialDelayMs }
        : {}),
      ...(this.opts.intervalMs !== undefined
        ? { intervalMs: this.opts.intervalMs }
        : {}),
      ...(this.opts.setTimeoutFn !== undefined
        ? { setTimeoutFn: this.opts.setTimeoutFn }
        : {}),
      ...(this.opts.clearTimeoutFn !== undefined
        ? { clearTimeoutFn: this.opts.clearTimeoutFn }
        : {}),
      onTick: () => this.runCheckTick(),
    });
    this.scheduler.start();
  }

  /** Stop the background scheduler. Safe to call multiple times. */
  stop(): void {
    if (this.scheduler === null) return;
    try {
      this.scheduler.stop();
    } catch {
      /* swallow */
    }
    this.scheduler = null;
  }

  /** Subscribe to lifecycle events. Returns an unsubscribe callback. */
  on(listener: UpdateEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot of the current state. Cheap to call. */
  getState(): UpdateState {
    return {
      currentVersion: this.opts.currentVersion,
      latestRelease: this.latestRelease,
      pending: this.pending,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
    };
  }

  /**
   * Force an immediate check. Resolves once the underlying tick
   * completes — used by `localcode update check` to render the result
   * synchronously.
   */
  async checkNow(): Promise<UpdateState> {
    if (this.scheduler !== null) {
      try {
        await this.scheduler.checkNow();
      } catch {
        /* swallow */
      }
    } else {
      // Singleton not started — run the tick directly.
      await this.runCheckTick();
    }
    return this.getState();
  }

  /**
   * Manually trigger a download for the most recent release (if any).
   * Used by `localcode update download` and by the apply subcommand
   * when the user wants to fetch + apply in one shot.
   */
  async downloadLatest(): Promise<{ ok: boolean; error?: string }> {
    const release = this.latestRelease;
    if (release === null) return { ok: false, error: 'No release info loaded' };
    return this.downloadRelease(release);
  }

  /**
   * Apply the staged update, if any. Returns the apply result.
   */
  async applyPending(): Promise<{ ok: boolean; appliedVersion?: string; error?: string }> {
    const pending = await readPendingManifest();
    if (pending === null) return { ok: false, error: 'No pending update' };
    const res = await applyManifest(pending);
    if (res.ok) {
      this.pending = null;
    } else {
      this.emit({ type: 'update-error', stage: 'apply', message: res.error ?? 'unknown' });
    }
    const out: { ok: boolean; appliedVersion?: string; error?: string } = { ok: res.ok };
    if (res.appliedVersion !== undefined) out.appliedVersion = res.appliedVersion;
    if (res.error !== undefined) out.error = res.error;
    return out;
  }

  /**
   * Run a single check tick: fetch latest → compare → maybe download.
   * Exposed so tests can drive the singleton without running the
   * scheduler.
   */
  async runCheckTick(): Promise<void> {
    const nowFn = this.opts.nowFn ?? ((): number => Date.now());
    const repo = this.opts.repo ?? DEFAULT_GITHUB_REPO;
    let release: ReleaseInfo | null;
    try {
      const fetchOpts: {
        fetchFn?: typeof globalThis.fetch;
        nowFn?: () => number;
        cachePath?: string;
        skipCache?: boolean;
      } = {};
      if (this.opts.fetchFn !== undefined) fetchOpts.fetchFn = this.opts.fetchFn;
      if (this.opts.nowFn !== undefined) fetchOpts.nowFn = this.opts.nowFn;
      if (this.opts.cachePath !== undefined) fetchOpts.cachePath = this.opts.cachePath;
      if (this.opts.skipCache === true) fetchOpts.skipCache = true;
      release = await fetchLatestRelease(repo, fetchOpts);
    } catch (err) {
      release = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'update-error', stage: 'check', message: this.lastError });
    }
    this.lastCheckedAt = nowFn();
    if (release === null) {
      // No newer info; we still try to surface a previously-staged
      // pending manifest so a fresh boot after a crashed download finds
      // its way home.
      const persisted = await readPendingManifest();
      if (persisted !== null) {
        this.pending = persisted;
      }
      return;
    }
    this.latestRelease = release;
    if (!isNewerThan(release.version, this.opts.currentVersion)) {
      return;
    }
    if (this.seenAvailableVersions.has(release.version)) {
      // Already surfaced — keep state but don't re-emit.
    } else {
      this.seenAvailableVersions.add(release.version);
      this.emit({
        type: 'update-available',
        currentVersion: this.opts.currentVersion,
        release,
      });
    }

    if (this.opts.autoDownload !== false) {
      // Best-effort — already-downloaded versions short-circuit.
      const persisted = await readPendingManifest();
      if (persisted !== null && persisted.version === release.version) {
        this.pending = persisted;
        // Re-emit downloaded so newly-attached listeners see the state.
        this.emit({ type: 'update-downloaded', version: persisted.version, pending: persisted });
        return;
      }
      await this.downloadRelease(release);
    }
  }

  /**
   * Internal — download the asset for `release` into the staging dir,
   * write the manifest, and emit `update-downloaded`. Returns
   * `{ ok, error }` so the public `downloadLatest()` can surface
   * failures.
   */
  private async downloadRelease(
    release: ReleaseInfo,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.downloadingVersion === release.version) {
      return { ok: false, error: 'Download already in progress' };
    }
    this.downloadingVersion = release.version;
    try {
      const target = pickDownloadTarget(release);
      const dest = join(getStagingDir(release.version), 'cli.js');
      const dlOpts: { fetchFn?: typeof globalThis.fetch } = {};
      if (this.opts.fetchFn !== undefined) dlOpts.fetchFn = this.opts.fetchFn;
      const dl = await downloadTarball(release, dest, dlOpts);
      if (!dl.ok || dl.path === undefined) {
        this.lastError = dl.error ?? 'unknown';
        this.emit({
          type: 'update-error',
          stage: 'download',
          message: this.lastError,
        });
        return { ok: false, ...(dl.error !== undefined ? { error: dl.error } : {}) };
      }
      const manifest: PendingUpdate = {
        version: release.version,
        stagedBinaryPath: dl.path,
        stagedAt: (this.opts.nowFn ?? ((): number => Date.now()))(),
        digest: dl.digest ?? null,
        release,
      };
      try {
        await writePendingManifest(manifest);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'update-error', stage: 'download', message: msg });
        return { ok: false, error: msg };
      }
      this.pending = manifest;
      void target; // pickDownloadTarget side-effects (logging hook) — keep reference.
      this.emit({ type: 'update-downloaded', version: release.version, pending: manifest });
      return { ok: true };
    } finally {
      this.downloadingVersion = null;
    }
  }

  private emit(event: UpdateEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* swallow */
      }
    }
  }
}

// ---------- Process-wide singleton ----------

let _singleton: Updater | null = null;

/**
 * Initialise the singleton on first call. Subsequent calls return the
 * cached instance; the options after first construction are ignored.
 * Pass `forceNew: true` (test-only) to discard and rebuild.
 */
export function getProcessUpdater(opts?: UpdaterSingletonOptions & { forceNew?: boolean }): Updater {
  if (opts?.forceNew === true) {
    _singleton?.stop();
    _singleton = null;
  }
  if (_singleton === null) {
    if (opts === undefined) {
      throw new Error('getProcessUpdater: first call must include options');
    }
    _singleton = new Updater(opts);
  }
  return _singleton;
}

/**
 * Reset the singleton (test-only).
 */
export function resetProcessUpdater(): void {
  _singleton?.stop();
  _singleton = null;
}

// Re-export the updates root for tests + cli.
export { getUpdatesRoot as _getUpdatesRoot } from './applier';

// Suppress unused-symbol lint for `homedir` import (kept for future use
// when we expand to per-OS install paths).
void homedir;
void compareSemver;
