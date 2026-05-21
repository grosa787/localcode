/**
 * `Bun.serve` bootstrap for the `--web` mode.
 *
 * Responsibilities:
 *   - generate the per-boot CSRF token,
 *   - probe ports for `[requested, requested+MAX_PORT_PROBES)` until one
 *     binds (handles `EADDRINUSE` when a stale instance is still up),
 *   - mount the dispatcher with the WS handlers Agent C provides,
 *   - print the startup banner with the URL fragment carrying the token,
 *   - optionally `open` the URL in the user's default browser,
 *   - return a `RunningWebApp` handle so the CLI can stop it cleanly on
 *     SIGINT / SIGTERM / SIGHUP.
 *
 * ── Bun WebSocket integration note ────────────────────────────────────
 * Bun's `WebSocketHandler<T>` lives at the SERVER level, not per-socket.
 * Per-socket state has to ride on `ws.data`, which is stamped at upgrade
 * time via `server.upgrade(req, { data })`. To keep this file decoupled
 * from Agent C's WS frame logic, we accept the handler set as an
 * argument: `wsHandlers: WebSocketHandlerSlot`. Agent C populates the
 * slot through the public `startWebApp` wrapper in `src/web/index.ts`,
 * and `dispatch()` uses `upgradeWebSocket` to perform the actual upgrade.
 *
 * The `data` shape itself is opaque to this module — we declare it as
 * `WebSocketAppData` (a generic record) and let Agent C narrow it.
 */

import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';

import { generateCsrfToken } from './csrf';
import { openBrowser } from './open-browser';
import { dispatch, type WsUpgradeOutcome } from './router';

/**
 * Opaque per-socket data type. Agent C declares the real shape in their
 * WS module and casts inside their handlers; the bootstrap only forwards
 * it. We use `unknown` rather than `any` to keep the type system honest:
 * the bootstrap can't read it and shouldn't try.
 */
export type WebSocketAppData = Record<string, unknown>;

/**
 * Slot for Agent C's WS handler set. The `WebSocketHandler<T>` shape comes
 * from `bun-types`. The slot must always provide `message` (Bun's only
 * required field); other handlers are optional.
 */
export type WebSocketHandlerSlot = WebSocketHandler<WebSocketAppData>;

export interface StartWebOptions {
  /** Project root (passed in from the CLI; future: per-workspace override). */
  readonly projectRoot: string;
  /** Bind host. Default `127.0.0.1`. `0.0.0.0` is opt-in via `--web-host`. */
  readonly host?: string;
  /** First port to try. Default `7777`. */
  readonly port?: number;
  /** Auto-open the user's browser on boot. Default `true`. */
  readonly openInBrowser?: boolean;
  /** REST handler. Owned by Agent B; passed via `startWebApp`. */
  readonly handleApi: (req: Request, url: URL) => Promise<Response | null>;
  /**
   * WS upgrade hook — called from the dispatcher when `/ws` is hit.
   * Performs `server.upgrade()` itself and reports the outcome.
   * Owned by Agent C; passed via `startWebApp`.
   */
  readonly upgradeWebSocket: (req: Request, server: Server<WebSocketAppData>) => WsUpgradeOutcome;
  /**
   * Server-level WS handler set. Owned by Agent C; passed via `startWebApp`.
   * If omitted, websockets cannot connect (the dispatcher's upgrade hook
   * will be the one returning a 501).
   */
  readonly wsHandlers?: WebSocketHandlerSlot;
  /**
   * Pre-generated CSRF token. When omitted, the bootstrap generates a
   * fresh one. The integration root (`src/web/index.ts`) supplies one
   * up-front so the WS handlers (which need it for the hello-gate) and
   * the HTTP dispatcher use the same value.
   */
  readonly csrfToken?: string;
}

export interface RunningWebApp {
  /** Full URL with `#token=…` fragment, ready to print or auto-open. */
  readonly url: string;
  /** Bound port (may differ from requested if probing climbed). */
  readonly port: number;
  /** Bound host as passed in. */
  readonly host: string;
  /** Per-boot CSRF token. Tests + the SPA need this. */
  readonly csrfToken: string;
  /** Stops the server. Idempotent — safe to call multiple times. */
  readonly stop: () => Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7777;
/** Number of consecutive ports to try before giving up. */
const MAX_PORT_PROBES = 20;

/**
 * Start the web server. Resolves once the server is listening; the URL
 * has been printed; and the browser-open attempt has either completed or
 * failed (failures are logged but never thrown).
 */
export async function startWebServer(
  opts: StartWebOptions,
): Promise<RunningWebApp> {
  const host = opts.host ?? DEFAULT_HOST;
  const csrfToken = opts.csrfToken ?? generateCsrfToken();
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const wsHandlers: WebSocketHandlerSlot = opts.wsHandlers ?? defaultWsHandlers();

  // Security H3 — loud warning when binding to any non-loopback host.
  // The server has Origin + CSRF gating but the threat model assumes a
  // single trusted user on the loopback interface; binding to `0.0.0.0`
  // or a LAN IP exposes the API + WS to anyone on the local network.
  if (host !== '127.0.0.1') {
    printNonLoopbackWarning(host);
  }

  const { server, port } = bindServer({
    host,
    csrfToken,
    requestedPort,
    handleApi: opts.handleApi,
    upgradeWebSocket: opts.upgradeWebSocket,
    wsHandlers,
  });

  const url = `http://${host}:${port}/#token=${csrfToken}`;
  process.stdout.write(`localcode web: ${url}\n`);

  if (opts.openInBrowser !== false) {
    await openBrowser(url);
  }

  let stopped = false;
  return {
    url,
    port,
    host,
    csrfToken,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      server.stop(true);
    },
  };
}

interface BindParams {
  readonly host: string;
  readonly csrfToken: string;
  readonly requestedPort: number;
  readonly handleApi: StartWebOptions['handleApi'];
  readonly upgradeWebSocket: StartWebOptions['upgradeWebSocket'];
  readonly wsHandlers: WebSocketHandlerSlot;
}

interface BoundServer {
  readonly server: Server<WebSocketAppData>;
  readonly port: number;
}

/**
 * Try to bind on `[requestedPort, requestedPort + MAX_PORT_PROBES)`. The
 * first port that doesn't throw `EADDRINUSE` wins. Any other error
 * propagates immediately (e.g. permission denied on port < 1024).
 */
function bindServer(params: BindParams): BoundServer {
  let lastErr: unknown = null;
  for (let i = 0; i < MAX_PORT_PROBES; i += 1) {
    const candidatePort = params.requestedPort + i;
    try {
      const server = Bun.serve<WebSocketAppData>({
        hostname: params.host,
        port: candidatePort,
        fetch: (req, srv) =>
          dispatch(req, srv, {
            csrfToken: params.csrfToken,
            port: candidatePort,
            handleApi: params.handleApi,
            upgradeWebSocket: params.upgradeWebSocket,
          }),
        websocket: params.wsHandlers,
      });
      return { server, port: candidatePort };
    } catch (e) {
      lastErr = e;
      const code = (e as { code?: string }).code;
      if (code !== 'EADDRINUSE') throw e;
    }
  }
  const detail = lastErr instanceof Error ? `: ${lastErr.message}` : '';
  throw new Error(
    `Could not bind to any port in [${params.requestedPort}, ${params.requestedPort + MAX_PORT_PROBES})${detail}`,
  );
}

/**
 * Print a high-visibility banner to stdout when the server is bound to
 * a non-loopback host (audit H3). Returns nothing — purely diagnostic.
 * Exported separately so we can unit-test the banner text shape without
 * actually starting a server.
 */
export function printNonLoopbackWarning(host: string): void {
  const line = '='.repeat(74);
  const banner = [
    '',
    line,
    `  WARNING: Binding LocalCode web to ${host}.`,
    '  Anyone on the network can reach this server.',
    '  CSRF + Origin gates do NOT prevent local-network attacks against the API.',
    '  Use --web-host 127.0.0.1 for localhost-only (recommended).',
    line,
    '',
  ].join('\n');
  process.stdout.write(banner);
}

/**
 * Fallback WS handler set used when the caller (intentionally or by
 * accident) supplies no real handlers. Closes any incoming socket
 * immediately with a 1011 (internal error) close code so the SPA's
 * reconnect loop can surface a "server not ready" banner.
 *
 * Real handlers are provided by Agent C through `startWebApp`.
 */
function defaultWsHandlers(): WebSocketHandlerSlot {
  return {
    message(ws: ServerWebSocket<WebSocketAppData>) {
      ws.close(1011, 'ws_handlers_not_wired');
    },
    open(ws: ServerWebSocket<WebSocketAppData>) {
      ws.close(1011, 'ws_handlers_not_wired');
    },
  };
}
