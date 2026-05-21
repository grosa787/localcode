/**
 * Module-level singleton wrapping `startWebApp` so the TUI's `/web`
 * slash command can boot (and re-resolve) an in-process web server
 * idempotently.
 *
 * Both the TUI and the embedded web server end up reading/writing the
 * same SQLite database via the process-wide `SessionManager` singleton
 * (see `src/sessions/db.ts`). WAL + `busy_timeout=5000` + the shared
 * cache mean concurrent readers/writers in one process don't lock each
 * other out, so the user's TUI chat and the browser window stay in sync
 * without any extra plumbing.
 *
 * Lifecycle:
 *   - First call: spins up the server, caches the handle.
 *   - Subsequent calls (any sessionId): reuse the cached handle, swap
 *     in a fresh session fragment so the URL re-focuses the current
 *     TUI session in the browser.
 *   - `stopWebServer()` tears everything down; the next launch starts
 *     fresh.
 */

import { startWebApp, type RunningWebApp } from './index';

interface CachedHandle {
  readonly running: RunningWebApp;
  /**
   * Original URL produced by `startWebApp` (`http://host:port/#token=…`).
   * The session fragment is appended on each `ensureWebServerStarted`
   * call so the SPA's `WEB-SESSION-AUTOLOAD-SECTION` can resume.
   */
  readonly baseUrlWithToken: string;
}

let handle: CachedHandle | null = null;
let bootInFlight: Promise<CachedHandle> | null = null;

export interface EnsureWebServerOptions {
  readonly projectRoot: string;
  readonly sessionId: string | null;
}

export interface EnsureWebServerResult {
  /** Full URL including `#token=…&session=<id>` when a session was provided. */
  readonly url: string;
  /** Idempotent stop — calling this twice does not throw. */
  readonly stop: () => Promise<void>;
}

/**
 * Start the web server (if not already running) and return a URL the
 * caller can hand to a browser opener. The URL embeds the per-boot CSRF
 * token AND, when supplied, a `&session=<id>` parameter the SPA reads on
 * bootstrap to auto-resume the TUI's current session.
 */
export async function ensureWebServerStarted(
  opts: EnsureWebServerOptions,
): Promise<EnsureWebServerResult> {
  const existing = handle;
  if (existing !== null) {
    return {
      url: appendSessionFragment(existing.baseUrlWithToken, opts.sessionId),
      stop: stopWebServer,
    };
  }
  // De-dupe concurrent `/web` invocations — there could be only one
  // user typing on the TUI, but tests + future automation might race.
  if (bootInFlight !== null) {
    const booted = await bootInFlight;
    return {
      url: appendSessionFragment(booted.baseUrlWithToken, opts.sessionId),
      stop: stopWebServer,
    };
  }
  bootInFlight = (async (): Promise<CachedHandle> => {
    // `openInBrowser: false` — the `/web` command itself drives the
    // browser open after printing the public URL into the chat log so
    // the user sees the URL even if their default-browser invocation
    // silently fails.
    const running = await startWebApp({
      projectRoot: opts.projectRoot,
      openInBrowser: false,
    });
    const cached: CachedHandle = {
      running,
      baseUrlWithToken: running.url,
    };
    handle = cached;
    return cached;
  })();
  try {
    const booted = await bootInFlight;
    return {
      url: appendSessionFragment(booted.baseUrlWithToken, opts.sessionId),
      stop: stopWebServer,
    };
  } finally {
    bootInFlight = null;
  }
}

/**
 * Tear down the cached server (if any). Idempotent.
 */
export async function stopWebServer(): Promise<void> {
  const existing = handle;
  if (existing === null) return;
  handle = null;
  try {
    await existing.running.stop();
  } catch {
    // Best-effort — even if stop() throws (port already gone, etc.)
    // we've already cleared the handle so a follow-up `/web` re-boots.
  }
}

/**
 * Returns the URL currently in use (with fresh session fragment) when
 * the server is running, or `null` otherwise. Test/debug helper.
 */
export function currentWebUrl(sessionId: string | null): string | null {
  if (handle === null) return null;
  return appendSessionFragment(handle.baseUrlWithToken, sessionId);
}

/**
 * Insert a `&session=<id>` parameter into the URL fragment alongside the
 * existing `#token=…`. The SPA splits the fragment on `&` and consumes
 * both pieces. Leaves a fragmentless URL alone (defensive — production
 * `startWebApp` always supplies the token).
 */
function appendSessionFragment(url: string, sessionId: string | null): string {
  if (sessionId === null || sessionId.length === 0) return url;
  const hashIdx = url.indexOf('#');
  if (hashIdx === -1) return `${url}#session=${encodeURIComponent(sessionId)}`;
  const fragment = url.slice(hashIdx + 1);
  // Avoid stamping the same session twice if the caller re-invokes.
  const filtered = fragment
    .split('&')
    .filter((p) => !p.startsWith('session='))
    .join('&');
  const next = filtered.length > 0
    ? `${filtered}&session=${encodeURIComponent(sessionId)}`
    : `session=${encodeURIComponent(sessionId)}`;
  return `${url.slice(0, hashIdx)}#${next}`;
}

/**
 * Test-only — reset the singleton so subsequent ensureWebServerStarted
 * calls start from scratch. Intentionally not re-exported through the
 * `@/web` barrel; tests import this file directly.
 */
export function _resetForTests(): void {
  handle = null;
  bootInFlight = null;
}
