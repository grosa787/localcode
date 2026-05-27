/**
 * skills-fetcher — pulls the Anthropic public skills catalog and installs
 * entries into the user's skills directory.
 *
 * Source: https://github.com/anthropics/skills (public repo).
 * API: https://api.github.com/repos/anthropics/skills/contents
 *
 * Each top-level subdirectory in the repo is a skill; inside the dir we
 * read SKILL.md (or fallback to README.md) and parse frontmatter for
 * `name:` / `description:`.
 *
 * Caching:
 *   - On-disk JSON at `~/.localcode/marketplace/skills-cache.json`.
 *   - Default TTL: 6 hours (override via opts.cacheTtlMs).
 *   - Honours GitHub ETag — sends `If-None-Match` and reuses cache on 304.
 *
 * Rate limit: unauthenticated GitHub API = 60 req/hr per IP. On 403 we
 * fall back to the cached version unconditionally (even if stale) so a
 * rate-limited user still sees the last known good catalog.
 *
 * No `: any` / `@ts-ignore` — every upstream shape is narrowed inline.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  copyFile as fsCopyFile,
  stat as fsStat,
} from 'node:fs/promises';

import type {
  MarketplaceCache,
  MarketplaceFetchOpts,
  MarketplaceFetchResult,
  MarketplaceSkill,
} from '@/marketplace/types';
import { DEFAULT_CACHE_TTL_MS } from '@/marketplace/types';

const REPO_OWNER = 'anthropics';
const REPO_NAME = 'skills';
const CONTENTS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main`;
const CACHE_FILE_NAME = 'skills-cache.json';
const USER_AGENT = 'LocalCode-marketplace/1.0';

/** Default cache directory under ~/.localcode/marketplace/. */
function defaultCacheDir(): string {
  return path.join(homedir(), '.localcode', 'marketplace');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsStat(p);
    return true;
  } catch {
    return false;
  }
}

async function readCache(
  cacheDir: string,
): Promise<MarketplaceCache<MarketplaceSkill> | null> {
  const file = path.join(cacheDir, CACHE_FILE_NAME);
  if (!(await pathExists(file))) return null;
  try {
    const raw = await fsReadFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const fetchedAt = typeof obj['fetchedAt'] === 'number' ? obj['fetchedAt'] : 0;
    const etag = typeof obj['etag'] === 'string' ? obj['etag'] : undefined;
    const entries = Array.isArray(obj['entries'])
      ? (obj['entries'] as unknown[])
          .map(parseCachedSkill)
          .filter((s): s is MarketplaceSkill => s !== null)
      : [];
    const out: MarketplaceCache<MarketplaceSkill> = { fetchedAt, entries };
    if (etag !== undefined) out.etag = etag;
    return out;
  } catch {
    return null;
  }
}

function parseCachedSkill(raw: unknown): MarketplaceSkill | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' ? r['id'] : null;
  const name = typeof r['name'] === 'string' ? r['name'] : null;
  const description = typeof r['description'] === 'string' ? r['description'] : '';
  const sourceRaw = typeof r['source'] === 'string' ? r['source'] : 'anthropics';
  const source: 'anthropics' | 'community' =
    sourceRaw === 'community' ? 'community' : 'anthropics';
  const url = typeof r['url'] === 'string' ? r['url'] : '';
  const installPath =
    typeof r['installPath'] === 'string' ? r['installPath'] : `${id ?? 'skill'}.md`;
  if (id === null || name === null) return null;
  return { id, name, description, source, url, installPath };
}

async function writeCache(
  cacheDir: string,
  payload: MarketplaceCache<MarketplaceSkill>,
): Promise<void> {
  await fsMkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, CACHE_FILE_NAME);
  const tmp = `${file}.tmp`;
  const data = JSON.stringify(payload, null, 2);
  await fsWriteFile(tmp, data, 'utf8');
  // node:fs/promises rename via writeFile-then-rename keeps cache atomic.
  // We import rename lazily because most call sites don't reach here.
  const { rename: fsRename } = await import('node:fs/promises');
  await fsRename(tmp, file);
}

/** A single entry from GitHub's `/contents` listing we care about. */
interface GhContentDir {
  name: string;
  type: 'dir' | 'file' | 'symlink' | 'submodule';
  path: string;
  url: string;
  html_url: string;
}

function parseContentsListing(raw: unknown): GhContentDir[] {
  if (!Array.isArray(raw)) return [];
  const out: GhContentDir[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'] : null;
    const type = typeof r['type'] === 'string' ? r['type'] : null;
    const p = typeof r['path'] === 'string' ? r['path'] : null;
    const url = typeof r['url'] === 'string' ? r['url'] : null;
    const html = typeof r['html_url'] === 'string' ? r['html_url'] : null;
    if (
      name === null ||
      type === null ||
      p === null ||
      url === null ||
      html === null
    ) {
      continue;
    }
    if (
      type !== 'dir' &&
      type !== 'file' &&
      type !== 'symlink' &&
      type !== 'submodule'
    ) {
      continue;
    }
    out.push({ name, type, path: p, url, html_url: html });
  }
  return out;
}

/**
 * Extract `name:` and `description:` from a markdown frontmatter block.
 * Returns empty strings when the file has no frontmatter at all so the
 * caller can fall back to repo-derived defaults.
 */
function parseFrontmatterBasic(raw: string): { name: string; description: string } {
  const opening = /^---\r?\n/.exec(raw);
  if (!opening) return { name: '', description: '' };
  const rest = raw.slice(opening[0].length);
  const closing = /(^|\r?\n)---\r?\n?/.exec(rest);
  if (!closing) return { name: '', description: '' };
  const fm = rest.slice(0, closing.index);
  const lines = fm.split(/\r?\n/);
  let name = '';
  let description = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    let value = trimmed.slice(colon + 1).trim();
    if (value.length >= 2) {
      const first = value.charAt(0);
      const last = value.charAt(value.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (key === 'name') name = value;
    else if (key === 'description') description = value;
  }
  return { name, description };
}

/**
 * Best-effort skill-body fetch. Tries `SKILL.md` first (Anthropic
 * convention), then `README.md`. Returns `null` when neither is reachable.
 */
async function fetchSkillBody(
  dirPath: string,
  fetchImpl: import('@/marketplace/types').MarketplaceFetch,
): Promise<{ body: string; url: string } | null> {
  const candidates = ['SKILL.md', 'README.md'];
  for (const filename of candidates) {
    const url = `${RAW_BASE}/${dirPath}/${filename}`;
    try {
      const resp = await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/plain, text/markdown' },
      });
      if (resp.ok) {
        const body = await resp.text();
        return { body, url };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Fetch the Anthropic skills catalog. Returns the typed result envelope
 * (entries + cache age + flags) so callers can render a "(cached, N
 * hours)" badge in the UI without poking the cache file directly.
 *
 * Network failure / rate-limit policy:
 *   - Any non-2xx response that ISN'T 304 falls back to cache (if any).
 *   - 403 specifically sets `rateLimited: true` so the UI can call out
 *     the throttling to the user.
 *   - Total fetch failure with no cache returns an empty list rather
 *     than throwing — the overlay surfaces "no catalog available".
 */
export async function fetchSkillCatalog(
  opts: MarketplaceFetchOpts = {},
): Promise<MarketplaceFetchResult<MarketplaceSkill>> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const fetchImpl: import('@/marketplace/types').MarketplaceFetch =
    opts.fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  const force = opts.force === true;

  const cache = await readCache(cacheDir);
  const now = Date.now();
  const ageMs = cache !== null ? Math.max(0, now - cache.fetchedAt) : Number.MAX_SAFE_INTEGER;

  // Cache is still fresh — use it as-is (skip the network round trip).
  if (!force && cache !== null && ageMs < ttl) {
    return { entries: cache.entries, ageMs, stale: false, rateLimited: false };
  }

  // Network path. On any failure we degrade to the cached entries (if any).
  let listingResp: Response | null = null;
  try {
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: 'application/vnd.github+json',
    };
    if (cache?.etag !== undefined) headers['if-none-match'] = cache.etag;
    listingResp = await fetchImpl(CONTENTS_URL, { headers });
  } catch {
    if (cache !== null) {
      return { entries: cache.entries, ageMs, stale: true, rateLimited: false };
    }
    return { entries: [], ageMs: 0, stale: false, rateLimited: false };
  }

  // 304 — cache is still authoritative; refresh `fetchedAt` so the
  // "cached" badge doesn't keep widening for a stable upstream.
  if (listingResp.status === 304 && cache !== null) {
    const refreshed: MarketplaceCache<MarketplaceSkill> = {
      fetchedAt: now,
      entries: cache.entries,
    };
    if (cache.etag !== undefined) refreshed.etag = cache.etag;
    await writeCache(cacheDir, refreshed).catch(() => {
      // swallow — cache write failures are non-fatal
    });
    return { entries: cache.entries, ageMs: 0, stale: false, rateLimited: false };
  }

  // 403 (rate-limited) or other 4xx/5xx — fall back to cache.
  if (!listingResp.ok) {
    if (cache !== null) {
      return {
        entries: cache.entries,
        ageMs,
        stale: true,
        rateLimited: listingResp.status === 403,
      };
    }
    return {
      entries: [],
      ageMs: 0,
      stale: false,
      rateLimited: listingResp.status === 403,
    };
  }

  let listingRaw: unknown;
  try {
    listingRaw = await listingResp.json();
  } catch {
    if (cache !== null) {
      return { entries: cache.entries, ageMs, stale: true, rateLimited: false };
    }
    return { entries: [], ageMs: 0, stale: false, rateLimited: false };
  }

  const dirs = parseContentsListing(listingRaw).filter((d) => d.type === 'dir');
  const entries: MarketplaceSkill[] = [];
  for (const dir of dirs) {
    const fetched = await fetchSkillBody(dir.path, fetchImpl);
    if (fetched === null) {
      // Couldn't reach SKILL.md/README.md; still record the directory
      // so the user sees it in the browser — install will re-try later.
      entries.push({
        id: dir.name,
        name: dir.name,
        description: '',
        source: 'anthropics',
        url: dir.html_url,
        installPath: `${dir.name}.md`,
      });
      continue;
    }
    const fm = parseFrontmatterBasic(fetched.body);
    entries.push({
      id: dir.name,
      name: fm.name.length > 0 ? fm.name : dir.name,
      description: fm.description,
      source: 'anthropics',
      url: fetched.url,
      installPath: `${dir.name}.md`,
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  const newEtag = listingResp.headers.get('etag') ?? undefined;
  const payload: MarketplaceCache<MarketplaceSkill> = {
    fetchedAt: now,
    entries,
  };
  if (newEtag !== undefined) payload.etag = newEtag;
  await writeCache(cacheDir, payload).catch(() => {
    // best-effort
  });

  return { entries, ageMs: 0, stale: false, rateLimited: false };
}

/**
 * Install one skill into the user's skills directory. Resolves the
 * markdown body via the entry's `url` (already an absolute upstream
 * link) and writes it to `<scope-dir>/<installPath>`. Refuses to
 * overwrite an existing file — callers must delete the previous copy
 * first.
 *
 * Scope mapping:
 *   - `'global'`  → `~/.localcode/skills/`
 *   - `'project'` → `<projectRoot>/.localcode/skills/`
 *
 * `projectRoot` is required when `target === 'project'`.
 */
export async function installSkill(
  skill: MarketplaceSkill,
  target: 'global' | 'project',
  opts: {
    projectRoot?: string;
    fetchImpl?: import('@/marketplace/types').MarketplaceFetch;
  } = {},
): Promise<{ installedAt: string }> {
  const fetchImpl: import('@/marketplace/types').MarketplaceFetch =
    opts.fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  if (target === 'project' && typeof opts.projectRoot !== 'string') {
    throw new Error(
      "installSkill: target='project' requires opts.projectRoot",
    );
  }
  const destDir =
    target === 'project'
      ? path.join(opts.projectRoot as string, '.localcode', 'skills')
      : path.join(homedir(), '.localcode', 'skills');
  await fsMkdir(destDir, { recursive: true });
  const destFile = path.join(destDir, skill.installPath);
  if (await pathExists(destFile)) {
    throw new Error(
      `Skill already installed at ${destFile}. Remove it first to reinstall.`,
    );
  }

  // Fetch upstream body. Falls back to a minimal stub when the URL is
  // unreachable so the install still produces a file the user can edit.
  let body = '';
  try {
    const resp = await fetchImpl(skill.url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain, text/markdown' },
    });
    if (resp.ok) {
      body = await resp.text();
    }
  } catch {
    // fall through to stub
  }

  if (body.length === 0) {
    // Build a minimal frontmatter stub so the SkillsManager can parse it.
    body = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\nSee ${skill.url}\n`;
  }

  await fsWriteFile(destFile, body, 'utf8');

  // Best-effort: drop an empty rename target so callers can verify the
  // file exists without re-statting.
  void fsCopyFile;
  return { installedAt: destFile };
}
