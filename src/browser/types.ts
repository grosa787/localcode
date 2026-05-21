/**
 * Shared types for the headless-Chromium browser sandbox.
 *
 * One `BrowserSession` per chat session; controlled via Playwright; exposed
 * to the LLM as eight `browser_*` tools and to the web frontend as a stream
 * of screencast frames + cursor + console events.
 *
 * The shape here is the load-bearing interface contract between Agent 1
 * (this module) and Agent 2 (web protocol / chat-runtime). Do not change
 * field names without coordinating.
 */

/** A single screencast frame, captured via CDP `Page.screencastFrame`. */
export interface BrowserScreencastFrame {
  /** Base64-encoded JPEG payload (no `data:` prefix). */
  jpegBase64: string;
  /** Frame width in CSS pixels. */
  width: number;
  /** Frame height in CSS pixels. */
  height: number;
  /** Wall-clock timestamp (ms since epoch) at which the frame was captured. */
  capturedAt: number;
}

/**
 * Cursor animation hint — emitted before a click/hover/type so the
 * frontend can animate a virtual cursor between two points.
 */
export interface BrowserCursorEvent {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Animation duration hint in milliseconds. */
  durationMs: number;
  action: 'click' | 'hover' | 'type';
}

/** A single console message captured from the page. */
export interface BrowserConsoleEvent {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  /** Page URL at the time of the message, when known. */
  source?: string;
  /** 1-based line number in the source script, when known. */
  line?: number;
}

/** Subscription bag passed to `BrowserSession.subscribe`. */
export interface BrowserSessionEvents {
  onFrame?: (frame: BrowserScreencastFrame) => void;
  onCursor?: (event: BrowserCursorEvent) => void;
  onConsole?: (event: BrowserConsoleEvent) => void;
  onError?: (err: Error) => void;
}

/** Construction options for `createBrowserSession`. */
export interface BrowserSessionOptions {
  /**
   * Allowed host patterns for `navigate()`. Defaults to localhost-only.
   * Patterns may be plain hostnames (`localhost`, `127.0.0.1`),
   * wildcard subdomains (`*.local`), or the literal `file://` to allow
   * local file URLs.
   */
  allowDomains?: readonly string[];
  /** Headless mode; defaults to `true`. */
  headless?: boolean;
  /** Viewport size; defaults to 1280x720. */
  viewport?: { width: number; height: number };
  /**
   * Optional injection point for tests — accepts a Playwright-shaped
   * launcher with `chromium.launch(...)`. When omitted, the real
   * Playwright `chromium` import is used lazily on first `start()`.
   */
  launcher?: BrowserLauncher;
}

/**
 * Subset of Playwright's `chromium` namespace we depend on. Tests inject
 * a fake launcher so `start()` can be exercised without downloading
 * Chromium.
 */
export interface BrowserLauncher {
  launch: (opts: { headless: boolean }) => Promise<LaunchedBrowser>;
}

export interface LaunchedBrowser {
  newContext: (opts: {
    viewport: { width: number; height: number };
  }) => Promise<LaunchedContext>;
  close: () => Promise<void>;
}

export interface LaunchedContext {
  newPage: () => Promise<LaunchedPage>;
  newCDPSession: (page: LaunchedPage) => Promise<LaunchedCDPSession>;
  close?: () => Promise<void>;
}

export interface LaunchedPage {
  goto: (url: string, opts?: { timeout?: number }) => Promise<unknown>;
  title: () => Promise<string>;
  url: () => string;
  reload: () => Promise<unknown>;
  screenshot: (opts?: { type?: 'png' | 'jpeg' }) => Promise<Buffer | Uint8Array>;
  click: (selector: string) => Promise<void>;
  fill: (selector: string, value: string) => Promise<void>;
  evaluate: <T = unknown>(js: string) => Promise<T>;
  on: (event: 'console' | 'pageerror', handler: (ev: unknown) => void) => void;
  mouse: {
    click: (x: number, y: number) => Promise<void>;
    move: (x: number, y: number) => Promise<void>;
  };
  keyboard: {
    press: (key: string) => Promise<void>;
    type: (text: string) => Promise<void>;
  };
  viewportSize: () => { width: number; height: number } | null;
}

export interface LaunchedCDPSession {
  send: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
  on: (event: string, handler: (params: unknown) => void) => void;
  detach?: () => Promise<void>;
}

/** Tool-call return shapes (used by browser/tools.ts). */
export interface BrowserNavigateResult {
  url: string;
  title: string;
}

export interface BrowserScreenshotResult {
  pngBase64: string;
  width: number;
  height: number;
}

export interface BrowserClickArgs {
  selector?: string;
  x?: number;
  y?: number;
}

export interface BrowserTypeArgs {
  selector: string;
  text: string;
}

/** Public session handle. */
export interface BrowserSession {
  start(): Promise<void>;
  subscribe(events: BrowserSessionEvents): () => void;
  forwardUserClick(x: number, y: number): Promise<void>;
  forwardUserKey(key: string): Promise<void>;
  navigate(url: string): Promise<BrowserNavigateResult>;
  screenshot(): Promise<BrowserScreenshotResult>;
  click(args: BrowserClickArgs): Promise<{ ok: boolean }>;
  type(args: BrowserTypeArgs): Promise<{ ok: boolean }>;
  pressKey(key: string): Promise<{ ok: boolean }>;
  evaluate(js: string): Promise<{ result: unknown }>;
  consoleMessages(): BrowserConsoleEvent[];
  reload(): Promise<{ url: string }>;
  close(): Promise<void>;
}

/**
 * Default allowlist — local-only by design.
 *
 * `file://` is intentionally NOT included: a model with browser access
 * could otherwise read arbitrary local files (e.g.
 * `file:///etc/passwd`, dotfiles, SSH keys) and pull their contents
 * into the chat via `browser_evaluate`. Callers who genuinely need
 * `file://` URLs must opt in by passing `allowDomains: ['file://']`
 * (or `['file://', ...]`) explicitly when constructing the session.
 */
export const DEFAULT_ALLOW_DOMAINS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '*.local',
];
