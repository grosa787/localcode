/**
 * REST + WebSocket request dispatcher.
 *
 * This module is the thin shell — it owns:
 *   - URL parsing,
 *   - the `/ws` upgrade hand-off,
 *   - origin + CSRF gates on `/api/*`,
 *   - static asset fall-through for everything else.
 *
 * It does NOT own:
 *   - REST handler implementations  (Agent B → `src/web/api/*`),
 *   - WS frame routing / handshake  (Agent C → `src/web/server/ws.ts`).
 *
 * Both are injected via `RouterContext` so this file can compile and ship
 * before B/C land. While B/C are still in flight, the public
 * `startWebApp` (in `src/web/index.ts`) wires temporary 501-stub
 * implementations.
 *
 * Security model:
 *   1. Same-origin gate via `Origin` header check (browsers always set it
 *      on cross-origin/state-changing requests; non-browser clients pass).
 *   2. Per-request CSRF token check on every non-GET REST call.
 *   3. WS handshake validates `Origin` and an in-band `hello` frame —
 *      that lives in Agent C's module; we just ensure the upgrade runs
 *      under the same `/ws` namespace and let Agent C reject early.
 */

import type { Server } from 'bun';

import { SECURITY_HEADERS } from '../api/http';
import { validateCsrfHeader, validateOrigin } from './csrf';
import { serveStatic } from './static';

/**
 * Opaque per-socket data type forwarded through `Server.upgrade()`.
 * Mirrors `WebSocketAppData` in `start.ts` — kept duplicated here to
 * avoid an import cycle (router → start → router).
 */
type WsData = Record<string, unknown>;

/**
 * Result of a WS upgrade attempt. The hook performs `server.upgrade()`
 * itself (Bun's API requires it: the upgrade is in-band on the same
 * Request object) and reports the outcome:
 *
 *   - `'upgraded'` → Bun has taken over the socket; the dispatcher must
 *     NOT return a Response (Bun will fault if a fetch handler returns
 *     after a successful upgrade — instead we return a 101-equivalent).
 *   - `Response` → upgrade refused; the dispatcher returns it verbatim.
 *
 * In Bun, after a successful `server.upgrade(req)` call, the recommended
 * pattern is for the fetch handler to return `undefined` — but our
 * dispatcher signature is `Promise<Response>`, so the WS hook returns a
 * sentinel `Response` with status 101 that we relay. Bun ignores the body
 * after a successful upgrade.
 */
export type WsUpgradeOutcome = 'upgraded' | Response;

/** Injected dependencies. Keeps the dispatcher pure. */
export interface RouterContext {
  /** Per-server CSRF secret. Echoed by the SPA on every non-GET REST. */
  readonly csrfToken: string;
  /** Bound port; used for Origin validation. */
  readonly port: number;
  /**
   * REST handler dispatch. Returns `null` if no route matches (so the
   * router can issue a 404). Owned by Agent B.
   */
  readonly handleApi: (req: Request, url: URL) => Promise<Response | null>;
  /**
   * Perform the WebSocket upgrade. Owned by Agent C. See
   * `WsUpgradeOutcome` above for the contract.
   */
  readonly upgradeWebSocket: (req: Request, server: Server<WsData>) => WsUpgradeOutcome;
}

/** Top-level dispatcher passed to `Bun.serve({ fetch })`. */
export async function dispatch(
  req: Request,
  server: Server<WsData>,
  ctx: RouterContext,
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/ws') {
    return dispatchWebSocket(req, server, ctx);
  }

  if (url.pathname.startsWith('/api/')) {
    return dispatchApi(req, url, ctx);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const staticRes = serveStatic(url.pathname);
    if (staticRes !== null) return staticRes;
    // SPA fallback: any unknown GET path serves index.html so client-side
    // routes (`/projects/<id>/sessions/<id>`) work on hard reload.
    if (req.method === 'GET') {
      const fallback = serveStatic('/index.html');
      if (fallback !== null) return fallback;
    }
  }

  return new Response('Not found', { status: 404 });
}

function dispatchWebSocket(
  req: Request,
  server: Server<WsData>,
  ctx: RouterContext,
): Response {
  if (!validateOrigin(req, ctx.port)) {
    return jsonResponse({ error: 'origin_forbidden' }, 403);
  }
  const outcome = ctx.upgradeWebSocket(req, server);
  if (outcome === 'upgraded') {
    // Bun has taken over the socket. Per the Bun docs, returning a
    // Response after a successful upgrade is harmless — Bun ignores
    // the body. We use 101 for symmetry with the WS handshake.
    return new Response(null, { status: 101 });
  }
  return outcome;
}

async function dispatchApi(
  req: Request,
  url: URL,
  ctx: RouterContext,
): Promise<Response> {
  if (!validateOrigin(req, ctx.port)) {
    return jsonResponse({ error: 'origin_forbidden' }, 403);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!validateCsrfHeader(req, ctx.csrfToken)) {
      return jsonResponse({ error: 'csrf_invalid' }, 403);
    }
  }
  const apiRes = await ctx.handleApi(req, url);
  if (apiRes !== null) return apiRes;
  return jsonResponse({ error: 'not_found' }, 404);
}

function jsonResponse(body: unknown, status: number): Response {
  // Audit bonus — defence-in-depth headers on every JSON envelope,
  // including the router's own 403 / 404 short-circuits.
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
    },
  });
}
