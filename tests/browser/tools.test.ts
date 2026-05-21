/**
 * Unit tests for the eight `browser_*` tool handlers. We back them with a
 * stub `BrowserSession` so we can verify the tool-result envelopes
 * without launching Chromium.
 */

import { describe, expect, test } from 'bun:test';

import { createBrowserToolHandlers } from '@/browser/tools';
import type {
  BrowserClickArgs,
  BrowserConsoleEvent,
  BrowserSession,
  BrowserSessionEvents,
  BrowserTypeArgs,
} from '@/browser/types';
import { ToolExecutor } from '@/llm/tool-executor';
import type { ToolResult } from '@/types/global';

function stubSession(over: Partial<BrowserSession> = {}): BrowserSession {
  const base: BrowserSession = {
    start: async () => undefined,
    subscribe: (_: BrowserSessionEvents) => () => undefined,
    forwardUserClick: async () => undefined,
    forwardUserKey: async () => undefined,
    navigate: async (url) => ({ url, title: `t-${url}` }),
    screenshot: async () => ({
      pngBase64: 'AAAA',
      width: 800,
      height: 600,
    }),
    click: async (_: BrowserClickArgs) => ({ ok: true }),
    type: async (_: BrowserTypeArgs) => ({ ok: true }),
    pressKey: async () => ({ ok: true }),
    evaluate: async (_js: string) => ({ result: { hello: 'world' } }),
    consoleMessages: (): BrowserConsoleEvent[] => [
      { level: 'log', text: 'one' },
      { level: 'error', text: 'two' },
    ],
    reload: async () => ({ url: 'http://localhost/' }),
    close: async () => undefined,
  };
  return { ...base, ...over };
}

const ctx = { projectRoot: '/tmp', dangerouslyAllowAll: false };

describe('browser_navigate', () => {
  test('returns text describing the URL + title on success', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_navigate']!.preview(
      { url: 'http://localhost:3000/' },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain('http://localhost:3000/');
    expect(r.output).toContain('title:');
  });

  test('returns failure for empty url', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_navigate']!.preview({ url: '' }, ctx);
    expect(r.success).toBe(false);
  });

  test('surfaces session errors as failure', async () => {
    const handlers = createBrowserToolHandlers(
      stubSession({
        navigate: async () => {
          throw new Error('boom');
        },
      }),
    );
    const r = await handlers['browser_navigate']!.preview(
      { url: 'http://localhost/' },
      ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('boom');
  });
});

describe('browser_screenshot', () => {
  test('returns the multimodal image envelope (matches fetch_image shape)', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_screenshot']!.preview({}, ctx);
    expect(r.success).toBe(true);
    const env = JSON.parse(r.output) as {
      kind: string;
      mimeType: string;
      dataBase64: string;
    };
    expect(env.kind).toBe('image');
    expect(env.mimeType).toBe('image/png');
    expect(env.dataBase64).toBe('AAAA');
  });
});

describe('browser_click', () => {
  test('accepts selector', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_click']!.preview(
      { selector: 'button#go' },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain('button#go');
  });

  test('accepts xy coords', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_click']!.preview({ x: 5, y: 6 }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('(5, 6)');
  });

  test('rejects when both selector and coords are missing', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_click']!.preview({}, ctx);
    expect(r.success).toBe(false);
  });
});

describe('browser_type', () => {
  test('reports number of chars typed', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_type']!.preview(
      { selector: 'input', text: 'hello' },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain('5 chars');
    expect(r.output).toContain('input');
  });
});

describe('browser_press_key', () => {
  test('echoes the key name', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_press_key']!.preview(
      { key: 'Enter' },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain('Enter');
  });
});

describe('browser_evaluate', () => {
  test('serialises JS results as JSON', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_evaluate']!.preview(
      { js: '1+1' },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output)).toEqual({ hello: 'world' });
  });

  test('truncates large results', async () => {
    const big = 'x'.repeat(20_000);
    const handlers = createBrowserToolHandlers(
      stubSession({
        evaluate: async () => ({ result: big }),
      }),
    );
    const r = await handlers['browser_evaluate']!.preview(
      { js: 'whatever' },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.output.length).toBeLessThan(big.length + 200);
    expect(r.output).toContain('truncated');
  });
});

describe('browser_console_messages', () => {
  test('dumps all messages by default', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_console_messages']!.preview({}, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('[log] one');
    expect(r.output).toContain('[error] two');
  });

  test('filters by level when supplied', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_console_messages']!.preview(
      { level: 'error' },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.output).toContain('[error] two');
    expect(r.output).not.toContain('[log] one');
  });

  test('handles empty buffer', async () => {
    const handlers = createBrowserToolHandlers(
      stubSession({
        consoleMessages: () => [],
      }),
    );
    const r = await handlers['browser_console_messages']!.preview({}, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('no console messages');
  });
});

describe('browser_reload', () => {
  test('returns the post-reload URL', async () => {
    const handlers = createBrowserToolHandlers(stubSession());
    const r = await handlers['browser_reload']!.preview({}, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('http://localhost/');
  });
});

describe('handler map registration', () => {
  test('exposes exactly the eight expected names', () => {
    const handlers = createBrowserToolHandlers(stubSession());
    expect(Object.keys(handlers).sort()).toEqual(
      [
        'browser_click',
        'browser_console_messages',
        'browser_evaluate',
        'browser_navigate',
        'browser_press_key',
        'browser_reload',
        'browser_screenshot',
        'browser_type',
      ].sort(),
    );
  });
});

// ---------- S2 — browser_evaluate must require approval ----------

describe('browser_evaluate approval gating (S2)', () => {
  // Minimal stub handler — the test only inspects `requiresApproval`,
  // not actual execution, so any handler shape will do.
  const noopHandler = async (): Promise<ToolResult> => ({
    success: true,
    output: '',
  });
  const handlers = {
    browser_evaluate: noopHandler,
    browser_navigate: noopHandler,
    browser_screenshot: noopHandler,
    read_file: noopHandler,
  } as const;

  test('browser_evaluate is gated by ToolExecutor.requiresApproval()', () => {
    const exec = new ToolExecutor({ handlers });
    expect(exec.requiresApproval('browser_evaluate')).toBe(true);
  });

  test('other browser_* tools remain free-of-approval', () => {
    const exec = new ToolExecutor({ handlers });
    expect(exec.requiresApproval('browser_navigate')).toBe(false);
    expect(exec.requiresApproval('browser_screenshot')).toBe(false);
  });

  test('dangerouslyAllowAll still bypasses browser_evaluate', () => {
    const exec = new ToolExecutor({
      handlers,
      dangerouslyAllowAll: true,
    });
    expect(exec.requiresApproval('browser_evaluate')).toBe(false);
  });

  test('autoApproveTools entry suppresses approval for browser_evaluate', () => {
    const exec = new ToolExecutor({
      handlers,
      autoApproveTools: ['browser_evaluate'],
    });
    expect(exec.requiresApproval('browser_evaluate')).toBe(false);
  });

  test('execute() refuses browser_evaluate when approval is needed but no callback wired', async () => {
    const exec = new ToolExecutor({ handlers });
    const res = await exec.execute({
      id: 'c1',
      name: 'browser_evaluate',
      arguments: { js: 'document.cookie' },
    });
    expect(res.success).toBe(false);
    expect(res.error ?? '').toContain('requires approval');
  });
});
