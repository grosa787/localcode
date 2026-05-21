/**
 * REST handlers for `/api/sessions`.
 *
 * - `GET    /api/sessions?projectId=…&limit=…`        list per-project.
 * - `POST   /api/sessions`                             create new session.
 * - `DELETE /api/sessions/:id`                         delete session.
 * - `GET    /api/sessions/:id/messages?cursor=…`       paginated history.
 *
 * Sessions are filtered by `projectRoot` matching the requested
 * workspace's root. The protocol-layer `SessionSummaryWire` always
 * carries `projectId` (the workspace UUID), so callers never need to
 * know the absolute path.
 */

import { z } from 'zod';

import { isSubAgentSessionId } from '@/sessions/session-manager';
import type { Session } from '@/types/global';

import type {
  CreateSessionResponse,
  DeleteSessionResponse,
  ForkAtMessageResponse,
  ListMessagesResponse,
  ListSessionsResponse,
  SessionSummaryWire,
  WireChatMessage,
} from '../protocol/rest-types.js';
import { ForkAtMessageRequestSchema } from '../protocol/rest-types.js';
import { jsonError, jsonOk, parseJsonBody } from './http.js';
import type { ApiDeps } from './types.js';

const CreateSessionSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().optional(),
  model: z.string().optional(),
});

/** Default page size for `/messages` — clamps oversized requests. */
const MESSAGES_PAGE_DEFAULT = 100;
const MESSAGES_PAGE_MAX = 500;
const SESSIONS_LIST_DEFAULT = 50;
const SESSIONS_LIST_MAX = 500;

function toSummary(
  session: Session,
  projectId: string,
  messageCount: number,
): SessionSummaryWire {
  return {
    id: session.id,
    projectId,
    title: session.title,
    summary: session.summary,
    model: session.model,
    backend: session.backend,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount,
  };
}

export async function handleSessions(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  if (req.method === 'GET') return listSessions(url, deps);
  if (req.method === 'POST') return createSession(req, deps);
  return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
}

export async function handleSessionById(
  req: Request,
  url: URL,
  deps: ApiDeps,
): Promise<Response> {
  // /api/sessions/:id  or  /api/sessions/:id/messages
  const tail = url.pathname.slice('/api/sessions/'.length);
  const segments = tail.split('/').filter((s) => s.length > 0);
  const id = segments[0];
  if (id === undefined || id.length === 0) {
    return jsonError('not_found', 'Unknown session route', 404);
  }
  if (segments.length === 1) {
    if (req.method === 'DELETE') {
      const session = deps.sessionManager.getSession(id);
      if (session === null) return jsonError('not_found', `Session ${id} not found`, 404);
      deps.sessionManager.deleteSession(id);
      // Audit L4 — drop any resident ChatRuntime so the in-memory
      // executor / browser session / agent team for this row is torn
      // down alongside the SQLite delete. Hook is optional; REST-only
      // tests omit it without consequence.
      if (deps.releaseSession !== undefined) {
        try {
          deps.releaseSession(id);
        } catch (err) {
          // Non-fatal — the row is already gone; surface to logs only.
          // eslint-disable-next-line no-console
          console.warn(
            `[api/sessions] releaseSession(${id}) threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      const body: DeleteSessionResponse = { ok: true };
      return jsonOk(body);
    }
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  if (segments.length === 2 && segments[1] === 'messages') {
    if (req.method === 'GET') return listMessages(id, url, deps);
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  // FORK-AT-MESSAGE-SECTION
  if (segments.length === 2 && segments[1] === 'fork-at-message') {
    if (req.method === 'POST') return forkAtMessage(id, req, deps);
    return jsonError('method_not_allowed', `Method ${req.method} not allowed`, 405);
  }
  // FORK-AT-MESSAGE-SECTION-END
  return jsonError('not_found', 'Unknown session route', 404);
}

// FORK-AT-MESSAGE-SECTION
async function forkAtMessage(
  sessionId: string,
  req: Request,
  deps: ApiDeps,
): Promise<Response> {
  const parsed = await parseJsonBody(req, ForkAtMessageRequestSchema);
  if (!parsed.ok) return parsed.response;
  const { messageId, editedContent } = parsed.value;

  const parent = deps.sessionManager.getSession(sessionId);
  if (parent === null) {
    return jsonError('not_found', `Session ${sessionId} not found`, 404);
  }
  // Resolve the parent's project id so the response carries the
  // workspace UUID rather than a raw filesystem path.
  const projectId = deps.workspaceRegistry
    .list()
    .find((w) => w.root === parent.projectRoot)?.id;
  if (projectId === undefined) {
    return jsonError(
      'not_found',
      `No project registered for ${parent.projectRoot}`,
      404,
    );
  }

  let result;
  try {
    result = deps.sessionManager.forkAtMessage(
      sessionId,
      messageId,
      editedContent,
    );
  } catch (err) {
    return jsonError(
      'fork_failed',
      err instanceof Error ? err.message : String(err),
      400,
    );
  }
  deps.workspaceRegistry.touch(projectId);

  const body: ForkAtMessageResponse = {
    session: toSummary(
      result.session,
      projectId,
      deps.sessionManager.getMessageCount(result.session.id),
    ),
    editedMessageId: result.editedMessageId,
  };
  return jsonOk(body, 201);
}
// FORK-AT-MESSAGE-SECTION-END

// ---------- list ----------

function listSessions(url: URL, deps: ApiDeps): Response {
  const projectId = url.searchParams.get('projectId');
  if (projectId === null || projectId.length === 0) {
    return jsonError('invalid_query', 'projectId is required', 400);
  }
  const project = deps.workspaceRegistry.get(projectId);
  if (project === null) {
    return jsonError('not_found', `Project ${projectId} not found`, 404);
  }
  const limit = clampInt(
    url.searchParams.get('limit'),
    SESSIONS_LIST_DEFAULT,
    1,
    SESSIONS_LIST_MAX,
  );

  // SessionManager.listSessions returns the most-recent N globally; pull
  // a generous slice and filter by project root. Long-tail projects
  // with many siblings could miss rows, so we widen the slice when the
  // post-filter set is short.
  //
  // Sub-agent rows (id contains `.agent.`) are excluded here: the
  // runner-factory persists them under a synthetic `<parent>.agent.<id>`
  // id for post-mortem inspection, but they are surfaced in the
  // AgentTeamPanel via agent_* WS frames — they must never appear in
  // the regular per-project session list / sidebar.
  const wide = Math.max(limit * 4, 200);
  const rows = deps.sessionManager.listSessions(wide);
  const filtered = rows
    .filter((s) => s.projectRoot === project.root)
    .filter((s) => !isSubAgentSessionId(s.id))
    .slice(0, limit);

  const sessions: SessionSummaryWire[] = filtered.map((s) =>
    toSummary(s, projectId, deps.sessionManager.getMessageCount(s.id)),
  );
  const body: ListSessionsResponse = { sessions };
  return jsonOk(body);
}

// ---------- create ----------

async function createSession(req: Request, deps: ApiDeps): Promise<Response> {
  const parsed = await parseJsonBody(req, CreateSessionSchema);
  if (!parsed.ok) return parsed.response;
  const { projectId, title, model } = parsed.value;

  const project = deps.workspaceRegistry.get(projectId);
  if (project === null) {
    return jsonError('not_found', `Project ${projectId} not found`, 404);
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

  const chosenModel = model && model.length > 0 ? model : cfg.model.current;
  if (chosenModel.length === 0) {
    return jsonError('invalid_state', 'No model selected in config', 400);
  }

  const session = deps.sessionManager.createSession(
    project.root,
    chosenModel,
    cfg.backend.type,
  );

  if (title !== undefined && title.length > 0) {
    deps.sessionManager.updateTitle(session.id, title);
  }
  deps.workspaceRegistry.touch(projectId);

  const fresh = deps.sessionManager.getSession(session.id) ?? session;
  const body: CreateSessionResponse = {
    session: toSummary(fresh, projectId, 0),
  };
  return jsonOk(body, 201);
}

// ---------- messages ----------

function listMessages(sessionId: string, url: URL, deps: ApiDeps): Response {
  const session = deps.sessionManager.getSession(sessionId);
  if (session === null) {
    return jsonError('not_found', `Session ${sessionId} not found`, 404);
  }
  const limit = clampInt(
    url.searchParams.get('limit'),
    MESSAGES_PAGE_DEFAULT,
    1,
    MESSAGES_PAGE_MAX,
  );
  const cursorRaw = url.searchParams.get('cursor');
  const cursor = cursorRaw !== null && cursorRaw.length > 0 ? cursorRaw : undefined;

  const messages = deps.sessionManager.getMessages(sessionId, { limit, before: cursor });
  // Decide whether more older messages exist. The next cursor is the
  // id of the oldest message in this page; absent when this page
  // already includes the start of history.
  const total = deps.sessionManager.getMessageCount(sessionId);
  const head = messages[0];
  // If we received fewer than `limit` rows AND no `cursor` was given,
  // the dataset is fully covered. Otherwise, decide by comparing what's
  // left strictly older than `head` against the page contents.
  let nextCursor: string | null = null;
  if (head !== undefined) {
    if (cursor === undefined) {
      if (total > messages.length) nextCursor = head.id;
    } else {
      // Cursor in play: another page exists if there are messages older
      // than the current head.
      const older = deps.sessionManager.getMessages(sessionId, {
        limit: 1,
        before: head.id,
      });
      if (older.length > 0) nextCursor = head.id;
    }
  }

  const wireMessages: WireChatMessage[] = messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
    ...(m.toolName !== undefined ? { toolName: m.toolName } : {}),
    createdAt: m.createdAt,
    ...(m.tokensInput !== undefined ? { tokensInput: m.tokensInput } : {}),
    ...(m.tokensOutput !== undefined ? { tokensOutput: m.tokensOutput } : {}),
    ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
  }));

  const body: ListMessagesResponse = { messages: wireMessages, nextCursor };
  return jsonOk(body);
}

// ---------- helpers ----------

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
