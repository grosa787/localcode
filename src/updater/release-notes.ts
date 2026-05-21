/**
 * Delta release-notes fetcher for the auto-updater.
 *
 * When the modal surfaces an "Update available" notification we want to
 * show the user every release between the version they're running and
 * the latest one — not just the latest body. This module owns:
 *
 *   - `fetchReleaseNotesBetween(current, latest)` — calls the GitHub
 *     Releases API once per intermediate tag and concatenates the
 *     bodies in descending order (newest first).
 *   - Disk cache at `~/.localcode/cache/release-notes.json` keyed by
 *     `<current>..<latest>` so the same modal opening twice does not
 *     re-fetch.
 *
 * Every external boundary is failure-tolerant — partial fetches are
 * fine; we surface whatever we got plus a hint that the rest could not
 * be loaded. Never throws to the caller.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { compareSemver, stripVersionPrefix } from './github-releases';

/**
 * One concatenated bundle of release notes between two versions
 * (exclusive of `current`, inclusive of `latest`).
 */
export interface DeltaReleaseNotes {
  /** Caller's running version (without `v` prefix). */
  readonly fromVersion: string;
  /** Most recent version (without `v` prefix). */
  readonly toVersion: string;
  /** Markdown body in descending version order (newest at top). */
  readonly notes: string;
  /** Individual segments by version, newest first. */
  readonly segments: readonly DeltaSegment[];
  /** True when GitHub returned fewer versions than expected. */
  readonly partial: boolean;
}

export interface DeltaSegment {
  readonly version: string;
  readonly tagName: string;
  readonly htmlUrl: string;
  readonly body: string;
  readonly publishedAt: number;
}

const REQUEST_TIMEOUT_MS = 5_000;
/** TTL for the delta-notes cache. 24h matches the dismiss window. */
export const NOTES_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
/** How many intermediate releases we fetch. Hard cap to avoid abuse. */
const MAX_RELEASES_PER_FETCH = 30;

const GhAssetSchema = z
  .object({
    name: z.string(),
    browser_download_url: z.string(),
    size: z.number().int().nonnegative(),
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
    draft: z.boolean().optional().default(false),
    assets: z.array(GhAssetSchema).optional().default([]),
  })
  .passthrough();

const GhReleaseListSchema = z.array(GhReleaseSchema);

const CacheEntrySchema = z.object({
  key: z.string(),
  fetchedAt: z.number().int().nonnegative(),
  notes: z.object({
    fromVersion: z.string(),
    toVersion: z.string(),
    notes: z.string(),
    partial: z.boolean(),
    segments: z.array(
      z.object({
        version: z.string(),
        tagName: z.string(),
        htmlUrl: z.string(),
        body: z.string(),
        publishedAt: z.number().int().nonnegative(),
      }),
    ),
  }),
});

const CacheFileSchema = z.object({
  entries: z.array(CacheEntrySchema).default([]),
});

/** Path to the disk-side delta-notes cache. */
export function getReleaseNotesCachePath(): string {
  return join(homedir(), '.localcode', 'cache', 'release-notes.json');
}

export interface FetchDeltaNotesOptions {
  /** Override fetch (tests). */
  readonly fetchFn?: typeof globalThis.fetch;
  /** Override cache path (tests). */
  readonly cachePath?: string;
  /** Inject clock (tests). */
  readonly nowFn?: () => number;
  /** Skip cache read + write entirely. */
  readonly skipCache?: boolean;
  /** Inject an AbortController factory. */
  readonly abortControllerCtor?: typeof AbortController;
  /** Timeout override (ms). */
  readonly timeoutMs?: number;
}

/**
 * Fetch release notes for every release > `current` and <= `latest` from
 * the GitHub Releases API for `repo` (format `owner/name`). Returns a
 * `DeltaReleaseNotes` with the segments concatenated newest-first.
 *
 * When `current` and `latest` resolve to the same version the result has
 * an empty `notes` body and no segments — callers can short-circuit on
 * that.
 *
 * Never throws — on total failure the result has `partial: true` and an
 * empty `notes` body.
 */
export async function fetchReleaseNotesBetween(
  repo: string,
  current: string,
  latest: string,
  opts: FetchDeltaNotesOptions = {},
): Promise<DeltaReleaseNotes> {
  const fromVersion = stripVersionPrefix(current);
  const toVersion = stripVersionPrefix(latest);
  const cmp = compareSemver(fromVersion, toVersion);
  if (cmp >= 0) {
    return {
      fromVersion,
      toVersion,
      notes: '',
      segments: [],
      partial: false,
    };
  }

  const cacheKey = `${fromVersion}..${toVersion}`;
  const cachePath = opts.cachePath ?? getReleaseNotesCachePath();
  const nowFn = opts.nowFn ?? ((): number => Date.now());

  if (!opts.skipCache) {
    const cached = await readNotesCache(cachePath, cacheKey, nowFn);
    if (cached !== null) return cached;
  }

  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const AbortCtor = opts.abortControllerCtor ?? AbortController;
  const ctrl = new AbortCtor();
  const timer = setTimeout(() => {
    try {
      ctrl.abort();
    } catch {
      /* swallow */
    }
  }, timeoutMs);

  const url = `https://api.github.com/repos/${repo}/releases?per_page=${MAX_RELEASES_PER_FETCH}`;
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
    return {
      fromVersion,
      toVersion,
      notes: '',
      segments: [],
      partial: true,
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return {
      fromVersion,
      toVersion,
      notes: '',
      segments: [],
      partial: true,
    };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return {
      fromVersion,
      toVersion,
      notes: '',
      segments: [],
      partial: true,
    };
  }

  const parsed = GhReleaseListSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      fromVersion,
      toVersion,
      notes: '',
      segments: [],
      partial: true,
    };
  }

  const filtered = parsed.data
    .filter((r) => r.draft !== true)
    .map((r) => {
      const tagName = r.tag_name;
      const version = stripVersionPrefix(tagName);
      let publishedAt = 0;
      if (typeof r.published_at === 'string' && r.published_at.length > 0) {
        const ms = Date.parse(r.published_at);
        if (!Number.isNaN(ms)) publishedAt = ms;
      }
      return {
        version,
        tagName,
        htmlUrl: r.html_url,
        body: typeof r.body === 'string' ? r.body : '',
        publishedAt,
      };
    })
    .filter((seg) => seg.version.length > 0)
    .filter(
      (seg) =>
        compareSemver(seg.version, fromVersion) > 0 &&
        compareSemver(seg.version, toVersion) <= 0,
    )
    .sort((a, b) => compareSemver(b.version, a.version));

  // Detect partial result — if the `latest` itself is not present we
  // surface `partial: true` so the UI can hint that the user reopens the
  // modal later for the full body.
  const sawLatest = filtered.some((s) => s.version === toVersion);
  const partial = !sawLatest && filtered.length > 0;

  const notes = filtered.map((seg) => formatSegment(seg)).join('\n\n');
  const result: DeltaReleaseNotes = {
    fromVersion,
    toVersion,
    notes,
    segments: filtered,
    partial: partial || filtered.length === 0,
  };

  if (!opts.skipCache && filtered.length > 0) {
    await writeNotesCacheBestEffort(cachePath, cacheKey, result, nowFn);
  }

  return result;
}

function formatSegment(seg: DeltaSegment): string {
  const header = `## ${seg.tagName}`;
  const link = seg.htmlUrl.length > 0 ? `\n${seg.htmlUrl}\n` : '\n';
  const body = seg.body.trim().length > 0 ? seg.body.trim() : '_No release notes._';
  return `${header}${link}\n${body}`;
}

async function readNotesCache(
  cachePath: string,
  key: string,
  nowFn: () => number,
): Promise<DeltaReleaseNotes | null> {
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
  const parsed = CacheFileSchema.safeParse(json);
  if (!parsed.success) return null;
  for (const entry of parsed.data.entries) {
    if (entry.key !== key) continue;
    if (nowFn() - entry.fetchedAt > NOTES_CACHE_TTL_MS) return null;
    return {
      fromVersion: entry.notes.fromVersion,
      toVersion: entry.notes.toVersion,
      notes: entry.notes.notes,
      partial: entry.notes.partial,
      segments: entry.notes.segments,
    };
  }
  return null;
}

async function writeNotesCacheBestEffort(
  cachePath: string,
  key: string,
  notes: DeltaReleaseNotes,
  nowFn: () => number,
): Promise<void> {
  try {
    let existing: { entries: z.infer<typeof CacheEntrySchema>[] } = { entries: [] };
    try {
      const raw = await readFile(cachePath, 'utf8');
      const parsed = CacheFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) existing = parsed.data;
    } catch {
      /* fresh cache */
    }
    const filtered = existing.entries.filter((e) => e.key !== key);
    filtered.push({
      key,
      fetchedAt: nowFn(),
      notes: {
        fromVersion: notes.fromVersion,
        toVersion: notes.toVersion,
        notes: notes.notes,
        partial: notes.partial,
        segments: notes.segments.map((s) => ({
          version: s.version,
          tagName: s.tagName,
          htmlUrl: s.htmlUrl,
          body: s.body,
          publishedAt: s.publishedAt,
        })),
      },
    });
    // Keep cache file bounded — drop oldest entries beyond 20.
    const trimmed = filtered.slice(-20);
    await mkdir(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify({ entries: trimmed }, null, 2), 'utf8');
    await rename(tmp, cachePath);
  } catch {
    /* swallow — cache is best-effort */
  }
}
