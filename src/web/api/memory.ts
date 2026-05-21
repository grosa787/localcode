/**
 * REST handlers for `/api/memory`.
 *
 * - `GET  /api/memory?projectId=…`        → list entries + index text
 * - `POST /api/memory?projectId=…`        → write entry (CSRF gated)
 * - `DELETE /api/memory/:name?projectId=…` → remove entry (CSRF gated)
 *
 * `projectId` is required. When not supplied or not found in the
 * workspace registry the handlers return 400 / 404.
 */

import { z } from 'zod';

import { MemoryStore, MemoryStoreError } from '@/memory/store';
import { MEMORY_TYPES, MEMORY_NAME_RE } from '@/memory/types';
import type { MemoryEntry } from '@/memory/types';

import { jsonError, jsonOk, parseJsonBody } from './http.js';
import type { ApiDeps } from './types.js';

// ---------- Zod schemas ----------

const WriteMemorySchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(MEMORY_NAME_RE, 'name must be lowercase alphanumeric with - or _'),
  description: z.string().min(1),
  type: z.enum(MEMORY_TYPES),
  body: z.string().min(1),
});

// ---------- Helpers ----------

function resolveProjectRoot(url: URL, deps: ApiDeps): string | null {
  const projectId = url.searchParams.get('projectId');
  if (!projectId || projectId.length === 0) return null;
  const ws = deps.workspaceRegistry.get(projectId);
  return ws !== null ? ws.root : null;
}

function toWire(entry: MemoryEntry): MemoryEntryWire {
  return {
    name: entry.name,
    description: entry.description,
    type: entry.type,
    body: entry.body,
  };
}

/** Wire shape — path is an implementation detail, not exposed to the client. */
export interface MemoryEntryWire {
  name: string;
  description: string;
  type: (typeof MEMORY_TYPES)[number];
  body: string;
}

export interface ListMemoryResponse {
  entries: MemoryEntryWire[];
  index: string;
}

export interface WriteMemoryResponse {
  entry: MemoryEntryWire;
}

export interface DeleteMemoryResponse {
  ok: true;
}

// ---------- GET + POST /api/memory ----------

export async function handleMemory(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  const projectRoot = resolveProjectRoot(url, deps);
  if (projectRoot === null) {
    return jsonError('no_project', 'Valid projectId query param is required', 400);
  }
  const store = new MemoryStore(projectRoot);

  if (req.method === 'GET') {
    try {
      const entries = await store.list();
      // Build index text inline — avoids a redundant rebuildIndex disk write
      // on a read-only path.
      const index =
        entries.length === 0
          ? '# Memory Index\n\n(no entries)\n'
          : [
              '# Memory Index',
              '',
              ...entries.map(
                (e) => `- [${e.name}](${e.name}.md) — ${e.description}`,
              ),
              '',
            ].join('\n');
      const body: ListMemoryResponse = { entries: entries.map(toWire), index };
      return jsonOk(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError('memory_list_failed', msg, 500);
    }
  }

  if (req.method === 'POST') {
    const parsed = await parseJsonBody(req, WriteMemorySchema);
    if (!parsed.ok) return parsed.response;
    const { name, description, type, body } = parsed.value;

    try {
      const entry = await store.write({
        name,
        description,
        type,
        body,
        path: '',
      });
      const response: WriteMemoryResponse = { entry: toWire(entry) };
      return jsonOk(response, 201);
    } catch (err) {
      if (err instanceof MemoryStoreError) {
        return jsonError('memory_write_failed', err.message, 400);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError('memory_write_failed', msg, 500);
    }
  }

  return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
}

// ---------- DELETE /api/memory/:name ----------

export async function handleMemoryDelete(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method !== 'DELETE') {
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }

  const projectRoot = resolveProjectRoot(url, deps);
  if (projectRoot === null) {
    return jsonError('no_project', 'Valid projectId query param is required', 400);
  }

  // Path: /api/memory/<name>
  const prefix = '/api/memory/';
  const name = url.pathname.slice(prefix.length).split('/')[0] ?? '';
  if (name.length === 0) {
    return jsonError('bad_request', 'Memory entry name is required in path', 400);
  }

  const store = new MemoryStore(projectRoot);
  try {
    await store.remove(name);
    const body: DeleteMemoryResponse = { ok: true };
    return jsonOk(body);
  } catch (err) {
    if (err instanceof MemoryStoreError) {
      return jsonError('memory_delete_failed', err.message, 400);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError('memory_delete_failed', msg, 500);
  }
}
