/**
 * Check #7 — Latest LocalCode version (GitHub Releases).
 *
 * Uses the same `fetchLatestRelease` the updater uses so we hit the same
 * 1h on-disk cache. Suggests `localcode update apply` when behind.
 */

import { compareSemver, fetchLatestRelease, DEFAULT_GITHUB_REPO } from '@/updater';
import type { DoctorCheckEnv, DoctorCheckResult } from './types';

export interface LatestVersionCheckOptions {
  /** Current PKG_VERSION from cli.tsx. */
  readonly currentVersion: string;
  /** Override the repo (tests). Defaults to the bundled DEFAULT_GITHUB_REPO. */
  readonly repo?: string;
}

export async function checkLatestVersion(
  opts: LatestVersionCheckOptions,
  env: DoctorCheckEnv = {},
): Promise<DoctorCheckResult> {
  const startedAt = Date.now();
  const repo = opts.repo ?? DEFAULT_GITHUB_REPO;
  try {
    // Build the options object up-front (the fields on
    // `FetchLatestReleaseOptions` are `readonly`, so assigning after the
    // fact is rejected). Conditionally include `fetchFn` only when the
    // env stub provides one — passing `undefined` would suppress the
    // module's own default binding.
    const fetchOpts: Parameters<typeof fetchLatestRelease>[1] =
      env.fetchFn !== undefined
        ? { skipCache: true, fetchFn: env.fetchFn }
        : { skipCache: true };
    const release = await fetchLatestRelease(repo, fetchOpts);
    const durationMs = Date.now() - startedAt;
    if (release === null) {
      return {
        name: 'Latest version',
        status: 'warn',
        message: 'Could not reach GitHub (offline or upstream error).',
        durationMs,
      };
    }
    const cmp = compareSemver(release.version, opts.currentVersion);
    if (cmp === 1) {
      return {
        name: 'Latest version',
        status: 'warn',
        message: `Update available: v${opts.currentVersion} → v${release.version}. Run \`localcode update apply\`.`,
        durationMs,
      };
    }
    return {
      name: 'Latest version',
      status: 'ok',
      message: `Up to date (v${opts.currentVersion}).`,
      durationMs,
    };
  } catch (cause) {
    return {
      name: 'Latest version',
      status: 'warn',
      message: `Version check failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      durationMs: Date.now() - startedAt,
    };
  }
}
