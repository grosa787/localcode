/**
 * REST handlers for `/api/projects`.
 *
 * - `GET    /api/projects`           → list workspaces (most-recent first), junk filtered out.
 * - `POST   /api/projects`           → create-or-touch by absolute root.
 * - `DELETE /api/projects/:id`       → remove workspace registry row.
 * - `POST   /api/projects/cleanup`   → bulk-remove junk entries, returns { removed }.
 */

import { tmpdir } from 'node:os';
import { z } from 'zod';

import type { ApiDeps } from './types.js';
import { jsonError, jsonOk, parseJsonBody } from './http.js';
import type {
  CleanupProjectsResponse,
  CreateProjectResponse,
  DeleteProjectResponse,
  ListProjectsResponse,
  PickFolderResponse,
  WorkspaceRecord,
} from '../protocol/rest-types.js';
import {
  pickFolderNative,
  type PickFolderInternals,
  type PickFolderOptions,
} from './pick-folder.js';

const CreateProjectSchema = z.object({
  root: z.string().min(1),
  label: z.string().min(1).optional(),
});

const PickFolderSchema = z.object({
  prompt: z.string().min(1).max(200).optional(),
});

/**
 * `POST /api/pick-folder` — spawn the OS-native folder dialog and
 * return the picked path. CSRF is enforced by the router. The handler
 * accepts an optional `internals` argument so tests can stub the
 * subprocess without monkey-patching `child_process`.
 */
export async function handlePickFolder(
  req: Request,
  _url: URL,
  _deps: ApiDeps,
  internals?: PickFolderInternals,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  let opts: PickFolderOptions = {};
  // Body is optional; if present, validate.
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const text = await req.text();
    if (text.trim().length > 0) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return jsonError('invalid_json', 'Body is not valid JSON', 400);
      }
      const parsed = PickFolderSchema.safeParse(raw);
      if (!parsed.success) {
        return jsonError('invalid_body', parsed.error.message, 400);
      }
      if (parsed.data.prompt !== undefined) {
        opts = { prompt: parsed.data.prompt };
      }
    }
  }
  const result = await pickFolderNative(opts, internals);
  const body: PickFolderResponse = {
    path: result.path,
    cancelled: result.cancelled,
    platform: result.platform,
  };
  return jsonOk(body);
}

/**
 * Pure predicate: returns true when a workspace path is "junk" — a
 * leftover from integration tests or sub-agent isolation that should
 * never appear in the user's project list.
 *
 * Rules (pattern-only — disk existence is NOT checked here):
 *   - Empty string
 *   - Lives under `os.tmpdir()` (e.g. `/var/folders/.../T/...` on macOS or
 *     `/tmp/...` on Linux)
 *   - Path contains the integration-test fixture marker `/lc-web-it-`
 *   - Path lives inside a git worktrees pool (`/.git/worktrees/`)
 *
 * Disk existence is intentionally NOT part of this predicate. macOS
 * Spotlight indexing, slow-mounted volumes, and symlink resolution can
 * cause `existsSync` to return false transiently for real projects on
 * the first read after launch — which would falsely evict the user's
 * actual workspaces. Dead/relocated paths are removed only via the
 * explicit user-triggered cleanup endpoint.
 *
 * Exported for unit tests.
 */
export function isJunkProjectPath(
  rootPath: string,
  tmpRoot: string = tmpdir(),
): boolean {
  if (rootPath.length === 0) return true;
  // Resolve tmp root once; macOS may report `/var/folders/...` while
  // tmpfile creation returns the symlinked `/private/var/folders/...`.
  if (rootPath.startsWith(tmpRoot)) return true;
  if (rootPath.startsWith(`/private${tmpRoot}`)) return true;
  if (tmpRoot.startsWith('/private') && rootPath.startsWith(tmpRoot.slice('/private'.length))) {
    return true;
  }
  if (rootPath.includes('/lc-web-it-')) return true;
  if (rootPath.includes('/.git/worktrees/')) return true;
  return false;
}

/** Filter helper — returns only the surviving workspaces. */
export function filterJunkProjects(
  projects: readonly WorkspaceRecord[],
): WorkspaceRecord[] {
  return projects.filter((p) => !isJunkProjectPath(p.root));
}

export async function handleProjects(
  req: Request,
  _url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method === 'GET') {
    const all = deps.workspaceRegistry.list();
    const body: ListProjectsResponse = {
      projects: filterJunkProjects([...all]),
    };
    return jsonOk(body);
  }
  if (req.method === 'POST') {
    const parsed = await parseJsonBody(req, CreateProjectSchema);
    if (!parsed.ok) return parsed.response;
    try {
      const project = deps.workspaceRegistry.create(parsed.value.root, parsed.value.label);
      const body: CreateProjectResponse = { project };
      return jsonOk(body, 201);
    } catch (err) {
      return jsonError(
        'invalid_root',
        err instanceof Error ? err.message : 'Failed to create project',
        400,
      );
    }
  }
  return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
}

export async function handleProjectsCleanup(
  req: Request,
  _url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  const all = deps.workspaceRegistry.list();
  const junk = all.filter((p) => isJunkProjectPath(p.root));
  let removed = 0;
  for (const w of junk) {
    if (deps.workspaceRegistry.remove(w.id)) removed += 1;
  }
  const body: CleanupProjectsResponse = { removed };
  return jsonOk(body);
}

export async function handleProjectById(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  const tail = url.pathname.slice('/api/projects/'.length);
  // Sub-route dispatch — keeps the router-table call site (`startsWith
  // '/api/projects/'`) untouched while letting us add bulk endpoints.
  if (tail === 'cleanup') {
    return handleProjectsCleanup(req, url, deps);
  }
  const id = tail;
  if (id.length === 0 || id.includes('/')) {
    return jsonError('not_found', 'Unknown project route', 404);
  }
  if (req.method === 'DELETE') {
    // Read the workspace BEFORE removing it so we have the absolute
    // root path to cascade against `sessions.db`.
    const workspace = deps.workspaceRegistry.get(id);
    if (workspace === null) {
      return jsonError('not_found', `Project ${id} not found`, 404);
    }
    let removedSessions = 0;
    try {
      removedSessions = deps.sessionManager.deleteSessionsForProjectRoot(
        workspace.root,
      );
    } catch {
      // Cascade is best-effort — registry removal still proceeds so the
      // user isn't stuck with a phantom project entry. The user's code
      // on disk is never touched either way.
    }
    const removed = deps.workspaceRegistry.remove(id);
    if (!removed) return jsonError('not_found', `Project ${id} not found`, 404);
    const body: DeleteProjectResponse = { ok: true, removedSessions };
    return jsonOk(body);
  }
  return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
}
