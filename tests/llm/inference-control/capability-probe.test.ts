/**
 * Wave 16B — capability probe tests (mocked fetch).
 *
 * Covers: server-accepts → true; server-rejects (400) → false; cloud
 * backend short-circuits to all-false (no fetch); cache hit avoids a
 * second probe; TTL expiry forces a re-probe.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CAPABILITY_TTL_MS,
  probeCapabilities,
} from '@/llm/inference-control';
import type { FetchImpl } from '@/llm/inference-control';

const tmpFiles: string[] = [];

afterEach(async () => {
  for (const f of tmpFiles.splice(0)) {
    await fs.rm(f, { force: true });
  }
});

function tmpCache(): string {
  const p = path.join(os.tmpdir(), `caps-${crypto.randomUUID()}.json`);
  tmpFiles.push(p);
  return p;
}

/** A fetch that returns the given status for every probe, counting calls. */
function statusFetch(status: number): { fetchImpl: FetchImpl; calls: () => number } {
  let n = 0;
  const impl: FetchImpl = async () => {
    n += 1;
    return new Response('{}', { status });
  };
  return { fetchImpl: impl, calls: () => n };
}

describe('probeCapabilities', () => {
  test('server accepts (200) → all capabilities true', async () => {
    const { fetchImpl } = statusFetch(200);
    const report = await probeCapabilities({
      baseUrl: 'http://localhost:1234/v1',
      backend: 'lmstudio',
      model: 'qwen',
      fetchImpl,
      cachePath: tmpCache(),
    });
    expect(report.grammar).toBe(true);
    expect(report.jsonSchema).toBe(true);
    expect(report.logitBias).toBe(true);
    expect(report.cachePrompt).toBe(true);
    expect(report.backend).toBe('lmstudio');
    expect(report.model).toBe('qwen');
  });

  test('server rejects (400) → all capabilities false', async () => {
    const { fetchImpl } = statusFetch(400);
    const report = await probeCapabilities({
      baseUrl: 'http://localhost:1234/v1',
      backend: 'lmstudio',
      model: 'qwen',
      fetchImpl,
      cachePath: tmpCache(),
    });
    expect(report.grammar).toBe(false);
    expect(report.jsonSchema).toBe(false);
    expect(report.logitBias).toBe(false);
    expect(report.cachePrompt).toBe(false);
  });

  test('mixed support — grammar 200, others 400', async () => {
    const impl: FetchImpl = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const ok = 'grammar' in body;
      return new Response('{}', { status: ok ? 200 : 400 });
    };
    const report = await probeCapabilities({
      baseUrl: 'http://localhost:1234/v1',
      backend: 'custom',
      model: 'm',
      fetchImpl: impl,
      cachePath: tmpCache(),
    });
    expect(report.grammar).toBe(true);
    expect(report.jsonSchema).toBe(false);
    expect(report.logitBias).toBe(false);
    expect(report.cachePrompt).toBe(false);
  });

  test('cloud backend → all false, never touches fetch', async () => {
    const { fetchImpl, calls } = statusFetch(200);
    for (const backend of ['openai', 'openrouter', 'google', 'anthropic'] as const) {
      const report = await probeCapabilities({
        baseUrl: 'https://api.openai.com/v1',
        backend,
        model: 'gpt',
        fetchImpl,
        cachePath: tmpCache(),
      });
      expect(report.grammar).toBe(false);
      expect(report.jsonSchema).toBe(false);
      expect(report.logitBias).toBe(false);
      expect(report.cachePrompt).toBe(false);
    }
    expect(calls()).toBe(0);
  });

  test('undefined backend → not probed (all false)', async () => {
    const { fetchImpl, calls } = statusFetch(200);
    const report = await probeCapabilities({
      baseUrl: 'http://localhost:11434',
      backend: undefined,
      model: 'm',
      fetchImpl,
      cachePath: tmpCache(),
    });
    expect(report.grammar).toBe(false);
    expect(calls()).toBe(0);
  });

  test('cache hit — second call does not re-probe', async () => {
    const cachePath = tmpCache();
    const { fetchImpl, calls } = statusFetch(200);
    const params = {
      baseUrl: 'http://localhost:1234/v1',
      backend: 'lmstudio' as const,
      model: 'qwen',
      fetchImpl,
      cachePath,
    };
    await probeCapabilities(params);
    const firstCalls = calls();
    expect(firstCalls).toBeGreaterThan(0);

    const second = await probeCapabilities(params);
    // No additional fetch calls — served from cache.
    expect(calls()).toBe(firstCalls);
    expect(second.grammar).toBe(true);
  });

  test('TTL expiry forces a re-probe', async () => {
    const cachePath = tmpCache();
    const { fetchImpl, calls } = statusFetch(200);
    const base = {
      baseUrl: 'http://localhost:1234/v1',
      backend: 'lmstudio' as const,
      model: 'qwen',
      fetchImpl,
      cachePath,
    };
    await probeCapabilities(base);
    const firstCalls = calls();

    // Re-probe with a 0ms TTL — the cached entry is instantly stale.
    await probeCapabilities({ ...base, ttlMs: 0 });
    expect(calls()).toBeGreaterThan(firstCalls);
  });

  test('default TTL is 7 days', () => {
    expect(DEFAULT_CAPABILITY_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('noCache forces a fresh probe and skips persistence', async () => {
    const cachePath = tmpCache();
    const { fetchImpl, calls } = statusFetch(200);
    const base = {
      baseUrl: 'http://localhost:1234/v1',
      backend: 'lmstudio' as const,
      model: 'qwen',
      fetchImpl,
      cachePath,
      noCache: true,
    };
    await probeCapabilities(base);
    const firstCalls = calls();
    await probeCapabilities(base);
    expect(calls()).toBeGreaterThan(firstCalls);
    // Nothing persisted.
    await expect(fs.readFile(cachePath, 'utf8')).rejects.toBeDefined();
  });

  test('network error → capability false (no throw)', async () => {
    const impl: FetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const report = await probeCapabilities({
      baseUrl: 'http://localhost:9/v1',
      backend: 'lmstudio',
      model: 'm',
      fetchImpl: impl,
      cachePath: tmpCache(),
    });
    expect(report.grammar).toBe(false);
    expect(report.logitBias).toBe(false);
  });
});
