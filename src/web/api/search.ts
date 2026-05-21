/**
 * REST handler for `/api/search`.
 *
 * Read-only cross-session full-text search. Powers the SPA's session-
 * history search overlay. No CSRF check (GET-only metadata, no
 * mutating side-effects), but mirrors every other handler's security
 * headers via `jsonOk` / `jsonError`.
 *
 * Query params:
 *   - `q`         (required) — free-text. Empty/whitespace returns 200
 *                 with an empty result list.
 *   - `projectId` (optional) — restrict to one workspace. Unknown ids
 *                 return 404 so the SPA can distinguish "wrong filter"
 *                 from "no hits".
 *   - `limit`     (optional) — clamped [1, 100], default 20.
 *   - `offset`    (optional) — clamped >=0, default 0.
 *
 * Response: `{ results, total, query }` per
 * `SearchSessionsResponse` in `protocol/rest-types.ts`.
 */

import type {
  SearchResultWire,
  SearchSessionsResponse,
} from '../protocol/rest-types.js';
import { jsonError, jsonOk } from './http.js';
import type { ApiDeps } from './types.js';

/** Default + clamped page size — mirrors SessionManager's clamp. */
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;

export async function handleSearch(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }

  const q = url.searchParams.get('q') ?? '';
  const projectIdRaw = url.searchParams.get('projectId');
  const projectId =
    projectIdRaw !== null && projectIdRaw.length > 0 ? projectIdRaw : null;
  const limit = clampInt(url.searchParams.get('limit'), SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

  // Resolve project filter — projectId on the wire maps to a project_root
  // in SQLite. Unknown id => 404 (so the SPA can distinguish from
  // "no hits"). Omitted id => search everywhere.
  let projectRoot: string | undefined;
  if (projectId !== null) {
    const ws = deps.workspaceRegistry.get(projectId);
    if (ws === null) {
      return jsonError('not_found', `Project ${projectId} not found`, 404);
    }
    projectRoot = ws.root;
  }

  const opts: { projectRoot?: string; limit: number; offset: number } = {
    limit,
    offset,
  };
  if (projectRoot !== undefined) opts.projectRoot = projectRoot;

  let raw;
  let total;
  try {
    raw = deps.sessionManager.searchMessages(q, opts);
    total = deps.sessionManager.countSearchMessages(q, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError('search_failed', message, 500);
  }

  // Map project_root → projectId/label for every hit. We can't carry
  // absolute paths to the SPA (it has no permission to read them) so
  // results from a session whose project was removed from the registry
  // show as `projectId: null`.
  const rootToWorkspace = new Map<
    string,
    { id: string; label: string }
  >();
  for (const ws of deps.workspaceRegistry.list()) {
    rootToWorkspace.set(ws.root, { id: ws.id, label: ws.label });
  }

  const results: SearchResultWire[] = raw.map((r) => {
    const ws = rootToWorkspace.get(r.projectRoot);
    return {
      sessionId: r.sessionId,
      messageId: r.messageId,
      role: r.role,
      snippet: r.snippet,
      rank: r.rank,
      createdAt: r.createdAt,
      sessionTitle: r.sessionTitle,
      projectId: ws?.id ?? null,
      projectLabel: ws?.label ?? null,
    };
  });

  const body: SearchSessionsResponse = {
    results,
    total,
    query: q,
  };
  return jsonOk(body);
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
