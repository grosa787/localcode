/**
 * REST handlers for `/api/skills` and `/api/skills/:id/toggle`.
 *
 * - `GET    /api/skills?projectId=…` → list skills (project + global merged).
 * - `POST   /api/skills?projectId=…` → upsert a skill markdown file.
 * - `POST   /api/skills/:id/toggle?projectId=…` → flip the active flag.
 * - `DELETE /api/skills/:id?projectId=…&global=true|false` → remove a skill.
 *
 * `projectId` is optional. When supplied (and resolved through the
 * workspace registry) we get the per-project skills directory and active
 * state file; otherwise we use the global locations under `~/.localcode/`.
 *
 * Each request constructs a fresh `SkillsManager` because the underlying
 * file system is cheap and the manager is stateless past its in-memory
 * active set, which it reloads on `init()`.
 */
import { z } from 'zod';

import { SkillsManager, SkillsError } from '@/skills/skills-manager';
import type { Skill } from '@/types/global';

import type {
  AddSkillRequest,
  AddSkillResponse,
  ListSkillsResponse,
  SkillSummary,
  ToggleSkillRequest,
  ToggleSkillResponse,
} from '../protocol/rest-types.js';

import { jsonError, jsonOk, parseJsonBody } from './http.js';
import type { ApiDeps } from './types.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

// Body cap mirrors the spec (~100 KB) — keeps a single skill file
// from bloating the system prompt past the prefix-cache friendly
// budget.
const MAX_SKILL_BODY_BYTES = 100 * 1024;

const ToggleSkillSchema = z.object({
  active: z.boolean(),
});

const AddSkillSchema = z.object({
  id: z.string().regex(ID_RE, 'id must be lowercase alphanumeric with - or _'),
  title: z.string().min(1),
  description: z.string().optional(),
  body: z.string().min(1).max(MAX_SKILL_BODY_BYTES, 'body exceeds 100 KB'),
  scope: z.enum(['project', 'global']),
});

function summarize(skill: Skill): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source ?? 'global',
    active: skill.active,
  };
}

function resolveProjectRoot(
  url: URL,
  deps: ApiDeps,
): string | null {
  const projectId = url.searchParams.get('projectId');
  if (projectId === null || projectId.length === 0) return null;
  const ws = deps.workspaceRegistry.get(projectId);
  if (ws === null) return null;
  return ws.root;
}

function buildManager(deps: ApiDeps, url: URL): SkillsManager {
  const projectRoot = resolveProjectRoot(url, deps);
  const opts = projectRoot !== null ? { projectRoot } : {};
  return new SkillsManager(opts);
}

/** `GET /api/skills` and `POST /api/skills` (create). */
export async function handleSkills(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method === 'GET') {
    try {
      const mgr = buildManager(deps, url);
      const skills = await mgr.list();
      const body: ListSkillsResponse = {
        skills: skills.map(summarize),
      };
      return jsonOk(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError('skills_failed', msg, 500);
    }
  }
  if (req.method === 'POST') {
    const parsed = await parseJsonBody<AddSkillRequest>(req, AddSkillSchema);
    if (!parsed.ok) return parsed.response;
    const { id, title, description, body, scope } = parsed.value;

    const mgr = buildManager(deps, url);
    if (scope === 'project' && resolveProjectRoot(url, deps) === null) {
      return jsonError(
        'no_project',
        'Project scope requires a valid projectId query param',
        400,
      );
    }

    // Compose the markdown file with YAML frontmatter so the parser
    // picks up the title (`name:`) and description from explicit
    // fields. Body becomes the markdown content beneath.
    const desc = description ?? '';
    const safeTitle = title.replace(/"/g, '\\"');
    const safeDesc = desc.replace(/"/g, '\\"');
    const frontmatter = desc.length > 0
      ? `---\nname: "${safeTitle}"\ndescription: "${safeDesc}"\n---\n\n`
      : `---\nname: "${safeTitle}"\n---\n\n`;
    const md = `${frontmatter}${body.trimEnd()}\n`;

    try {
      const skill = await mgr.writeSkill(id, md, { scope });
      const response: AddSkillResponse = { skill: summarize(skill) };
      return jsonOk(response, 201);
    } catch (err) {
      if (err instanceof SkillsError) {
        return jsonError('skill_add_failed', err.message, 400);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError('skill_add_failed', msg, 500);
    }
  }
  return jsonError(
    'method_not_allowed',
    `Method ${req.method} not allowed`,
    405,
  );
}

/** `DELETE /api/skills/:id`. */
export async function handleSkillDelete(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'DELETE') {
    return jsonError(
      'method_not_allowed',
      `Method ${req.method} not allowed`,
      405,
    );
  }
  // Path: /api/skills/<id>
  const prefix = '/api/skills/';
  const rest = url.pathname.slice(prefix.length);
  const parts = rest.split('/');
  const id = parts[0] ?? '';
  if (id.length === 0) {
    return jsonError('bad_request', 'Skill id is required in path', 400);
  }
  if (!ID_RE.test(id)) {
    return jsonError('bad_request', 'Skill id has invalid format', 400);
  }
  const mgr = buildManager(deps, url);
  try {
    await mgr.delete(id);
    return jsonOk({ ok: true } as const);
  } catch (err) {
    if (err instanceof SkillsError) {
      return jsonError('skill_delete_failed', err.message, 404);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError('skill_delete_failed', msg, 500);
  }
}

/** `POST /api/skills/:id/toggle`. */
export async function handleSkillToggle(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError(
      'method_not_allowed',
      `Method ${req.method} not allowed`,
      405,
    );
  }
  // Path: /api/skills/<id>/toggle
  const prefix = '/api/skills/';
  const rest = url.pathname.slice(prefix.length);
  const parts = rest.split('/');
  const id = parts[0] ?? '';
  if (id.length === 0 || parts[1] !== 'toggle') {
    return jsonError('not_found', 'Unknown skills route', 404);
  }
  const parsed = await parseJsonBody<ToggleSkillRequest>(req, ToggleSkillSchema);
  if (!parsed.ok) return parsed.response;
  const { active } = parsed.value;

  const mgr = buildManager(deps, url);
  try {
    const all = await mgr.list();
    const target = all.find((s) => s.id === id);
    if (target === undefined) {
      return jsonError('not_found', `Skill ${id} not found`, 404);
    }
    if (target.active !== active) {
      await mgr.toggle(id);
    }
    const body: ToggleSkillResponse = { ok: true };
    return jsonOk(body);
  } catch (err) {
    if (err instanceof SkillsError) {
      return jsonError('skill_toggle_failed', err.message, 400);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError('skill_toggle_failed', msg, 500);
  }
}
