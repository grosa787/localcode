/**
 * Marketplace shared types — describe entries fetched from upstream
 * registries (Anthropic skills, modelcontextprotocol/servers) and the
 * common cache envelope used by both fetchers.
 *
 * Kept dependency-free; the JSON shapes returned by the fetchers and
 * consumed by the overlay live here so the overlay can stay agnostic of
 * which registry produced an entry.
 */

/** Where an entry was sourced from. */
export type MarketplaceSource = 'anthropics' | 'community';

/** Common metadata every marketplace entry carries. */
export interface MarketplaceEntryBase {
  id: string;
  name: string;
  description: string;
  source: MarketplaceSource;
  /** Direct URL to the upstream entry (markdown, README, etc). */
  url: string;
}

/**
 * Skill catalog entry. `installPath` is the canonical relative filename
 * (e.g. `code-review.md`) appended to the chosen skills directory at
 * install time.
 */
export interface MarketplaceSkill extends MarketplaceEntryBase {
  source: 'anthropics' | 'community';
  /** Filename used when copying the skill into the user's skills dir. */
  installPath: string;
}

/**
 * MCP server entry parsed from the upstream `modelcontextprotocol/servers`
 * repo. `envVars` names the env vars the user must supply BEFORE the
 * server can boot — surfaced by the overlay as a prompt.
 */
export interface MarketplaceMcpServer extends MarketplaceEntryBase {
  /** Command to spawn (e.g. `npx`, `uvx`, `node`). */
  command: string;
  /** argv tail forwarded to the spawned command. */
  args: string[];
  /** Names (NOT values) of env vars the server requires. */
  envVars: string[];
}

/** On-disk cache envelope shared by both fetchers. */
export interface MarketplaceCache<T> {
  /** When the upstream catalog was last successfully fetched. */
  fetchedAt: number;
  /** Optional ETag echoed back to GitHub on subsequent requests. */
  etag?: string;
  entries: T[];
}

/**
 * Callable subset of `globalThis.fetch` that the marketplace fetchers
 * + tests use. Kept narrower than `typeof fetch` so tests can pass a
 * plain async function without having to fake Bun's `preconnect`
 * extension on the global `fetch` object.
 */
export type MarketplaceFetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Options accepted by every fetcher. */
export interface MarketplaceFetchOpts {
  /** Cache TTL in ms. Defaults to 6 hours. */
  cacheTtlMs?: number;
  /**
   * Override `globalThis.fetch` — used by tests + alternative HTTP
   * stacks. Defaults to `globalThis.fetch`.
   */
  fetchImpl?: MarketplaceFetch;
  /**
   * Force-refresh — ignore the on-disk cache and re-fetch from upstream.
   * Cache file is rewritten on success; on failure the prior cache is
   * left intact and surfaced (so refresh failure never loses data).
   */
  force?: boolean;
  /** Override cache directory (tests). Defaults to `~/.localcode/marketplace/`. */
  cacheDir?: string;
}

/** Result envelope returned by the fetchers. */
export interface MarketplaceFetchResult<T> {
  entries: T[];
  /** Age of the cache in ms (0 when freshly fetched). */
  ageMs: number;
  /** True when the cache was used because upstream was unreachable / rate-limited. */
  stale: boolean;
  /** True when the upstream returned 403 (rate-limit) and we fell back. */
  rateLimited: boolean;
}

/** Default cache TTL — 6 hours. */
export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
