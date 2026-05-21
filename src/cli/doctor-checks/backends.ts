/**
 * Check #4 — Backend reachable.
 *
 * For local backends (Ollama / LM Studio) we ping `baseUrl/v1/models`
 * (or `/api/tags` as Ollama fallback). For cloud backends we only
 * verify DNS resolves so we don't burn rate-limit quota.
 *
 * Tests inject `env.fetchFn` to deterministically force ok / fail.
 */

import { lookup } from 'node:dns/promises';
import type { Backend } from '@/types/global';
import type { Config } from '@/config/types';
import type { DoctorCheckEnv, DoctorCheckResult } from './types';

const PING_TIMEOUT_MS = 2_500;

const CLOUD_BACKENDS: ReadonlySet<Backend> = new Set([
  'openai',
  'anthropic',
  'openrouter',
  'google',
]);

async function fetchWithTimeout(
  url: string,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    try {
      ctrl.abort();
    } catch {
      /* swallow */
    }
  }, timeoutMs);
  try {
    return await fetchFn(url, { signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function dnsResolves(host: string): Promise<boolean> {
  try {
    await lookup(host);
    return true;
  } catch {
    return false;
  }
}

export async function checkBackend(
  config: Config | null,
  env: DoctorCheckEnv = {},
): Promise<DoctorCheckResult> {
  const startedAt = Date.now();
  if (config === null) {
    return {
      name: 'Backend',
      status: 'warn',
      message: 'Skipped — no parsed config.',
      durationMs: Date.now() - startedAt,
    };
  }
  const backend = config.backend.type;
  const baseUrl = config.backend.baseUrl;
  if (baseUrl.length === 0) {
    return {
      name: 'Backend',
      status: 'fail',
      message: `backend.baseUrl is empty (provider: ${backend}).`,
      durationMs: Date.now() - startedAt,
    };
  }

  // Cloud backends — DNS-only probe.
  if (CLOUD_BACKENDS.has(backend)) {
    let host: string;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      return {
        name: 'Backend',
        status: 'fail',
        message: `Invalid backend.baseUrl: "${baseUrl}".`,
        durationMs: Date.now() - startedAt,
      };
    }
    const ok = await dnsResolves(host);
    return {
      name: 'Backend',
      status: ok ? 'ok' : 'warn',
      message: ok
        ? `${backend} DNS resolves (${host}).`
        : `${backend} DNS lookup failed for ${host}.`,
      durationMs: Date.now() - startedAt,
    };
  }

  // Local / custom — actually hit /v1/models.
  const fetchFn = env.fetchFn ?? globalThis.fetch.bind(globalThis);
  const probe = baseUrl.endsWith('/v1') || baseUrl.endsWith('/v1/')
    ? baseUrl.replace(/\/$/, '') + '/models'
    : baseUrl.replace(/\/$/, '') + '/v1/models';
  const res = await fetchWithTimeout(probe, fetchFn, PING_TIMEOUT_MS);
  if (res === null) {
    // Try Ollama-style fallback.
    if (backend === 'ollama') {
      const fallback = await fetchWithTimeout(
        baseUrl.replace(/\/$/, '') + '/api/tags',
        fetchFn,
        PING_TIMEOUT_MS,
      );
      if (fallback !== null && fallback.ok) {
        return {
          name: 'Backend',
          status: 'ok',
          message: `${backend} reachable at ${baseUrl}.`,
          durationMs: Date.now() - startedAt,
        };
      }
    }
    return {
      name: 'Backend',
      status: 'fail',
      message: `${backend} unreachable at ${baseUrl}.`,
      durationMs: Date.now() - startedAt,
    };
  }
  return {
    name: 'Backend',
    status: res.ok ? 'ok' : 'warn',
    message: res.ok
      ? `${backend} reachable at ${baseUrl}.`
      : `${backend} responded ${res.status} at ${baseUrl}.`,
    durationMs: Date.now() - startedAt,
  };
}
