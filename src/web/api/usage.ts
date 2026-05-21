/**
 * REST handler for `GET /api/usage`.
 *
 * Read-only telemetry aggregation — returns tokens, cost, per-model
 * breakdown, per-day rollup, and top sessions in one envelope.
 *
 * Query parameters (all optional):
 *   - `projectId`    — restrict to one workspace (UUID, resolved via registry).
 *   - `sinceMs`      — epoch ms floor. Default: 30 days ago.
 *   - `modelFilter`  — case-insensitive substring on `model`.
 *
 * No CSRF gating — telemetry is read-only.
 */

import type { GetUsageResponse } from '../protocol/rest-types.js';

import { jsonError, jsonOk } from './http.js';
import type { ApiDeps } from './types.js';

/** Sanity cap so a malicious / accidental client can't request "since 1970". */
const MIN_SINCE_MS = 0;
/** Sanity cap on modelFilter so we don't pass arbitrarily large strings to LOWER(). */
const MAX_MODEL_FILTER_LEN = 200;

export async function handleUsage(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }

  // ---- projectId → projectRoot resolution -----------------------------
  let projectRoot: string | undefined;
  const projectId = url.searchParams.get('projectId');
  if (projectId !== null && projectId.length > 0) {
    const ws = deps.workspaceRegistry.get(projectId);
    if (ws === null) {
      return jsonError('not_found', `Project ${projectId} not found`, 404);
    }
    projectRoot = ws.root;
  }

  // ---- sinceMs --------------------------------------------------------
  let sinceMs: number | undefined;
  const sinceRaw = url.searchParams.get('sinceMs');
  if (sinceRaw !== null && sinceRaw.length > 0) {
    const parsed = Number.parseInt(sinceRaw, 10);
    if (!Number.isFinite(parsed) || parsed < MIN_SINCE_MS) {
      return jsonError('invalid_query', 'sinceMs must be a non-negative integer', 400);
    }
    sinceMs = parsed;
  }

  // ---- modelFilter ----------------------------------------------------
  let modelFilter: string | undefined;
  const filterRaw = url.searchParams.get('modelFilter');
  if (filterRaw !== null && filterRaw.length > 0) {
    if (filterRaw.length > MAX_MODEL_FILTER_LEN) {
      return jsonError(
        'invalid_query',
        `modelFilter too long (max ${MAX_MODEL_FILTER_LEN})`,
        400,
      );
    }
    modelFilter = filterRaw;
  }

  // ---- Aggregate ------------------------------------------------------
  try {
    const opts: {
      projectRoot?: string;
      sinceMs?: number;
      modelFilter?: string;
    } = {};
    if (projectRoot !== undefined) opts.projectRoot = projectRoot;
    if (sinceMs !== undefined) opts.sinceMs = sinceMs;
    if (modelFilter !== undefined) opts.modelFilter = modelFilter;
    const stats = deps.sessionManager.getUsageStats(opts);
    const body: GetUsageResponse = stats;
    return jsonOk(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError('usage_failed', msg, 500);
  }
}
