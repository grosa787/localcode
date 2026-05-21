/**
 * Types for the LocalCode auto-updater.
 *
 * The updater module compares the running binary's version (from
 * `PKG_VERSION` in `src/cli.tsx`) against the GitHub Releases API and
 * surfaces non-blocking notices to the TUI + web layers when a newer
 * release is available. Downloading happens in the background; applying
 * is atomic (backup + tmp → rename) and is gated either on next startup
 * or on the `/update apply` CLI subcommand.
 *
 * Every external boundary returns `null` on failure rather than
 * throwing — the updater must never block startup or crash the
 * process, and the caller decides whether to surface or swallow.
 */

import { z } from 'zod';

/**
 * Slim shape of a GitHub Release we care about. Mirrors a subset of the
 * payload returned by `GET /repos/:owner/:repo/releases/latest`. We
 * deliberately keep only the fields needed to download + verify the
 * tarball so the surface area for a malicious upstream is small.
 */
export interface ReleaseAssetInfo {
  /** Filename, e.g. `localcode-darwin-arm64.tar.gz`. */
  readonly name: string;
  /** Direct download URL. */
  readonly downloadUrl: string;
  /** Size in bytes (from the API). */
  readonly sizeBytes: number;
  /** Optional digest (e.g. `sha256:abc123…`). When present we verify. */
  readonly digest: string | null;
}

export interface ReleaseInfo {
  /** Semver string with the leading `v` stripped (e.g. `0.20.0`). */
  readonly version: string;
  /** Raw tag name as published (e.g. `v0.20.0`). */
  readonly tagName: string;
  /** GitHub release page URL. Surfaced in UI links. */
  readonly htmlUrl: string;
  /** Release name, falls back to `tagName` when null. */
  readonly name: string;
  /** Markdown body of the release notes (truncated by UI). */
  readonly body: string;
  /** Whether the release is marked pre-release on GitHub. */
  readonly prerelease: boolean;
  /** Published timestamp (epoch ms). */
  readonly publishedAt: number;
  /** Downloadable assets attached to the release. */
  readonly assets: readonly ReleaseAssetInfo[];
  /**
   * Fallback tarball URL produced by GitHub for every release (source
   * archive). Used when no platform-specific asset is found.
   */
  readonly tarballUrl: string;
}

/**
 * One-shot state for the staged update on disk. Persisted to
 * `~/.localcode/updates/pending.json` between launches so the apply-on-
 * restart flow can detect a ready update without re-running the
 * download.
 */
export interface PendingUpdate {
  /** Target semver (without leading `v`). */
  readonly version: string;
  /** Absolute path to the staged binary (typically `cli.js`). */
  readonly stagedBinaryPath: string;
  /** When the download completed (epoch ms). */
  readonly stagedAt: number;
  /**
   * SHA-256 of the staged binary as `sha256:<hex>` when verified.
   * `null` when the release didn't publish a digest and we trusted the
   * download as-is.
   */
  readonly digest: string | null;
  /** The original ReleaseInfo for diagnostics. */
  readonly release: ReleaseInfo;
}

export const PendingUpdateSchema = z.object({
  version: z.string().min(1),
  stagedBinaryPath: z.string().min(1),
  stagedAt: z.number().int().nonnegative(),
  digest: z.string().min(1).nullable(),
  release: z
    .object({
      version: z.string().min(1),
      tagName: z.string().min(1),
      htmlUrl: z.string().min(1),
      name: z.string(),
      body: z.string(),
      prerelease: z.boolean(),
      publishedAt: z.number().int().nonnegative(),
      assets: z
        .array(
          z.object({
            name: z.string().min(1),
            downloadUrl: z.string().min(1),
            sizeBytes: z.number().int().nonnegative(),
            digest: z.string().nullable(),
          }),
        )
        .default([]),
      tarballUrl: z.string().min(1),
    })
    .strict(),
});

/**
 * Disk-side cache shape for the 1h release-check throttle. We persist
 * the latest-release lookup plus the timestamp we made it so a series
 * of process boots inside the cache window does NOT hit GitHub.
 */
export interface ReleaseCheckCache {
  readonly fetchedAt: number;
  readonly release: ReleaseInfo | null;
}

export const ReleaseCheckCacheSchema = z.object({
  fetchedAt: z.number().int().nonnegative(),
  release: z
    .object({
      version: z.string().min(1),
      tagName: z.string().min(1),
      htmlUrl: z.string().min(1),
      name: z.string(),
      body: z.string(),
      prerelease: z.boolean(),
      publishedAt: z.number().int().nonnegative(),
      assets: z
        .array(
          z.object({
            name: z.string().min(1),
            downloadUrl: z.string().min(1),
            sizeBytes: z.number().int().nonnegative(),
            digest: z.string().nullable(),
          }),
        )
        .default([]),
      tarballUrl: z.string().min(1),
    })
    .nullable(),
});

/**
 * Lifecycle events emitted by the singleton. Subscribers in `app.tsx`
 * and `src/web/index.ts` listen for `update-available` /
 * `update-downloaded` and surface chat banners + toasts.
 *
 * `update-available` may fire many times across a long-lived process
 * (one per check) but the singleton deduplicates by version so each
 * version is surfaced only once.
 */
export type UpdateEvent =
  | {
      readonly type: 'update-available';
      readonly currentVersion: string;
      readonly release: ReleaseInfo;
    }
  | {
      readonly type: 'update-downloaded';
      readonly version: string;
      readonly pending: PendingUpdate;
    }
  | {
      readonly type: 'update-error';
      readonly stage: 'check' | 'download' | 'apply';
      readonly message: string;
    };

export type UpdateEventListener = (event: UpdateEvent) => void;

/**
 * Aggregate state surfaced via `getProcessUpdater().getState()`. Used by
 * the `update check` CLI subcommand to render a status line and by tests
 * to assert progression.
 */
export interface UpdateState {
  readonly currentVersion: string;
  readonly latestRelease: ReleaseInfo | null;
  readonly pending: PendingUpdate | null;
  readonly lastCheckedAt: number | null;
  readonly lastError: string | null;
}
