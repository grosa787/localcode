/**
 * mcp-fetcher — pulls the modelcontextprotocol/servers public catalog
 * and installs entries into the user's ~/.localcode/config.toml as
 * mcpServers entries.
 *
 * Source: https://github.com/modelcontextprotocol/servers (official).
 * API:    https://api.github.com/repos/modelcontextprotocol/servers/contents/src
 *
 * Each subdirectory under `src/` is one server. We read each server's
 * `package.json` (for `name`/`description`/`bin` hints) and `README.md`
 * (for env-var hints and an `npx ...` example) to populate
 * `MarketplaceMcpServer` entries.
 *
 * `mcp.so` has no public API at the time of writing, so this fetcher
 * sticks to the official GitHub repo. Future work may add a second
 * source behind the same interface.
 *
 * Cache + rate-limit semantics mirror skills-fetcher.ts: 6h TTL by
 * default, ETag round-trip, 403 → stale-cache fallback.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  stat as fsStat,
} from 'node:fs/promises';

import type {
  MarketplaceCache,
  MarketplaceFetchOpts,
  MarketplaceFetchResult,
  MarketplaceMcpServer,
} from '@/marketplace/types';
import { DEFAULT_CACHE_TTL_MS } from '@/marketplace/types';
import { ConfigManager } from '@/config/config-manager';

const REPO_OWNER = 'modelcontextprotocol';
const REPO_NAME = 'servers';
const CONTENTS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/src`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/src`;
const CACHE_FILE_NAME = 'mcp-cache.json';
const USER_AGENT = 'LocalCode-marketplace/1.0';

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

function parseCachedServer(raw: unknown): MarketplaceMcpServer | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' ? r['id'] : null;
  const name = typeof r['name'] === 'string' ? r['name'] : null;
  const description = typeof r['description'] === 'string' ? r['description'] : '';
  const sourceRaw = typeof r['source'] === 'string' ? r['source'] : 'community';
  const source: 'anthropics' | 'community' =
    sourceRaw === 'anthropics' ? 'anthropics' : 'community';
  const url = typeof r['url'] === 'string' ? r['url'] : '';
  const command = typeof r['command'] === 'string' ? r['command'] : 'npx';
  const args: string[] = Array.isArray(r['args'])
    ? (r['args'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const envVars: string[] = Array.isArray(r['envVars'])
    ? (r['envVars'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (id === null || name === null) return null;
  return { id, name, description, source, url, command, args, envVars };
}

async function readCache(
  cacheDir: string,
): Promise<MarketplaceCache<MarketplaceMcpServer> | null> {
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
          .map(parseCachedServer)
          .filter((s): s is MarketplaceMcpServer => s !== null)
      : [];
    const out: MarketplaceCache<MarketplaceMcpServer> = { fetchedAt, entries };
    if (etag !== undefined) out.etag = etag;
    return out;
  } catch {
    return null;
  }
}

async function writeCache(
  cacheDir: string,
  payload: MarketplaceCache<MarketplaceMcpServer>,
): Promise<void> {
  await fsMkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, CACHE_FILE_NAME);
  const tmp = `${file}.tmp`;
  const data = JSON.stringify(payload, null, 2);
  await fsWriteFile(tmp, data, 'utf8');
  const { rename: fsRename } = await import('node:fs/promises');
  await fsRename(tmp, file);
}

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
 * Best-effort parse of a server's `package.json` for `description`.
 * Returns `null` on any failure so the caller can fall back to README
 * scraping.
 */
function readDescriptionFromPackageJson(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const desc = (parsed as Record<string, unknown>)['description'];
    return typeof desc === 'string' ? desc : null;
  } catch {
    return null;
  }
}

/**
 * Extract env-var names referenced in a README. We look for the pattern
 * `${VAR_NAME}` and `process.env.VAR_NAME` inside the README's TOML/JSON
 * code blocks so we can prompt the user for them at install time.
 */
function extractEnvVarsFromReadme(readme: string): string[] {
  const out = new Set<string>();
  const dollarBrace = /\$\{([A-Z][A-Z0-9_]*)\}/g;
  const processEnv = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  // Backtick-quoted env-var hints (e.g. "set `GITHUB_TOKEN`").
  const backticked = /`([A-Z][A-Z0-9_]{2,})`/g;
  // env block style: `NAME: <value>` or `NAME=<value>`
  const envColon = /^\s*([A-Z][A-Z0-9_]{2,})\s*[:=]\s*['"<]/gm;
  const isSecret = (n: string): boolean =>
    /TOKEN|KEY|SECRET|API|PASSWORD|CREDENTIAL/.test(n);
  for (const m of readme.matchAll(dollarBrace)) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  for (const m of readme.matchAll(processEnv)) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  for (const m of readme.matchAll(backticked)) {
    const name = m[1];
    if (name !== undefined && isSecret(name)) out.add(name);
  }
  for (const m of readme.matchAll(envColon)) {
    const name = m[1];
    if (name !== undefined && isSecret(name)) out.add(name);
  }
  return [...out].sort();
}

/**
 * Try to spot the canonical `npx -y @modelcontextprotocol/server-<name>`
 * installation hint inside the README. Returns the parsed command + args
 * pair, or null if no clean install line was found.
 */
function extractInstallCommand(
  readme: string,
  serverId: string,
): { command: string; args: string[] } | null {
  // Match `npx -y @modelcontextprotocol/server-<id>` plus optional flags
  const npxRe = new RegExp(
    `npx\\s+(?:-y\\s+|--yes\\s+)?(@[a-z0-9_\\-/]+server-${serverId.replace(/[^a-z0-9-]/g, '')}[a-z0-9_\\-]*)`,
    'i',
  );
  const npxMatch = npxRe.exec(readme);
  if (npxMatch !== null && npxMatch[1] !== undefined) {
    return { command: 'npx', args: ['-y', npxMatch[1]] };
  }
  const generic = /npx\s+(?:-y\s+|--yes\s+)?(@modelcontextprotocol\/[a-z0-9_\-]+)/.exec(
    readme,
  );
  if (generic !== null && generic[1] !== undefined) {
    return { command: 'npx', args: ['-y', generic[1]] };
  }
  const uvxRe = /uvx\s+([a-z0-9_\-]+)/i;
  const uvxMatch = uvxRe.exec(readme);
  if (uvxMatch !== null && uvxMatch[1] !== undefined) {
    return { command: 'uvx', args: [uvxMatch[1]] };
  }
  return null;
}

async function fetchServerMetadata(
  dir: GhContentDir,
  fetchImpl: import('@/marketplace/types').MarketplaceFetch,
): Promise<{
  description: string;
  command: string;
  args: string[];
  envVars: string[];
  url: string;
}> {
  let description = '';
  let command = 'npx';
  let args: string[] = [];
  let envVars: string[] = [];
  let url = dir.html_url;

  // package.json (TypeScript-flavoured servers)
  try {
    const pkgUrl = `${RAW_BASE}/${dir.name}/package.json`;
    const resp = await fetchImpl(pkgUrl, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    });
    if (resp.ok) {
      const text = await resp.text();
      const desc = readDescriptionFromPackageJson(text);
      if (desc !== null) description = desc;
    }
  } catch {
    // fall through
  }

  // README.md — env var hints + install command
  try {
    const readmeUrl = `${RAW_BASE}/${dir.name}/README.md`;
    const resp = await fetchImpl(readmeUrl, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain, text/markdown' },
    });
    if (resp.ok) {
      const readme = await resp.text();
      url = readmeUrl;
      envVars = extractEnvVarsFromReadme(readme);
      const cmd = extractInstallCommand(readme, dir.name);
      if (cmd !== null) {
        command = cmd.command;
        args = cmd.args;
      } else {
        // Sensible default for Python servers (uvx <name>).
        args = ['-y', `@modelcontextprotocol/server-${dir.name}`];
      }
      // If we still have no description, take the first non-heading line.
      if (description.length === 0) {
        const firstPara = readme
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find((s) => s.length > 0 && !s.startsWith('#'));
        if (firstPara !== undefined) description = firstPara;
      }
    }
  } catch {
    // fall through
  }

  if (args.length === 0) {
    args = ['-y', `@modelcontextprotocol/server-${dir.name}`];
  }
  return { description, command, args, envVars, url };
}

/**
 * Fetch the upstream MCP servers catalog. Identical contract to
 * `fetchSkillCatalog` — see that file for cache / rate-limit details.
 */
export async function fetchMcpCatalog(
  opts: MarketplaceFetchOpts = {},
): Promise<MarketplaceFetchResult<MarketplaceMcpServer>> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const fetchImpl: import('@/marketplace/types').MarketplaceFetch =
    opts.fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  const force = opts.force === true;

  const cache = await readCache(cacheDir);
  const now = Date.now();
  const ageMs = cache !== null ? Math.max(0, now - cache.fetchedAt) : Number.MAX_SAFE_INTEGER;

  if (!force && cache !== null && ageMs < ttl) {
    return { entries: cache.entries, ageMs, stale: false, rateLimited: false };
  }

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

  if (listingResp.status === 304 && cache !== null) {
    const refreshed: MarketplaceCache<MarketplaceMcpServer> = {
      fetchedAt: now,
      entries: cache.entries,
    };
    if (cache.etag !== undefined) refreshed.etag = cache.etag;
    await writeCache(cacheDir, refreshed).catch(() => {
      // best-effort
    });
    return { entries: cache.entries, ageMs: 0, stale: false, rateLimited: false };
  }

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
  const entries: MarketplaceMcpServer[] = [];
  for (const dir of dirs) {
    const meta = await fetchServerMetadata(dir, fetchImpl);
    entries.push({
      id: dir.name,
      name: dir.name,
      description: meta.description,
      source: 'community',
      url: meta.url,
      command: meta.command,
      args: meta.args,
      envVars: meta.envVars,
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  const newEtag = listingResp.headers.get('etag') ?? undefined;
  const payload: MarketplaceCache<MarketplaceMcpServer> = {
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
 * Install one MCP server entry into the user's global config TOML. We
 * add the server under `[mcpServers.<id>]` and seed any required env
 * vars from `opts.envValues`. The keys NOT supplied are left out of
 * the TOML; the user can add them manually later or via the overlay's
 * env-var prompt.
 *
 * Refuses to overwrite an existing entry — callers must remove it first
 * (or surface a confirmation prompt) to avoid silently clobbering a
 * working config.
 */
export async function installMcpServer(
  server: MarketplaceMcpServer,
  opts: {
    envValues?: Record<string, string>;
    configManager?: ConfigManager;
  } = {},
): Promise<{ installedAs: string }> {
  const manager = opts.configManager ?? new ConfigManager();
  const current = manager.exists() ? safeRead(manager) : null;
  const existing = current?.mcpServers?.[server.id];
  if (existing !== undefined) {
    throw new Error(
      `MCP server "${server.id}" already configured. Remove the existing entry first.`,
    );
  }

  const env: Record<string, string> = {};
  if (opts.envValues !== undefined) {
    for (const name of server.envVars) {
      const value = opts.envValues[name];
      if (typeof value === 'string' && value.length > 0) {
        env[name] = value;
      }
    }
  }

  const entry: Record<string, unknown> = {
    type: 'stdio',
    command: server.command,
    args: server.args,
  };
  if (Object.keys(env).length > 0) entry['env'] = env;

  const patch: Record<string, unknown> = {
    mcpServers: { [server.id]: entry },
  };
  manager.update(patch as Parameters<typeof manager.update>[0]);

  return { installedAs: server.id };
}

function safeRead(manager: ConfigManager): { mcpServers?: Record<string, unknown> } | null {
  try {
    return manager.read();
  } catch {
    return null;
  }
}
