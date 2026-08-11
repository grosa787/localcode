/**
 * Check #5 — API key for the selected backend.
 *
 * Whether a key is needed is read from
 * `PROVIDER_DEFAULTS[backend].requiresApiKey`, NOT from a local-vs-cloud
 * set. Unsloth Studio runs on localhost yet rejects unauthenticated
 * requests with 401, so "local" stopped being a valid proxy for "no key
 * needed" — a membership test would report a passing check while every
 * request fails.
 *
 * Backends that need a key are ok when either the config carries an
 * explicit `apiKey` OR the per-provider env var (e.g. `OPENAI_API_KEY`,
 * `UNSLOTH_API_KEY`) is set.
 */

import {
  resolveApiKey,
  resolveApiKeyFrom,
  PROVIDER_DEFAULTS,
  PROVIDER_META,
} from '@/config/defaults';
import type { Config } from '@/config/types';
import type { DoctorCheckEnv, DoctorCheckResult } from './types';

export async function checkApiKeys(
  config: Config | null,
  env: DoctorCheckEnv = {},
): Promise<DoctorCheckResult> {
  const startedAt = Date.now();
  if (config === null) {
    return {
      name: 'API key',
      status: 'warn',
      message: 'Skipped — no parsed config.',
      durationMs: Date.now() - startedAt,
    };
  }
  const backend = config.backend.type;
  if (!PROVIDER_DEFAULTS[backend].requiresApiKey) {
    return {
      name: 'API key',
      status: 'ok',
      // Not "is local": `custom` may well be a cloud gateway, and
      // `unsloth` is local yet keyed. The only true statement is that
      // this backend does not DECLARE a key requirement.
      message: `Not required for ${backend}.`,
      durationMs: Date.now() - startedAt,
    };
  }
  // Honour the override-env passed in tests so `process.env` lookups
  // don't leak across cases. Resolution order (config ▶ canonical env ▶
  // alias env) comes from the shared resolver — a local copy would drift
  // from what the adapter actually sends.
  const envVar = PROVIDER_META[backend].apiKeyEnvVar;
  const key =
    env.env !== undefined
      ? resolveApiKeyFrom(env.env, backend, config.backend.apiKey)
      : resolveApiKey(backend, config.backend.apiKey);
  if (key !== undefined && key.length > 0) {
    const source =
      config.backend.apiKey !== undefined && config.backend.apiKey.length > 0
        ? 'config'
        : envVar ?? 'env';
    return {
      name: 'API key',
      status: 'ok',
      message: `${backend} key found (${source}).`,
      durationMs: Date.now() - startedAt,
    };
  }
  return {
    name: 'API key',
    status: 'fail',
    message: `${backend} needs an API key. Set ${envVar ?? 'apiKey'} or run \`localcode --reconfigure\`.`,
    durationMs: Date.now() - startedAt,
  };
}
