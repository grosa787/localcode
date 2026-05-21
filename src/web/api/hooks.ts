/**
 * REST handler for `GET /api/hooks`.
 *
 * Returns the hooks array from the current config. Read-only — no CSRF
 * required. Returns 405 on non-GET.
 */

import type { HookConfigEntry } from '@/types/global';

import { jsonError, jsonOk } from './http.js';
import type { ApiDeps } from './types.js';

export interface HooksResponse {
  hooks: HookConfigEntry[];
}

export async function handleHooks(
  req: Request,
  _url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  try {
    const cfg = deps.configManager.read();
    const body: HooksResponse = { hooks: cfg.hooks ?? [] };
    return jsonOk(body);
  } catch (err) {
    return jsonError(
      'config_error',
      err instanceof Error ? err.message : 'Failed to read config',
      500,
    );
  }
}
