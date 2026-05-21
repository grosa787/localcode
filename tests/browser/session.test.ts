/**
 * Unit tests for `BrowserSession` — exercise the public surface without
 * launching a real Chromium. We inject a fake `BrowserLauncher` that
 * mimics the slice of Playwright we depend on (see
 * `src/browser/types.ts` → `LaunchedBrowser` etc.).
 *
 * The integration test at the bottom only runs when
 * `LOCALCODE_E2E_BROWSER=1` so CI doesn't try to download Chromium.
 */

import { describe, expect, test } from 'bun:test';

import { createBrowserSession } from '@/browser/session';
import type {
  BrowserLauncher,
  LaunchedBrowser,
  LaunchedCDPSession,
  LaunchedContext,
  LaunchedPage,
} from '@/browser/types';

interface PageState {
  url: string;
  title: string;
  consoleHandlers: Array<(ev: unknown) => void>;
  pageErrorHandlers: Array<(ev: unknown) => void>;
}

interface CdpState {
  sent: Array<{ method: string; params?: Record<string, unknown> }>;
  frameHandlers: Array<(p: unknown) => void>;
}

function buildFakeLauncher(): {
  launcher: BrowserLauncher;
  page: PageState;
  cdp: CdpState;
} {
  const page: PageState = {
    url: 'about:blank',
    title: '',
    consoleHandlers: [],
    pageErrorHandlers: [],
  };
  const cdp: CdpState = { sent: [], frameHandlers: [] };

  const fakePage: LaunchedPage = {
    goto: async (u) => {
      page.url = u;
      page.title = `title-of-${u}`;
      return undefined;
    },
    title: async () => page.title,
    url: () => page.url,
    reload: async () => undefined,
    screenshot: async () => Buffer.from('PNGBYTES'),
    click: async () => undefined,
    fill: async () => undefined,
    evaluate: async <T>(_js: string): Promise<T> => 42 as unknown as T,
    on: (event, handler) => {
      if (event === 'console') page.consoleHandlers.push(handler);
      else if (event === 'pageerror') page.pageErrorHandlers.push(handler);
    },
    mouse: {
      click: async () => undefined,
      move: async () => undefined,
    },
    keyboard: {
      press: async () => undefined,
      type: async () => undefined,
    },
    viewportSize: () => ({ width: 1280, height: 720 }),
  };

  const fakeCdp: LaunchedCDPSession = {
    send: async (method, params) => {
      cdp.sent.push({ method, ...(params ? { params } : {}) });
      return undefined;
    },
    on: (event, handler) => {
      if (event === 'Page.screencastFrame') cdp.frameHandlers.push(handler);
    },
    detach: async () => undefined,
  };

  const fakeContext: LaunchedContext = {
    newPage: async () => fakePage,
    newCDPSession: async () => fakeCdp,
    close: async () => undefined,
  };

  const fakeBrowser: LaunchedBrowser = {
    newContext: async () => fakeContext,
    close: async () => undefined,
  };

  const launcher: BrowserLauncher = {
    launch: async () => fakeBrowser,
  };

  return { launcher, page, cdp };
}

describe('BrowserSession — lifecycle', () => {
  test('does not launch Chromium until first start()', async () => {
    const { launcher } = buildFakeLauncher();
    let launched = 0;
    const wrapped: BrowserLauncher = {
      launch: async (opts) => {
        launched += 1;
        return launcher.launch(opts);
      },
    };
    const session = createBrowserSession({ launcher: wrapped });
    expect(launched).toBe(0);
    await session.start();
    expect(launched).toBe(1);
    // Idempotent
    await session.start();
    expect(launched).toBe(1);
    await session.close();
  });

  test('close() is idempotent', async () => {
    const { launcher } = buildFakeLauncher();
    const session = createBrowserSession({ launcher });
    await session.start();
    await session.close();
    await session.close();
  });

  test('starting a closed session throws', async () => {
    const { launcher } = buildFakeLauncher();
    const session = createBrowserSession({ launcher });
    await session.start();
    await session.close();
    await expect(session.start()).rejects.toThrow(/closed/i);
  });
});

describe('BrowserSession — domain allowlist', () => {
  test('rejects non-allowlisted hosts by default', async () => {
    const { launcher } = buildFakeLauncher();
    const session = createBrowserSession({ launcher });
    await session.start();
    await expect(session.navigate('https://example.com/')).rejects.toThrow(
      /not in the browser allowlist/,
    );
    await session.close();
  });

  test('allows localhost by default', async () => {
    const { launcher } = buildFakeLauncher();
    const session = createBrowserSession({ launcher });
    await session.start();
    const r = await session.navigate('http://localhost:3000/');
    expect(r.url).toContain('localhost');
    expect(r.title).toContain('localhost');
    await session.close();
  });

  test('respects custom allowDomains override', async () => {
    const { launcher } = buildFakeLauncher();
    const session = createBrowserSession({
      launcher,
      allowDomains: ['example.com'],
    });
    await session.start();
    await expect(session.navigate('https://example.com/')).resolves.toBeTruthy();
    await expect(session.navigate('https://other.com/')).rejects.toThrow();
    await session.close();
  });

  test('wildcard *.local matches subdomains', async () => {
    const { launcher } = buildFakeLauncher();
    const session = createBrowserSession({ launcher });
    await session.start();
    await expect(
      session.navigate('http://app.local/'),
    ).resolves.toBeTruthy();
    await expect(session.navigate('http://local/')).rejects.toThrow();
    await session.close();
  });

  // ---------- S3: file:// is NOT in the default allowlist ----------

  test('file:// URLs are rejected by default (regression — S3)', async () => {
    const { launcher } = buildFakeLauncher();
    const session = createBrowserSession({ launcher });
    await session.start();
    await expect(
      session.navigate('file:///etc/passwd'),
    ).rejects.toThrow(/not in the browser allowlist/);
    await session.close();
  });

  test('file:// can still be opted in via explicit allowDomains', async () => {
    const { launcher } = buildFakeLauncher();
    const session = createBrowserSession({
      launcher,
      allowDomains: ['file://'],
    });
    await session.start();
    await expect(
      session.navigate('file:///etc/passwd'),
    ).resolves.toBeTruthy();
    await session.close();
  });
});

describe('DEFAULT_ALLOW_DOMAINS (S3)', () => {
  test('contains only local-host patterns (no file:// scheme)', async () => {
    const { DEFAULT_ALLOW_DOMAINS } = await import('@/browser/types');
    expect([...DEFAULT_ALLOW_DOMAINS]).toEqual([
      'localhost',
      '127.0.0.1',
      '*.local',
    ]);
    expect(DEFAULT_ALLOW_DOMAINS).not.toContain('file://');
  });
});

describe('BrowserSession — screencast plumbing', () => {
  test('starts CDP screencast and forwards frames', async () => {
    const { launcher, cdp } = buildFakeLauncher();
    const session = createBrowserSession({ launcher });
    const frames: number[] = [];
    session.subscribe({
      onFrame: (f) => {
        frames.push(f.jpegBase64.length);
      },
    });
    await session.start();
    // Verify Page.startScreencast was issued
    const started = cdp.sent.find((s) => s.method === 'Page.startScreencast');
    expect(started).toBeDefined();
    expect(started?.params).toEqual({
      format: 'jpeg',
      quality: 70,
      everyNthFrame: 6,
    });

    // Simulate a screencast frame from CDP
    const handler = cdp.frameHandlers[0];
    expect(handler).toBeDefined();
    handler?.({
      data: 'AAAA',
      sessionId: 7,
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    });
    // Allow the async ack to settle
    await Promise.resolve();
    await Promise.resolve();
    expect(frames).toEqual([4]);
    // Frame ack should have been sent
    const ack = cdp.sent.find((s) => s.method === 'Page.screencastFrameAck');
    expect(ack).toBeDefined();
    await session.close();
  });

  test('subscribe replays the most recent frame to late subscribers', async () => {
    const { launcher, cdp } = buildFakeLauncher();
    const session = createBrowserSession({ launcher });
    await session.start();
    cdp.frameHandlers[0]?.({ data: 'BBBB', sessionId: 1 });
    await Promise.resolve();
    let replayed = 0;
    session.subscribe({
      onFrame: () => {
        replayed += 1;
      },
    });
    expect(replayed).toBe(1);
    await session.close();
  });
});

describe('BrowserSession — console buffer', () => {
  test('captures console events with level mapping and ring-buffer cap', async () => {
    const { launcher, page } = buildFakeLauncher();
    const session = createBrowserSession({ launcher });
    await session.start();
    const handler = page.consoleHandlers[0];
    expect(handler).toBeDefined();
    handler?.({
      type: () => 'warning',
      text: () => 'careful',
      location: () => ({ url: 'about:blank', lineNumber: 7 }),
    });
    handler?.({
      type: () => 'log',
      text: () => 'hello',
      location: () => ({}),
    });
    const all = session.consoleMessages();
    expect(all.length).toBe(2);
    expect(all[0]?.level).toBe('warn');
    expect(all[0]?.line).toBe(7);
    expect(all[1]?.level).toBe('log');

    // Push past the cap (200) to exercise trimming.
    for (let i = 0; i < 250; i += 1) {
      handler?.({ type: () => 'log', text: () => `m${i}` });
    }
    expect(session.consoleMessages().length).toBe(200);
    await session.close();
  });
});

describe('BrowserSession — interactive forwarding', () => {
  test('forwardUserClick emits a cursor event', async () => {
    const { launcher } = buildFakeLauncher();
    const session = createBrowserSession({ launcher });
    await session.start();
    const cursors: Array<{ toX: number; toY: number; action: string }> = [];
    session.subscribe({
      onCursor: (e) => {
        cursors.push({ toX: e.toX, toY: e.toY, action: e.action });
      },
    });
    await session.forwardUserClick(50, 60);
    expect(cursors).toEqual([{ toX: 50, toY: 60, action: 'click' }]);
    await session.close();
  });
});

// ---------- E2E (skipped unless LOCALCODE_E2E_BROWSER=1) ----------

const E2E_ENABLED = process.env['LOCALCODE_E2E_BROWSER'] === '1';

describe.skipIf(!E2E_ENABLED)('BrowserSession — e2e (real Chromium)', () => {
  test('launches Chromium and renders about:blank', async () => {
    const session = createBrowserSession();
    await session.start();
    const shot = await session.screenshot();
    expect(shot.pngBase64.length).toBeGreaterThan(0);
    await session.close();
  });
});
