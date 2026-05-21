/**
 * OpenRouter pricing fetcher with a 24h on-disk cache.
 *
 * OpenRouter publishes a public JSON catalog at
 * `https://openrouter.ai/api/v1/models` — no auth required. Each entry
 * carries a `pricing` object whose `prompt` / `completion` numbers are
 * USD per *single* token (string-encoded), e.g. `"prompt": "0.0000025"`
 * = $2.50 per 1M tokens. We multiply by 1e6 to land on the same
 * "per 1M tokens" scale used by the static table.
 *
 * Cache file: `~/.localcode/cache/openrouter-pricing.json`. Written
 * atomically (tmp → rename) so a half-written file can never poison
 * subsequent loads. TTL of 24h is conservative: provider prices change
 * rarely, and a stale entry costs the user a few cents of misreported
 * spend, not a behavioural bug.
 *
 * Failure modes (all graceful — the resolver falls back to static):
 *   - Network unreachable / DNS fail → cache only.
 *   - HTTP non-2xx → cache only.
 *   - Body not JSON / malformed shape → cache only.
 *   - 5s request timeout (the dashboard must NOT block on this).
 *
 * The fetcher is intentionally lazy: callers invoke
 * {@link getOpenRouterPriceMap} which returns the in-memory cache map
 * (loading from disk on first call), and {@link refreshOpenRouterPricing}
 * triggers a background refresh — typically fired once on app start
 * and again on `/usage` open.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ModelPricing } from '@/llm/pricing';

const CACHE_DIR_DEFAULT = join(homedir(), '.localcode', 'cache');
const CACHE_FILE_NAME = 'openrouter-pricing.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;
const ENDPOINT = 'https://openrouter.ai/api/v1/models';

/**
 * Resolved per-model price entry. Keyed by the OpenRouter model id
 * (e.g. `qwen/qwen3-coder`, `anthropic/claude-3.5-sonnet`). Values are
 * normalised to the "per 1M tokens" scale used by the rest of the
 * pricing pipeline.
 */
const PricingEntrySchema = z.object({
  inputPer1M: z.number().finite(),
  outputPer1M: z.number().finite(),
  cachedInputPer1M: z.number().finite().optional(),
  cacheWritePer1M: z.number().finite().optional(),
});

/** On-disk cache envelope (versioned so we can evolve the shape later). */
const CacheFileSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.number().finite(),
  models: z.record(z.string(), PricingEntrySchema),
});

export type OpenRouterPriceMap = Record<string, ModelPricing>;

interface CacheEnvelope {
  version: 1;
  fetchedAt: number;
  models: OpenRouterPriceMap;
}

/**
 * Raw OpenRouter response shape. Validated with Zod so a future field
 * rename doesn't crash the dashboard — only the fields we care about
 * are checked. Any non-conforming row is silently dropped.
 */
const OpenRouterModelSchema = z.object({
  id: z.string().min(1),
  pricing: z
    .object({
      prompt: z.string().optional(),
      completion: z.string().optional(),
      input_cache_read: z.string().optional(),
      input_cache_write: z.string().optional(),
    })
    .optional(),
});

const OpenRouterModelsResponseSchema = z.object({
  data: z.array(OpenRouterModelSchema),
});

let inMemoryCache: CacheEnvelope | null = null;
let cachePath: string = join(CACHE_DIR_DEFAULT, CACHE_FILE_NAME);
let pendingRefresh: Promise<OpenRouterPriceMap> | null = null;

/**
 * Allow tests and embedded runtime hosts to redirect the cache to a
 * scratch directory. Resets the in-memory cache so subsequent calls
 * read from the new location.
 */
export function configureOpenRouterPricingCache(dir: string): void {
  cachePath = join(dir, CACHE_FILE_NAME);
  inMemoryCache = null;
  pendingRefresh = null;
}

/**
 * Parse a "USD per *single* token" string (e.g. `"0.0000025"`) into
 * "USD per 1M tokens" (e.g. `2.5`). Returns undefined when the field
 * is absent or not a finite number string.
 */
function parseUsdPerToken(field: string | undefined): number | undefined {
  if (typeof field !== 'string' || field.length === 0) return undefined;
  const v = Number.parseFloat(field);
  if (!Number.isFinite(v) || v < 0) return undefined;
  return v * 1_000_000;
}

/**
 * Convert the raw OpenRouter models response into our normalised price
 * map. Rows missing both `prompt` and `completion` are dropped — there
 * is nothing useful to bill against. The function never throws; bad
 * input simply yields `{}`.
 */
export function parseOpenRouterResponse(raw: unknown): OpenRouterPriceMap {
  const parsed = OpenRouterModelsResponseSchema.safeParse(raw);
  if (!parsed.success) return {};
  const out: OpenRouterPriceMap = {};
  for (const row of parsed.data.data) {
    const inP = parseUsdPerToken(row.pricing?.prompt);
    const outP = parseUsdPerToken(row.pricing?.completion);
    // Both prompt and completion must be present for the row to be
    // usable — without one of them, billing math is meaningless.
    if (inP === undefined || outP === undefined) continue;
    const entry: ModelPricing = {
      inputPer1M: inP,
      outputPer1M: outP,
    };
    const cachedRead = parseUsdPerToken(row.pricing?.input_cache_read);
    if (cachedRead !== undefined) entry.cachedInputPer1M = cachedRead;
    out[row.id] = entry;
  }
  return out;
}

async function loadFromDisk(): Promise<CacheEnvelope | null> {
  try {
    const buf = await fs.readFile(cachePath, 'utf-8');
    const json: unknown = JSON.parse(buf);
    const parsed = CacheFileSchema.safeParse(json);
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

async function writeToDisk(envelope: CacheEnvelope): Promise<void> {
  try {
    await fs.mkdir(join(cachePath, '..'), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(envelope), 'utf-8');
    await fs.rename(tmp, cachePath);
  } catch {
    // Cache write failures are non-fatal — the dashboard still works
    // from the in-memory snapshot.
  }
}

/**
 * Fetch the OpenRouter catalog with a hard 5s timeout. Returns `null`
 * on any failure (network, status, parse) — caller falls back to the
 * cache.
 */
async function fetchFromNetwork(): Promise<OpenRouterPriceMap | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    return parseOpenRouterResponse(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort price map for OpenRouter routed models. Reads the
 * in-memory cache; on first call, falls back to the on-disk cache so
 * cold-start dashboards have data instantly. Returns `{}` when no
 * cache exists yet (the resolver then falls back to the static table).
 */
export async function getOpenRouterPriceMap(): Promise<OpenRouterPriceMap> {
  if (inMemoryCache !== null) return inMemoryCache.models;
  const disk = await loadFromDisk();
  if (disk !== null) {
    inMemoryCache = disk;
    return disk.models;
  }
  return {};
}

/** Synchronous accessor — only returns data already loaded in memory. */
export function getOpenRouterPriceMapSync(): OpenRouterPriceMap {
  return inMemoryCache?.models ?? {};
}

/**
 * Trigger a refresh of the OpenRouter pricing cache.
 *
 * Behaviour:
 *   - If the on-disk cache exists and is younger than {@link TTL_MS},
 *     use it as-is — no network call.
 *   - Otherwise, kick off a background fetch. Multiple concurrent
 *     callers share the same in-flight promise.
 *   - Fetch failures leave the existing (potentially stale) cache in
 *     place; the resolver falls back to static prices for any model
 *     missing from the cached map.
 *
 * Returns a promise that resolves with the *current* price map after
 * the refresh attempt completes. Never rejects.
 */
export async function refreshOpenRouterPricing(opts?: {
  /** Bypass the TTL check and force a network fetch. */
  force?: boolean;
}): Promise<OpenRouterPriceMap> {
  // Bootstrap from disk if we haven't loaded yet.
  if (inMemoryCache === null) {
    inMemoryCache = await loadFromDisk();
  }

  const now = Date.now();
  const fresh =
    inMemoryCache !== null && now - inMemoryCache.fetchedAt < TTL_MS;
  if (fresh && opts?.force !== true) {
    return inMemoryCache?.models ?? {};
  }

  if (pendingRefresh !== null) return pendingRefresh;

  pendingRefresh = (async (): Promise<OpenRouterPriceMap> => {
    try {
      const network = await fetchFromNetwork();
      if (network === null) {
        // Keep the prior cache. If nothing on disk and no network,
        // return empty.
        return inMemoryCache?.models ?? {};
      }
      const envelope: CacheEnvelope = {
        version: 1,
        fetchedAt: now,
        models: network,
      };
      inMemoryCache = envelope;
      await writeToDisk(envelope);
      return network;
    } finally {
      pendingRefresh = null;
    }
  })();

  return pendingRefresh;
}

/** Test-only utility — clear all in-memory state. */
export function __resetOpenRouterPricingForTests(): void {
  inMemoryCache = null;
  pendingRefresh = null;
}

export const __test__ = {
  parseUsdPerToken,
  TTL_MS,
  ENDPOINT,
};
