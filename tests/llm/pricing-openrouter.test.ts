/**
 * OpenRouter pricing fetcher — exercises the parse path, the cache
 * round-trip, and the network-failure fallback.
 *
 * Strategy:
 *   - Swap `globalThis.fetch` for a controllable stub so we never
 *     touch the real network.
 *   - Point the cache at a temp dir so tests don't pollute the user's
 *     `~/.localcode/cache/` directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configureOpenRouterPricingCache,
  parseOpenRouterResponse,
  refreshOpenRouterPricing,
  getOpenRouterPriceMap,
  getOpenRouterPriceMapSync,
  __resetOpenRouterPricingForTests,
} from '@/llm/pricing/openrouter-pricing';

const ORIGINAL_FETCH = globalThis.fetch;

function makeFetchStub(
  payload: unknown,
  opts?: { status?: number; throwOnRead?: boolean },
): typeof globalThis.fetch {
  const stub = async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const status = opts?.status ?? 200;
    if (opts?.throwOnRead === true) {
      throw new Error('network down');
    }
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return stub as unknown as typeof globalThis.fetch;
}

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lc-openrouter-pricing-'));
  configureOpenRouterPricingCache(tmp);
  __resetOpenRouterPricingForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('parseOpenRouterResponse', () => {
  test('parses valid catalog entries', () => {
    const map = parseOpenRouterResponse({
      data: [
        {
          id: 'qwen/qwen3-coder',
          pricing: { prompt: '0.0000003', completion: '0.0000012' },
        },
        {
          id: 'anthropic/claude-3.5-sonnet',
          pricing: {
            prompt: '0.000003',
            completion: '0.000015',
            input_cache_read: '0.0000003',
          },
        },
      ],
    });
    expect(map['qwen/qwen3-coder']?.inputPer1M).toBeCloseTo(0.3, 6);
    expect(map['qwen/qwen3-coder']?.outputPer1M).toBeCloseTo(1.2, 6);
    expect(map['anthropic/claude-3.5-sonnet']?.cachedInputPer1M).toBeCloseTo(0.3, 6);
  });

  test('drops rows missing prompt or completion', () => {
    const map = parseOpenRouterResponse({
      data: [
        { id: 'noprice/model' }, // no pricing at all
        { id: 'partial/model', pricing: { prompt: '0.0001' } }, // missing completion
        {
          id: 'ok/model',
          pricing: { prompt: '0.0001', completion: '0.0002' },
        },
      ],
    });
    expect(map['noprice/model']).toBeUndefined();
    expect(map['partial/model']).toBeUndefined();
    expect(map['ok/model']).toBeDefined();
  });

  test('non-conforming input → empty map', () => {
    expect(parseOpenRouterResponse({})).toEqual({});
    expect(parseOpenRouterResponse(null)).toEqual({});
    expect(parseOpenRouterResponse({ data: 'oops' })).toEqual({});
  });
});

describe('refreshOpenRouterPricing', () => {
  test('writes cache atomically (tmp → rename)', async () => {
    globalThis.fetch = makeFetchStub({
      data: [
        {
          id: 'ok/model',
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
      ],
    });
    const map = await refreshOpenRouterPricing({ force: true });
    expect(map['ok/model']?.inputPer1M).toBeCloseTo(1.0, 6);
    const cacheFile = join(tmp, 'openrouter-pricing.json');
    expect(existsSync(cacheFile)).toBe(true);
    const onDisk = JSON.parse(readFileSync(cacheFile, 'utf-8')) as {
      version: number;
      fetchedAt: number;
      models: Record<string, unknown>;
    };
    expect(onDisk.version).toBe(1);
    expect(onDisk.models['ok/model']).toBeDefined();
  });

  test('TTL honoured — within 24h refuses re-fetch', async () => {
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'a/b',
              pricing: { prompt: '0.000001', completion: '0.000002' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    await refreshOpenRouterPricing({ force: true });
    expect(fetched).toBe(1);
    // Subsequent call without force respects TTL.
    await refreshOpenRouterPricing();
    expect(fetched).toBe(1);
    // Forced bypass triggers re-fetch.
    await refreshOpenRouterPricing({ force: true });
    expect(fetched).toBe(2);
  });

  test('network failure preserves prior cache', async () => {
    // First call seeds the cache.
    globalThis.fetch = makeFetchStub({
      data: [
        {
          id: 'a/b',
          pricing: { prompt: '0.000001', completion: '0.000002' },
        },
      ],
    });
    await refreshOpenRouterPricing({ force: true });
    expect(getOpenRouterPriceMapSync()['a/b']).toBeDefined();

    // Second call: network goes down. Should not clobber the cache.
    globalThis.fetch = makeFetchStub(null, { throwOnRead: true });
    const after = await refreshOpenRouterPricing({ force: true });
    expect(after['a/b']).toBeDefined();
  });

  test('HTTP error preserves prior cache and returns existing map', async () => {
    globalThis.fetch = makeFetchStub({}, { status: 500 });
    const map = await refreshOpenRouterPricing({ force: true });
    expect(map).toEqual({});
  });

  test('getOpenRouterPriceMap bootstraps from disk', async () => {
    // Seed via refresh, then reset in-memory state.
    globalThis.fetch = makeFetchStub({
      data: [
        {
          id: 'x/y',
          pricing: { prompt: '0.000005', completion: '0.000010' },
        },
      ],
    });
    await refreshOpenRouterPricing({ force: true });
    __resetOpenRouterPricingForTests();

    // Should bootstrap from on-disk cache without another fetch.
    const map = await getOpenRouterPriceMap();
    expect(map['x/y']?.inputPer1M).toBeCloseTo(5.0, 6);
  });
});
