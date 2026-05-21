/**
 * Typed WebSocket client for the LocalCode `--web` SPA.
 *
 * Responsibilities:
 *   - Auto-reconnect with exponential backoff (cap 30s).
 *   - Send `hello` on every (re)connection so server can re-auth.
 *   - Validate incoming frames with `WSServerMessageSchema`.
 *   - Heartbeat (ping every 25s; force-reconnect if no pong in 10s).
 *   - Promise-based `request()` helper for response correlation.
 *
 * --------------------------------------------------------------------
 * NOTE on imports — Agent E / Phase 0 caveat
 * --------------------------------------------------------------------
 * This file lives in `web-frontend/`, which Agent D will scaffold as a
 * separate Vite project with its own `tsconfig.json` and a path alias
 * pointing back at `../src/web/protocol/`. Until that scaffolding lands
 * the file is dormant: the root `tsconfig.json` does not include
 * `web-frontend/` and the build pipeline does not pick it up.
 *
 * Until the alias is set up we use a relative import. Agent D will
 * either keep the relative path or switch to the alias — both work
 * because the source of truth is `src/web/protocol/messages.ts`.
 */

import {
  WSServerMessageSchema,
  type WSClientMessage,
  type WSServerMessage,
  type WSConnectionState,
} from '../../../src/web/protocol/messages.js';

/** Stored under this key in `sessionStorage` so a tab keeps the same id across reconnects. */
const CLIENT_ID_STORAGE_KEY = 'localcode.web.clientId';

/** Outbound queue cap — prevents unbounded growth while the socket is closed. */
const MAX_QUEUED_MESSAGES = 100;

/** Initial backoff before the first reconnect attempt. */
const INITIAL_BACKOFF_MS = 250;

/** Hard cap on reconnect backoff. */
const MAX_BACKOFF_MS = 30_000;

/** How often we send a `ping` while the socket is open. */
const PING_INTERVAL_MS = 25_000;

/** How long we wait for a `pong` after a ping before forcing a reconnect. */
const PONG_TIMEOUT_MS = 10_000;

/** Default request() timeout. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface WSClientOptions {
  url: string;
  csrf: string;
  onMessage: (msg: WSServerMessage) => void;
  onConnectionChange: (state: WSConnectionState) => void;
  /**
   * Fired exactly once per WSClient instance when the upgrade handler
   * rejects our CSRF (server closes with code 1008 + reason
   * `csrf_invalid`). The App uses this to flip the global
   * `authError` state and stop the reconnect storm.
   */
  onAuthRejected?: (reason: string) => void;
}

/**
 * Generate (or retrieve) a stable client id for this browser tab. Stored
 * in `sessionStorage` so it survives full page reloads but a new tab
 * always gets a fresh id — exactly the multi-tab semantics the server
 * relies on for "first response wins" approval handling.
 */
function getOrCreateClientId(): string {
  // Defensive: `sessionStorage` may be missing in non-browser environments
  // (SSR, tests). Fall back to an ephemeral random id in that case.
  if (typeof sessionStorage === 'undefined') {
    return generateRandomId();
  }
  const existing = sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (existing !== null && existing.length > 0) {
    return existing;
  }
  const fresh = generateRandomId();
  try {
    sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, fresh);
  } catch {
    // Storage may be full or disabled. Still safe to use the id; the
    // tab simply won't preserve it across reloads.
  }
  return fresh;
}

function generateRandomId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  // Fallback: 16 random bytes as hex.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

interface PendingRequest<R extends WSServerMessage> {
  expectedType: R['type'];
  matchPredicate: ((m: R) => boolean) | undefined;
  resolve: (msg: R) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WSClient {
  private readonly options: WSClientOptions;
  private readonly clientId: string;

  private socket: WebSocket | null = null;
  private state: WSConnectionState = 'connecting';

  private outbound: WSClientMessage[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  private pending: Array<PendingRequest<WSServerMessage>> = [];

  /** Set when `close()` is called explicitly so reconnects stop. */
  private disposed = false;

  /**
   * Set when the server closes with `csrf_invalid`. We must stop
   * reconnecting (otherwise we hammer the upgrade handler) and we
   * surface the rejection exactly once via `onAuthRejected`.
   */
  private authRejected = false;

  constructor(options: WSClientOptions) {
    this.options = options;
    this.clientId = getOrCreateClientId();
    this.connect();
  }

  // ---------- Public API ----------

  /**
   * Send a message. If the socket is not currently open, queue up to
   * `MAX_QUEUED_MESSAGES` for replay on the next successful connection.
   * Beyond the cap we drop oldest-first to keep the user's most recent
   * intent rather than a backlog of stale subscribes.
   */
  send(msg: WSClientMessage): void {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
      return;
    }
    if (this.outbound.length >= MAX_QUEUED_MESSAGES) {
      this.outbound.shift();
    }
    this.outbound.push(msg);
  }

  /**
   * Send a request and resolve with the first matching server message
   * of `expectedType` (optionally narrowed by `matchPredicate`). Used
   * for round-trips like `subscribe_session` → wait for `subscribed`.
   *
   * @throws Error on timeout, on connection close before resolution, or
   *         on protocol-level error frames matching the request.
   */
  request<R extends WSServerMessage>(
    msg: WSClientMessage,
    expectedType: R['type'],
    matchPredicate?: (m: R) => boolean,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Variance cast — same rationale as the array push below.
        this.removePending(pending as unknown as PendingRequest<WSServerMessage>);
        reject(new Error(`WS request timed out after ${timeoutMs}ms (expected ${expectedType})`));
      }, timeoutMs);

      const pending: PendingRequest<R> = {
        expectedType,
        matchPredicate,
        resolve,
        reject,
        timer,
      };
      // Cast: we narrow at delivery time via `expectedType`. Without
      // this the variance on `R` makes the array-push fail.
      this.pending.push(pending as unknown as PendingRequest<WSServerMessage>);

      this.send(msg);
    });
  }

  /** Close the socket and stop reconnecting. Idempotent. */
  close(): void {
    this.disposed = true;
    this.clearTimers();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket !== null) {
      try {
        this.socket.close();
      } catch {
        // Socket may already be closing/closed.
      }
      this.socket = null;
    }
    // Reject any pending requests.
    for (const p of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('WSClient disposed'));
    }
    this.pending = [];
  }

  // ---------- Internals ----------

  private connect(): void {
    if (this.disposed) return;

    this.setState(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch (err) {
      // URL parsing failure — surface as closed and retry with backoff.
      this.handleSocketFailure(err);
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.disposed) {
        socket.close();
        return;
      }
      this.reconnectAttempt = 0;
      this.setState('open');
      // Re-authenticate every connection — after a reconnect the server
      // has no idea we were ever there.
      socket.send(
        JSON.stringify({
          type: 'hello',
          csrf: this.options.csrf,
          clientId: this.clientId,
        } satisfies WSClientMessage),
      );
      // Drain queued messages.
      while (this.outbound.length > 0) {
        const queued = this.outbound.shift();
        if (queued !== undefined) {
          socket.send(JSON.stringify(queued));
        }
      }
      this.startHeartbeat();
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      this.handleRawFrame(event.data);
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      if (this.disposed) return;
      this.clearTimers();
      this.socket = null;
      // Server policy-violation closes carry the upgrade-handler reason
      // verbatim. `csrf_invalid` is the canonical "stale token" signal —
      // surface it once and stop the reconnect loop so the App can show
      // the recovery banner without flicker.
      if (
        event.code === 1008 &&
        typeof event.reason === 'string' &&
        event.reason === 'csrf_invalid'
      ) {
        this.handleAuthRejection(event.reason);
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // The browser will fire a `close` after `error`; we let that
      // path drive the reconnect to avoid double-scheduling.
    });
  }

  private handleRawFrame(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
    } catch {
      this.bailOnDrift('non-JSON frame');
      return;
    }
    const result = WSServerMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.bailOnDrift(`schema mismatch: ${result.error.message}`);
      return;
    }
    const msg = result.data;

    // Heartbeat handling first — pong cancels the timeout.
    if (msg.type === 'pong') {
      if (this.pongTimer !== null) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      // Pongs are infrastructure — don't surface to the consumer.
      return;
    }

    // Resolve any awaiting `request()` calls.
    this.tryResolvePending(msg);

    this.options.onMessage(msg);
  }

  private tryResolvePending(msg: WSServerMessage): void {
    if (this.pending.length === 0) return;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p === undefined) continue;
      if (p.expectedType !== msg.type) continue;
      if (p.matchPredicate !== undefined && !p.matchPredicate(msg)) continue;
      clearTimeout(p.timer);
      this.pending.splice(i, 1);
      p.resolve(msg);
      return;
    }
  }

  private removePending(target: PendingRequest<WSServerMessage>): void {
    const idx = this.pending.indexOf(target);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
    }
  }

  private bailOnDrift(why: string): void {
    // Surface drift via the connection-state callback so the UI can
    // render an actionable banner. The frontend interprets `closed`
    // (not `reconnecting`) as terminal until a manual retry.
    this.setState('closed');
    this.disposed = true;
    if (this.socket !== null) {
      try {
        this.socket.close();
      } catch {
        // Already closed.
      }
      this.socket = null;
    }
    this.clearTimers();
    // We log to the console rather than throwing — the consumer's
    // onConnectionChange is the canonical signal.
    // eslint-disable-next-line no-console
    console.error('[WSClient] aborting on protocol drift:', why);
  }

  private handleSocketFailure(err: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[WSClient] socket construction failed:', err);
    this.scheduleReconnect();
  }

  private handleAuthRejection(reason: string): void {
    if (this.authRejected) return;
    this.authRejected = true;
    this.disposed = true; // permanently stop reconnects
    this.setState('closed');
    if (this.options.onAuthRejected !== undefined) {
      try {
        this.options.onAuthRejected(reason);
      } catch {
        // Subscriber must be defensive; we don't propagate.
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.authRejected) return;
    this.setState('reconnecting');
    this.reconnectAttempt += 1;
    const delay = Math.min(
      MAX_BACKOFF_MS,
      INITIAL_BACKOFF_MS * 2 ** (this.reconnectAttempt - 1),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      this.socket.send(JSON.stringify({ type: 'ping' } satisfies WSClientMessage));
      // Arm pong timeout — if it fires, force-reconnect.
      if (this.pongTimer !== null) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.socket !== null) {
          try {
            this.socket.close();
          } catch {
            // Best effort.
          }
        }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private setState(next: WSConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onConnectionChange(next);
  }
}
