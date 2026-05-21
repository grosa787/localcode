/**
 * GitHub Releases API client for the auto-updater.
 *
 * `fetchLatestRelease(repo)` calls
 * `https://api.github.com/repos/<repo>/releases/latest`, parses the
 * subset of fields we care about, and returns a `ReleaseInfo` object —
 * or `null` if the network is offline, the response is malformed, the
 * server returned non-2xx, or the request times out (5s budget).
 *
 * Results are cached on disk at `~/.localcode/cache/release-check.json`
 * for `CACHE_TTL_MS` (1 hour) so consecutive process boots within the
 * window never hit GitHub.
 *
 * Every external boundary is failure-tolerant: we never throw, never
 * leak a stack trace to the caller, and never block startup.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { ReleaseCheckCacheSchema, type ReleaseInfo } from './types';

const REQUEST_TIMEOUT_MS = 5_000;
export const CACHE_TTL_MS = 60 * 60 * 1_000; // 1h

/**
 * Subset of the GitHub Releases REST API payload we parse. Fields we
 * don't use are intentionally accepted as `z.unknown()` via `passthrough`
 * so a benign upstream addition cannot break us.
 */
const GhAssetSchema = z
  .object({
    name: z.string(),
    browser_download_url: z.string(),
    size: z.number().int().nonnegative(),
    digest: z.string().optional().nullable(),
  })
  .passthrough();

const GhReleaseSchema = z
  .object({
    tag_name: z.string(),
    name: z.string().optional().nullable(),
    body: z.string().optional().nullable(),
    html_url: z.string(),
    prerelease: z.boolean().optional().default(false),
    published_at: z.string().optional().nullable(),
    tarball_url: z.string(),
    assets: z.array(GhAssetSchema).optional().default([]),
  })
  .passthrough();

/**
 * Strip a leading `v` from a semver-ish tag. Returns the original
 * string when no leading `v` is present so non-`v`-prefixed tags
 * still round-trip cleanly.
 */
export function stripVersionPrefix(tag: string): string {
  if (tag.length > 0 && (tag[0] === 'v' || tag[0] === 'V')) return tag.slice(1);
  return tag;
}

/**
 * Return path to the disk-side release-check cache. Exported so tests
 * can inject a tmp HOME and assert the file location.
 */
export function getReleaseCheckCachePath(): string {
  return join(homedir(), '.localcode', 'cache', 'release-check.json');
}

interface FetchLatestReleaseOptions {
  /**
   * Override the fetch implementation. Defaults to `globalThis.fetch`.
   * Tests inject a stub here so they don't touch the network.
   */
  readonly fetchFn?: typeof globalThis.fetch;
  /** Override the cache file path (tests). */
  readonly cachePath?: string;
  /** Skip cache read + write entirely. Used by `update check --force`. */
  readonly skipCache?: boolean;
  /** Inject a clock for cache TTL testing. */
  readonly nowFn?: () => number;
  /** Inject an AbortController factory (defaults to global). */
  readonly abortControllerCtor?: typeof AbortController;
  /**
   * Timeout override (ms). Used by tests to make timeout assertions
   * deterministic with `setTimeout(0)`.
   */
  readonly timeoutMs?: number;
}

/**
 * Fetch the most recent GitHub release for `repo` (format: `owner/name`).
 * Returns `null` on any failure or when the upstream payload doesn't
 * pass schema validation. Caches the result on disk for 1h.
 */
export async function fetchLatestRelease(
  repo: string,
  opts: FetchLatestReleaseOptions = {},
): Promise<ReleaseInfo | null> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const nowFn = opts.nowFn ?? ((): number => Date.now());
  const cachePath = opts.cachePath ?? getReleaseCheckCachePath();
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const AbortCtor = opts.abortControllerCtor ?? AbortController;

  if (!opts.skipCache) {
    const cached = await readReleaseCache(cachePath, nowFn);
    if (cached !== null) return cached;
  }

  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const ctrl = new AbortCtor();
  const timer = setTimeout(() => {
    try {
      ctrl.abort();
    } catch {
      /* swallow */
    }
  }, timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'localcode-updater',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    await writeReleaseCacheBestEffort(cachePath, { fetchedAt: nowFn(), release: null });
    return null;
  }
  clearTimeout(timer);

  if (!response.ok) {
    await writeReleaseCacheBestEffort(cachePath, { fetchedAt: nowFn(), release: null });
    return null;
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return null;
  }

  const parsed = GhReleaseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;

  const tagName = r.tag_name;
  const version = stripVersionPrefix(tagName);
  if (version.length === 0) return null;

  let publishedAt = 0;
  if (typeof r.published_at === 'string' && r.published_at.length > 0) {
    const ms = Date.parse(r.published_at);
    if (!Number.isNaN(ms)) publishedAt = ms;
  }

  const release: ReleaseInfo = {
    version,
    tagName,
    htmlUrl: r.html_url,
    name: r.name ?? tagName,
    body: r.body ?? '',
    prerelease: r.prerelease ?? false,
    publishedAt,
    tarballUrl: r.tarball_url,
    assets: r.assets.map((a) => ({
      name: a.name,
      downloadUrl: a.browser_download_url,
      sizeBytes: a.size,
      digest: typeof a.digest === 'string' && a.digest.length > 0 ? a.digest : null,
    })),
  };

  await writeReleaseCacheBestEffort(cachePath, { fetchedAt: nowFn(), release });
  return release;
}

async function readReleaseCache(
  cachePath: string,
  nowFn: () => number,
): Promise<ReleaseInfo | null> {
  let raw: string;
  try {
    raw = await readFile(cachePath, 'utf8');
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ReleaseCheckCacheSchema.safeParse(json);
  if (!parsed.success) return null;
  if (nowFn() - parsed.data.fetchedAt > CACHE_TTL_MS) return null;
  return parsed.data.release;
}

async function writeReleaseCacheBestEffort(
  cachePath: string,
  cache: { fetchedAt: number; release: ReleaseInfo | null },
): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(cache), 'utf8');
    await rename(tmp, cachePath);
  } catch {
    /* swallow — cache is best-effort */
  }
}

/**
 * Lightweight semver comparator: `compareSemver(a, b)` returns
 *   -1 when `a < b`,
 *    0 when `a == b`,
 *    1 when `a > b`.
 * Accepts strings with or without a leading `v` and ignores anything
 * after the first dash-separated pre-release segment (treated as lower
 * priority than the matching release version).
 *
 * This is the only sort/compare we need for "is upstream newer than
 * us"; we deliberately do not pull in a full semver dep.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const norm = (s: string): { core: number[]; pre: string | null } => {
    const cleaned = stripVersionPrefix(s.trim());
    const dash = cleaned.indexOf('-');
    const core = dash === -1 ? cleaned : cleaned.slice(0, dash);
    const pre = dash === -1 ? null : cleaned.slice(dash + 1);
    const parts = core.split('.').map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (parts.length < 3) parts.push(0);
    return { core: parts, pre };
  };
  const an = norm(a);
  const bn = norm(b);
  for (let i = 0; i < Math.max(an.core.length, bn.core.length); i += 1) {
    const av = an.core[i] ?? 0;
    const bv = bn.core[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  // Equal core. A pre-release < a release version per semver.
  if (an.pre === null && bn.pre !== null) return 1;
  if (an.pre !== null && bn.pre === null) return -1;
  if (an.pre !== null && bn.pre !== null) {
    if (an.pre < bn.pre) return -1;
    if (an.pre > bn.pre) return 1;
  }
  return 0;
}

/**
 * Returns true iff `latest` is strictly newer than `current`. Convenience
 * wrapper around `compareSemver` used by `app.tsx` / web wiring.
 */
export function isNewerThan(latest: string, current: string): boolean {
  return compareSemver(latest, current) === 1;
}
