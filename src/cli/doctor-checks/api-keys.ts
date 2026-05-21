/**
 * Check #5 — API key for the selected cloud backend.
 *
 * Local backends (Ollama, LM Studio) always pass — they don't need a
 * key. Cloud backends are ok when either the config carries an explicit
 * `apiKey` OR the per-provider env var (e.g. `OPENAI_API_KEY`) is set.
 */

import { resolveApiKey, PROVIDER_META } from '@/config/defaults';
import type { Config } from '@/config/types';
import type { Backend } from '@/types/global';
import type { DoctorCheckEnv, DoctorCheckResult } from './types';

const CLOUD_BACKENDS: ReadonlySet<Backend> = new Set([
  'openai',
  'anthropic',
  'openrouter',
  'google',
]);

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
  if (!CLOUD_BACKENDS.has(backend)) {
    return {
      name: 'API key',
      status: 'ok',
      message: `Not required (${backend} is local).`,
      durationMs: Date.now() - startedAt,
    };
  }
  // Honour the override-env passed in tests so `process.env` lookups
  // don't leak across cases.
  const envVar = PROVIDER_META[backend].apiKeyEnvVar;
  let key: string | undefined;
  if (config.backend.apiKey !== undefined && config.backend.apiKey.length > 0) {
    key = config.backend.apiKey;
  } else if (env.env !== undefined && envVar !== undefined) {
    key = env.env[envVar];
  } else {
    key = resolveApiKey(backend, config.backend.apiKey);
  }
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
