/**
 * REST handler for `/api/models/refresh`.
 *
 * Re-fetches the model list for a given backend (or the active one if
 * `provider` is omitted). Does NOT persist the result — the response
 * is informational; the SPA decides whether to commit a switch via
 * `/api/config/provider`.
 */

import type { Backend } from '@/types/global';

import { PROVIDER_DEFAULTS, resolveApiKey } from '@/config/defaults';
import { BackendSchema } from '../protocol/messages.js';
import type { RefreshModelsResponse } from '../protocol/rest-types.js';
import { jsonError, jsonOk } from './http.js';
import type { ApiDeps } from './types.js';

export async function handleModelsRefresh(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }

  let cfg;
  try {
    cfg = deps.configManager.read();
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to read config',
      500,
    );
  }

  const providerRaw = url.searchParams.get('provider');
  let backend: Backend;
  if (providerRaw === null || providerRaw.length === 0) {
    backend = cfg.backend.type;
  } else {
    const parsed = BackendSchema.safeParse(providerRaw);
    if (!parsed.success) {
      return jsonError('invalid_query', `Unknown provider: ${providerRaw}`, 400);
    }
    backend = parsed.data;
  }

  const baseUrl = backend === cfg.backend.type
    ? cfg.backend.baseUrl
    : PROVIDER_DEFAULTS[backend].baseUrl;
  const apiKey = resolveApiKey(
    backend,
    backend === cfg.backend.type ? cfg.backend.apiKey : undefined,
  );

  let models: readonly string[];
  try {
    const adapter = deps.createAdapterForBackend(backend, baseUrl, apiKey);
    models = await adapter.getModels();
  } catch (err) {
    return jsonError(
      'provider_unreachable',
      err instanceof Error ? err.message : 'Failed to reach provider',
      502,
    );
  }

  const currentModel = backend === cfg.backend.type
    ? cfg.model.current
    : models[0] ?? '';

  const body: RefreshModelsResponse = { models, currentModel, backend };
  return jsonOk(body);
}
