/**
 * Check #4 — Backend reachable.
 *
 * For local backends (Ollama / LM Studio / Unsloth Studio) we ping
 * `baseUrl/v1/models` (or `/api/tags` as Ollama fallback). For cloud
 * backends we only verify DNS resolves so we don't burn rate-limit
 * quota.
 *
 * Unsloth stays OUT of `CLOUD_BACKENDS` — it listens on localhost, so
 * the HTTP ping is the right probe. It is also the first LOCAL backend
 * that requires a bearer token, so the probe sends the resolved key:
 * an unauthenticated ping would 401 against every correctly configured
 * install and send the user to fix a key that was already right.
 *
 * A 401/403 that survives an authenticated probe gets its own branch —
 * the connection-refused wording would blame a server that is running
 * fine. The branch only escalates to `fail` for backends that DECLARE
 * they need a key (`requiresApiKey`); a keyless `custom` endpoint
 * behind a gateway keeps the historical `warn`, so `doctor` does not
 * start exiting 1 on installs that worked before.
 *
 * Tests inject `env.fetchFn` to deterministically force ok / fail.
 */

import { lookup } from 'node:dns/promises';
import {
  PROVIDER_DEFAULTS,
  PROVIDER_META,
  resolveApiKey,
  resolveApiKeyFrom,
} from '@/config/defaults';
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
  headers?: Record<string, string>,
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
    return await fetchFn(url, {
      signal: ctrl.signal,
      ...(headers !== undefined ? { headers } : {}),
    });
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
  // Same key the adapter would use for a real request — otherwise the
  // probe measures "did we send a token?", not "is the server healthy?".
  const key =
    env.env !== undefined
      ? resolveApiKeyFrom(env.env, backend, config.backend.apiKey)
      : resolveApiKey(backend, config.backend.apiKey);
  const authHeaders =
    key !== undefined && key.length > 0
      ? { Authorization: `Bearer ${key}` }
      : undefined;
  const res = await fetchWithTimeout(probe, fetchFn, PING_TIMEOUT_MS, authHeaders);
  if (res === null) {
    // Try Ollama-style fallback.
    if (backend === 'ollama') {
      const fallback = await fetchWithTimeout(
        baseUrl.replace(/\/$/, '') + '/api/tags',
        fetchFn,
        PING_TIMEOUT_MS,
        authHeaders,
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
      detail: unreachableDetail(backend),
      durationMs: Date.now() - startedAt,
    };
  }
  // The server is UP but refusing the key we just sent. That is an auth
  // failure, not a "is it running?" failure — saying the latter sends
  // the user to restart a server that was never the problem.
  //
  // Only a backend that DECLARES it needs a key is a hard failure. A
  // `custom` endpoint that happens to sit behind a gateway keeps the
  // historical `warn` so `doctor` does not newly exit 1 on it.
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    const needsKey = PROVIDER_DEFAULTS[backend].requiresApiKey;
    const envVar = PROVIDER_META[backend].apiKeyEnvVar;
    return {
      name: 'Backend',
      status: needsKey ? 'fail' : 'warn',
      message: `${backend} is running but rejected the request (${res.status}).`,
      detail: needsKey
        ? `Set ${envVar ?? 'backend.apiKey'} — the server is up, the key is missing or wrong.`
        : 'The endpoint requires credentials — set backend.apiKey if it needs one.',
      durationMs: Date.now() - startedAt,
    };
  }
  return {
    name: 'Backend',
    status: res.ok ? 'ok' : 'warn',
    message: res.ok
      ? `${backend} reachable at ${baseUrl}.`
      : `${backend} responded ${res.status} at ${baseUrl}.`,
    detail: res.ok ? reachableDetail(backend) : undefined,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Extra line shown under a successful ping. Only Unsloth has one: the
 * ping cannot observe whether `unsloth run` was started with
 * `--disable-tools`, and without that flag the server runs its OWN tool
 * loop and never hands tool calls back — LocalCode then looks like it
 * hangs doing nothing. A reachable-but-useless server is exactly when a
 * user runs `doctor`, so the reminder belongs on the passing row.
 */
function reachableDetail(backend: Backend): string | undefined {
  if (backend !== 'unsloth') return undefined;
  return 'Server needs --disable-tools for tool calls.';
}

/**
 * Extra line under an unreachable local server. Only Unsloth has one:
 * nothing is listening yet, so this is the first moment the launch flag
 * can be shown, and it is the flag users most often omit.
 */
function unreachableDetail(backend: Backend): string | undefined {
  if (backend !== 'unsloth') return undefined;
  return 'Start: unsloth run --model <id> --disable-tools';
}
