/**
 * `web_fetch` tool tests — covers URL validation, SSRF guard, HTML→markdown
 * conversion, JSON / text passthrough, binary stubbing, size capping, and
 * common failure modes (timeout, non-2xx, network errors).
 *
 * We swap `globalThis.fetch` with a per-test fake so no network IO leaves
 * the test runner. The SSRF guard is exercised by both Zod-level rejects
 * (file:// etc.) and host-level rejects (localhost / 127.0.0.1 / 169.254).
 */

import { describe, test, expect, afterEach } from 'bun:test';

import { webFetch } from '@/tools/web-fetch';
import type { WebFetchEnvelope } from '@/tools/web-fetch';

type FetchImpl = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const realFetch = globalThis.fetch;

function installFetch(impl: FetchImpl): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function ctx() {
  return { projectRoot: '/tmp', dangerouslyAllowAll: false };
}

function parseEnv(raw: string): WebFetchEnvelope {
  return JSON.parse(raw) as WebFetchEnvelope;
}

describe('web_fetch — URL scheme validation', () => {
  test('file:// rejected at Zod layer', async () => {
    let fetched = false;
    installFetch(async () => {
      fetched = true;
      return new Response('');
    });
    try {
      const res = await webFetch({ url: 'file:///etc/passwd' }, ctx());
      expect(res.success).toBe(false);
      expect(fetched).toBe(false);
      expect(res.error ?? '').toMatch(/http/i);
    } finally {
      restoreFetch();
    }
  });

  test('ftp:// rejected', async () => {
    const res = await webFetch({ url: 'ftp://host/x' }, ctx());
    expect(res.success).toBe(false);
  });

  test('empty url rejected', async () => {
    const res = await webFetch({ url: '' }, ctx());
    expect(res.success).toBe(false);
  });

  test('relative path rejected', async () => {
    const res = await webFetch({ url: '/etc/passwd' }, ctx());
    expect(res.success).toBe(false);
  });
});

describe('web_fetch — SSRF guard', () => {
  test('localhost rejected', async () => {
    let fetched = false;
    installFetch(async () => {
      fetched = true;
      return new Response('hi');
    });
    try {
      const res = await webFetch({ url: 'http://localhost:3000/' }, ctx());
      expect(res.success).toBe(false);
      expect(fetched).toBe(false);
      expect(res.error ?? '').toMatch(/SSRF/);
    } finally {
      restoreFetch();
    }
  });

  test('127.0.0.1 rejected', async () => {
    let fetched = false;
    installFetch(async () => {
      fetched = true;
      return new Response('hi');
    });
    try {
      const res = await webFetch({ url: 'http://127.0.0.1/' }, ctx());
      expect(res.success).toBe(false);
      expect(fetched).toBe(false);
    } finally {
      restoreFetch();
    }
  });

  test('cloud metadata 169.254.169.254 rejected', async () => {
    const res = await webFetch(
      { url: 'http://169.254.169.254/latest/meta-data/' },
      ctx(),
    );
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/SSRF/);
  });

  test('10.0.0.1 (RFC 1918) rejected', async () => {
    const res = await webFetch({ url: 'http://10.0.0.1/' }, ctx());
    expect(res.success).toBe(false);
  });

  test('192.168.1.1 (RFC 1918) rejected', async () => {
    const res = await webFetch({ url: 'http://192.168.1.1/' }, ctx());
    expect(res.success).toBe(false);
  });

  test('172.16.5.5 (RFC 1918) rejected', async () => {
    const res = await webFetch({ url: 'http://172.16.5.5/' }, ctx());
    expect(res.success).toBe(false);
  });

  test('public IP NOT rejected (allowed at SSRF layer)', async () => {
    installFetch(async () =>
      new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    try {
      const res = await webFetch({ url: 'http://8.8.8.8/' }, ctx());
      expect(res.success).toBe(true);
    } finally {
      restoreFetch();
    }
  });

  test('allowLoopback bypasses guard (test seam)', async () => {
    installFetch(async () =>
      new Response('local', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    try {
      const res = await webFetch(
        { url: 'http://localhost/' },
        ctx(),
        { allowLoopback: true },
      );
      expect(res.success).toBe(true);
      const env = parseEnv(res.output);
      expect(env.content).toBe('local');
    } finally {
      restoreFetch();
    }
  });
});

describe('web_fetch — content handling', () => {
  afterEach(() => restoreFetch());

  test('HTML is converted to markdown', async () => {
    installFetch(async () =>
      new Response(
        '<html><body><h1>Title</h1><p>Hello <a href="https://example.com">link</a></p><script>bad()</script></body></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      ),
    );
    const res = await webFetch({ url: 'https://example.com/page' }, ctx());
    expect(res.success).toBe(true);
    const env = parseEnv(res.output);
    expect(env.contentType).toBe('text/html');
    expect(typeof env.content).toBe('string');
    expect(env.content).toContain('# Title');
    expect(env.content).toContain('[link](https://example.com)');
    expect(env.content).not.toContain('<script>');
    expect(env.content).not.toContain('bad()');
  });

  test('application/json passed through verbatim', async () => {
    const body = JSON.stringify({ a: 1, b: 'two' });
    installFetch(async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await webFetch({ url: 'https://api.example.com/x' }, ctx());
    expect(res.success).toBe(true);
    const env = parseEnv(res.output);
    expect(env.content).toBe(body);
  });

  test('text/plain passed through verbatim', async () => {
    installFetch(async () =>
      new Response('plain text body', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const res = await webFetch({ url: 'https://example.com/x.txt' }, ctx());
    expect(res.success).toBe(true);
    const env = parseEnv(res.output);
    expect(env.content).toBe('plain text body');
  });

  test('binary content returns stub envelope', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    installFetch(async () =>
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    const res = await webFetch({ url: 'https://example.com/blob' }, ctx());
    expect(res.success).toBe(true);
    const env = parseEnv(res.output);
    expect(typeof env.content).toBe('object');
    const c = env.content as { kind: string; sizeBytes: number; mimeType: string };
    expect(c.kind).toBe('binary');
    expect(c.sizeBytes).toBe(4);
    expect(c.mimeType).toBe('application/octet-stream');
  });
});

describe('web_fetch — failure modes', () => {
  afterEach(() => restoreFetch());

  test('non-2xx response → failure', async () => {
    installFetch(async () =>
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    );
    const res = await webFetch({ url: 'https://example.com/404' }, ctx());
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/404|HTTP/);
  });

  test('network error reported', async () => {
    installFetch(async () => {
      throw new TypeError('connection refused');
    });
    const res = await webFetch({ url: 'https://example.com/dead' }, ctx());
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Network error|connection refused/);
  });

  test('AbortError surfaced as timeout', async () => {
    installFetch(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const res = await webFetch({ url: 'https://example.com/slow' }, ctx());
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/timed out/);
  });

  test('large body truncated to maxBytes', async () => {
    // 800KB; default cap is 500KB.
    const huge = 'a'.repeat(800_000);
    installFetch(async () =>
      new Response(huge, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const res = await webFetch({ url: 'https://example.com/big' }, ctx());
    expect(res.success).toBe(true);
    const env = parseEnv(res.output);
    expect(env.truncated).toBe(true);
    expect(env.sizeBytes).toBeLessThanOrEqual(500_000);
    // content was truncated to fit cap
    expect((env.content as string).length).toBeLessThanOrEqual(500_000);
  });

  test('maxBytes hard-capped at 2MB', async () => {
    // Caller asks for 5MB; response is 3MB → should cap at 2MB.
    const huge = 'b'.repeat(3_000_000);
    installFetch(async () =>
      new Response(huge, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const res = await webFetch(
      { url: 'https://example.com/huge', maxBytes: 5_000_000 },
      ctx(),
    );
    expect(res.success).toBe(true);
    const env = parseEnv(res.output);
    expect(env.truncated).toBe(true);
    expect(env.sizeBytes).toBeLessThanOrEqual(2_000_000);
  });

  test('custom maxBytes honoured when smaller than default', async () => {
    installFetch(async () =>
      new Response('a'.repeat(2000), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const res = await webFetch(
      { url: 'https://example.com/small', maxBytes: 100 },
      ctx(),
    );
    expect(res.success).toBe(true);
    const env = parseEnv(res.output);
    expect(env.sizeBytes).toBeLessThanOrEqual(100);
    expect(env.truncated).toBe(true);
  });
});
