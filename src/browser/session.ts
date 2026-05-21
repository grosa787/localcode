/**
 * BrowserSession — a single headless Chromium controlled via Playwright,
 * scoped to one chat session. Lazily launches Chromium on the first tool
 * call. Streams screencast frames and console events to subscribers.
 *
 * The CDP screencast hook lives in `attachScreencast()`. We open a CDP
 * session, send `Page.startScreencast` (jpeg, q=70, every 6th frame ~10
 * fps at 60), and forward each `Page.screencastFrame` event to every
 * subscriber's `onFrame` callback before ack-ing the frame.
 *
 * Domain allowlist is enforced inside `navigate()`. Unknown hosts throw
 * with a message that explains how to extend the list.
 */

import {
  DEFAULT_ALLOW_DOMAINS,
  type BrowserClickArgs,
  type BrowserConsoleEvent,
  type BrowserCursorEvent,
  type BrowserLauncher,
  type BrowserNavigateResult,
  type BrowserScreencastFrame,
  type BrowserScreenshotResult,
  type BrowserSession,
  type BrowserSessionEvents,
  type BrowserSessionOptions,
  type BrowserTypeArgs,
  type LaunchedBrowser,
  type LaunchedCDPSession,
  type LaunchedContext,
  type LaunchedPage,
} from './types';

const CONSOLE_BUFFER_MAX = 200;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;
const SCREENCAST_EVERY_NTH = 6;
const SCREENCAST_QUALITY = 70;

/**
 * Lazy-load the real Playwright `chromium` namespace. Wrapped in a
 * function so tests that pass `launcher` never trigger the import (and
 * therefore never need Chromium downloaded).
 */
async function loadDefaultLauncher(): Promise<BrowserLauncher> {
  try {
    // Dynamic import keeps Playwright optional at module load time.
    const mod = (await import('playwright')) as unknown as {
      chromium: BrowserLauncher;
    };
    return mod.chromium;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load Playwright. Install the dep with "bun install" and the browser with "bunx playwright install chromium" to enable browser tools. (${msg})`,
    );
  }
}

/** Pull the host out of a URL for allowlist checks. */
function hostOf(url: string): string {
  if (url.startsWith('file://')) return 'file://';
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Match a host against an allowlist entry. Entries may be:
 *   - `'file://'`           → matches `file://` URLs only
 *   - `'localhost'`         → exact host match
 *   - `'127.0.0.1'`         → exact host match (port suffix tolerated)
 *   - `'*.local'`           → wildcard subdomain match
 */
function matchesAllow(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p === 'file://') return host === 'file://';
  // Tolerate `host:port` in either side; compare on hostname only.
  const h = host.split(':')[0] ?? '';
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".local"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

class BrowserSessionImpl implements BrowserSession {
  private readonly options: Required<
    Pick<BrowserSessionOptions, 'allowDomains' | 'headless' | 'viewport'>
  >;
  private readonly launcherOverride: BrowserLauncher | undefined;

  private startPromise: Promise<void> | null = null;
  private browser: LaunchedBrowser | null = null;
  private context: LaunchedContext | null = null;
  private page: LaunchedPage | null = null;
  private cdp: LaunchedCDPSession | null = null;
  private closed = false;
  private lastCursor: { x: number; y: number } = { x: 0, y: 0 };
  private readonly consoleBuffer: BrowserConsoleEvent[] = [];
  private readonly subscribers = new Set<BrowserSessionEvents>();
  private lastFrame: BrowserScreencastFrame | null = null;

  constructor(opts: BrowserSessionOptions) {
    this.options = {
      allowDomains: opts.allowDomains ?? DEFAULT_ALLOW_DOMAINS,
      headless: opts.headless ?? true,
      viewport: opts.viewport ?? DEFAULT_VIEWPORT,
    };
    this.launcherOverride = opts.launcher;
  }

  /** Idempotent — concurrent callers share the same launch promise. */
  async start(): Promise<void> {
    if (this.closed) {
      throw new Error('BrowserSession is closed; create a new one.');
    }
    if (this.startPromise === null) {
      this.startPromise = this.bootstrap();
    }
    return this.startPromise;
  }

  private async bootstrap(): Promise<void> {
    const launcher =
      this.launcherOverride ?? (await loadDefaultLauncher());
    this.browser = await launcher.launch({ headless: this.options.headless });
    this.context = await this.browser.newContext({
      viewport: this.options.viewport,
    });
    this.page = await this.context.newPage();
    this.attachConsole(this.page);
    await this.attachScreencast(this.context, this.page);
  }

  private attachConsole(page: LaunchedPage): void {
    page.on('console', (ev: unknown) => {
      const event = this.normaliseConsoleEvent(ev);
      this.pushConsole(event);
    });
    page.on('pageerror', (ev: unknown) => {
      const text = ev instanceof Error ? ev.message : String(ev);
      this.pushConsole({ level: 'error', text, source: this.urlSafe() });
    });
  }

  private normaliseConsoleEvent(ev: unknown): BrowserConsoleEvent {
    // Playwright's ConsoleMessage has `.type()`, `.text()`, optional `.location()`.
    const e = ev as {
      type?: () => string;
      text?: () => string;
      location?: () => { url?: string; lineNumber?: number };
    };
    const rawType = typeof e.type === 'function' ? e.type() : 'log';
    const text = typeof e.text === 'function' ? e.text() : String(ev);
    const loc =
      typeof e.location === 'function' ? e.location() : undefined;
    const level = mapConsoleLevel(rawType);
    const out: BrowserConsoleEvent = { level, text };
    if (loc?.url) out.source = loc.url;
    if (typeof loc?.lineNumber === 'number') out.line = loc.lineNumber;
    return out;
  }

  private pushConsole(event: BrowserConsoleEvent): void {
    this.consoleBuffer.push(event);
    if (this.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
      this.consoleBuffer.splice(
        0,
        this.consoleBuffer.length - CONSOLE_BUFFER_MAX,
      );
    }
    for (const sub of this.subscribers) {
      try {
        sub.onConsole?.(event);
      } catch (err) {
        this.emitError(err);
      }
    }
  }

  /**
   * Start CDP `Page.startScreencast` and forward each frame to subscribers.
   * Errors are routed to `onError`; we never throw from the listener.
   */
  private async attachScreencast(
    context: LaunchedContext,
    page: LaunchedPage,
  ): Promise<void> {
    let cdp: LaunchedCDPSession;
    try {
      cdp = await context.newCDPSession(page);
    } catch (err) {
      // Some test launchers may not support CDP; soft-fail.
      this.emitError(err);
      return;
    }
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (params: unknown) => {
      void this.handleScreencastFrame(cdp, params);
    });
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: SCREENCAST_QUALITY,
        everyNthFrame: SCREENCAST_EVERY_NTH,
      });
    } catch (err) {
      this.emitError(err);
    }
  }

  private async handleScreencastFrame(
    cdp: LaunchedCDPSession,
    params: unknown,
  ): Promise<void> {
    const p = params as {
      data?: string;
      sessionId?: number;
      metadata?: { deviceWidth?: number; deviceHeight?: number };
    };
    if (typeof p.data !== 'string' || p.data.length === 0) {
      return;
    }
    const frame: BrowserScreencastFrame = {
      jpegBase64: p.data,
      width: p.metadata?.deviceWidth ?? this.options.viewport.width,
      height: p.metadata?.deviceHeight ?? this.options.viewport.height,
      capturedAt: Date.now(),
    };
    this.lastFrame = frame;
    for (const sub of this.subscribers) {
      try {
        sub.onFrame?.(frame);
      } catch (err) {
        this.emitError(err);
      }
    }
    if (typeof p.sessionId === 'number') {
      try {
        await cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId });
      } catch (err) {
        this.emitError(err);
      }
    }
  }

  subscribe(events: BrowserSessionEvents): () => void {
    this.subscribers.add(events);
    // Replay last frame so a late subscriber sees something immediately.
    if (this.lastFrame !== null && events.onFrame !== undefined) {
      try {
        events.onFrame(this.lastFrame);
      } catch (err) {
        this.emitError(err);
      }
    }
    return () => {
      this.subscribers.delete(events);
    };
  }

  async forwardUserClick(x: number, y: number): Promise<void> {
    const page = await this.requirePage();
    this.emitCursor({
      fromX: this.lastCursor.x,
      fromY: this.lastCursor.y,
      toX: x,
      toY: y,
      durationMs: 200,
      action: 'click',
    });
    this.lastCursor = { x, y };
    await page.mouse.click(x, y);
  }

  async forwardUserKey(key: string): Promise<void> {
    const page = await this.requirePage();
    await page.keyboard.press(key);
  }

  async navigate(url: string): Promise<BrowserNavigateResult> {
    this.assertHostAllowed(url);
    const page = await this.requirePage();
    await page.goto(url, { timeout: 30_000 });
    return { url: page.url(), title: await page.title() };
  }

  async screenshot(): Promise<BrowserScreenshotResult> {
    const page = await this.requirePage();
    // Force fresh capture (separate from the ongoing screencast cache).
    const buf = await page.screenshot({ type: 'png' });
    const bytes =
      buf instanceof Uint8Array ? Buffer.from(buf) : Buffer.from(buf);
    const size = page.viewportSize() ?? this.options.viewport;
    return {
      pngBase64: bytes.toString('base64'),
      width: size.width,
      height: size.height,
    };
  }

  async click(args: BrowserClickArgs): Promise<{ ok: boolean }> {
    const page = await this.requirePage();
    if (typeof args.selector === 'string' && args.selector.length > 0) {
      this.emitCursor({
        fromX: this.lastCursor.x,
        fromY: this.lastCursor.y,
        toX: this.lastCursor.x,
        toY: this.lastCursor.y,
        durationMs: 200,
        action: 'click',
      });
      await page.click(args.selector);
      return { ok: true };
    }
    if (typeof args.x === 'number' && typeof args.y === 'number') {
      this.emitCursor({
        fromX: this.lastCursor.x,
        fromY: this.lastCursor.y,
        toX: args.x,
        toY: args.y,
        durationMs: 200,
        action: 'click',
      });
      this.lastCursor = { x: args.x, y: args.y };
      await page.mouse.click(args.x, args.y);
      return { ok: true };
    }
    throw new Error('click requires either selector or {x, y}');
  }

  async type(args: BrowserTypeArgs): Promise<{ ok: boolean }> {
    const page = await this.requirePage();
    this.emitCursor({
      fromX: this.lastCursor.x,
      fromY: this.lastCursor.y,
      toX: this.lastCursor.x,
      toY: this.lastCursor.y,
      durationMs: 100,
      action: 'type',
    });
    await page.fill(args.selector, args.text);
    return { ok: true };
  }

  async pressKey(key: string): Promise<{ ok: boolean }> {
    const page = await this.requirePage();
    await page.keyboard.press(key);
    return { ok: true };
  }

  async evaluate(js: string): Promise<{ result: unknown }> {
    const page = await this.requirePage();
    const result = await page.evaluate<unknown>(js);
    return { result };
  }

  consoleMessages(): BrowserConsoleEvent[] {
    return this.consoleBuffer.slice();
  }

  async reload(): Promise<{ url: string }> {
    const page = await this.requirePage();
    await page.reload();
    return { url: page.url() };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.subscribers.clear();
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp !== null) {
      try {
        await cdp.send('Page.stopScreencast');
      } catch {
        // best-effort
      }
      try {
        await cdp.detach?.();
      } catch {
        // best-effort
      }
    }
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    if (browser !== null) {
      try {
        await browser.close();
      } catch {
        // best-effort
      }
    }
  }

  // ---------- Internals ----------

  private async requirePage(): Promise<LaunchedPage> {
    await this.start();
    if (this.page === null) {
      throw new Error('BrowserSession failed to initialise: no page');
    }
    return this.page;
  }

  private assertHostAllowed(url: string): void {
    const host = hostOf(url);
    if (host.length === 0) {
      throw new Error(
        `Invalid URL '${url}'. Browser tools require an absolute http(s):// or file:// URL.`,
      );
    }
    for (const pattern of this.options.allowDomains) {
      if (matchesAllow(host, pattern)) return;
    }
    throw new Error(
      `Host '${host}' is not in the browser allowlist (${this.options.allowDomains.join(', ')}). ` +
        `To extend, pass allowDomains to createBrowserSession or set config.browser.allowDomains.`,
    );
  }

  private emitCursor(event: BrowserCursorEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub.onCursor?.(event);
      } catch (err) {
        this.emitError(err);
      }
    }
  }

  private emitError(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    for (const sub of this.subscribers) {
      try {
        sub.onError?.(e);
      } catch {
        // swallow nested errors from error handlers
      }
    }
  }

  private urlSafe(): string {
    try {
      return this.page?.url() ?? '';
    } catch {
      return '';
    }
  }
}

function mapConsoleLevel(raw: string): BrowserConsoleEvent['level'] {
  const lower = raw.toLowerCase();
  if (lower === 'warn' || lower === 'warning') return 'warn';
  if (lower === 'error') return 'error';
  if (lower === 'info') return 'info';
  if (lower === 'debug' || lower === 'verbose') return 'debug';
  return 'log';
}

/** Public factory. Does NOT spawn Chromium — call `start()` to launch. */
export function createBrowserSession(
  opts: BrowserSessionOptions = {},
): BrowserSession {
  return new BrowserSessionImpl(opts);
}
