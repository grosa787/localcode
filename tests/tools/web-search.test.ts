/**
 * `web_search` tool tests — exercise query validation, HTML parsing,
 * max-results clamping, entity decoding, ad-link filtering, and failure
 * modes (HTTP non-2xx, network error, anomaly challenge page).
 *
 * We swap `globalThis.fetch` with a per-test fake so the suite is hermetic
 * and never touches DuckDuckGo.
 */

import { describe, test, expect, afterEach } from 'bun:test';

import { webSearch, parseDuckDuckGoLite } from '@/tools/web-search';
import type { WebSearchEnvelope } from '@/tools/web-search';

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

function parseEnv(raw: string): WebSearchEnvelope {
  return JSON.parse(raw) as WebSearchEnvelope;
}

/**
 * Compact fixture mirroring the real DDG Lite response structure. Two real
 * results, one ad wrapper (must be filtered), and a "more info" link
 * (must be filtered). Entity-encoded ampersand in one URL exercises the
 * decode path.
 */
const DDG_LITE_FIXTURE = `
<html><body>
<table>
  <tr><td>1.&nbsp;</td><td>
    <a rel="nofollow" href="https://duckduckgo.com/y.js?ad_domain=ads.example.com" class='result-link'>Ad: Master TypeScript</a>
    (<a rel="nofollow" class="result-link">more info</a>)
  </td></tr>
  <tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>Sponsored snippet.</td></tr>
  <tr><td>2.&nbsp;</td><td>
    <a rel="nofollow" href="https://www.w3schools.com/typescript/index.php" class='result-link'>TypeScript Tutorial - W3Schools</a>
  </td></tr>
  <tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>
    Free online <b>TypeScript</b> <b>tutorial</b> from W3Schools.com.
  </td></tr>
  <tr><td>3.&nbsp;</td><td>
    <a rel="nofollow" href="https://www.typescriptlang.org/docs/?ref=foo&amp;bar=1" class='result-link'>Typescript Docs &amp; Guide</a>
  </td></tr>
  <tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>The official docs &#8212; with examples.</td></tr>
</table>
</body></html>
`;

describe('web_search — parser', () => {
  test('extracts title + url + snippet, filters ads + more-info', () => {
    const hits = parseDuckDuckGoLite(DDG_LITE_FIXTURE);
    expect(hits.length).toBe(2);
    expect(hits[0]?.title).toBe('TypeScript Tutorial - W3Schools');
    expect(hits[0]?.url).toBe('https://www.w3schools.com/typescript/index.php');
    expect(hits[0]?.snippet).toBe(
      'Free online TypeScript tutorial from W3Schools.com.',
    );
    // HTML entity in URL decoded; em-dash in snippet decoded; <b> stripped.
    expect(hits[1]?.url).toBe('https://www.typescriptlang.org/docs/?ref=foo&bar=1');
    expect(hits[1]?.title).toBe('Typescript Docs & Guide');
    expect(hits[1]?.snippet).toContain('—');
  });

  test('returns empty array on unrelated HTML', () => {
    const hits = parseDuckDuckGoLite('<html><body>no results</body></html>');
    expect(hits).toEqual([]);
  });
});

describe('web_search — args validation', () => {
  afterEach(() => restoreFetch());

  test('empty query rejected', async () => {
    let called = false;
    installFetch(async () => {
      called = true;
      return new Response('');
    });
    const res = await webSearch({ query: '' }, ctx());
    expect(res.success).toBe(false);
    expect(called).toBe(false);
    expect(res.error ?? '').toMatch(/non-empty/);
  });

  test('500+ char query rejected', async () => {
    const huge = 'a'.repeat(501);
    const res = await webSearch({ query: huge }, ctx());
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/500/);
  });

  test('maxResults clamped to HARD_MAX_RESULTS (25)', async () => {
    // Build a fixture with 30 results, ensure the tool returns at most 25.
    const rows = Array.from(
      { length: 30 },
      (_, i) => `
        <a class='result-link' href='https://example.com/r${i}'>Result ${i}</a>
        <td class='result-snippet'>Snippet ${i}</td>
      `,
    ).join('');
    installFetch(async () =>
      new Response(`<html><body>${rows}</body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const res = await webSearch({ query: 'foo', maxResults: 1000 }, ctx());
    expect(res.success).toBe(true);
    const env = parseEnv(res.output);
    expect(env.results.length).toBe(25);
  });

  test('maxResults honoured when below default', async () => {
    const rows = Array.from(
      { length: 10 },
      (_, i) => `
        <a class='result-link' href='https://example.com/r${i}'>Result ${i}</a>
        <td class='result-snippet'>Snippet ${i}</td>
      `,
    ).join('');
    installFetch(async () =>
      new Response(`<html><body>${rows}</body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const res = await webSearch({ query: 'foo', maxResults: 3 }, ctx());
    expect(res.success).toBe(true);
    const env = parseEnv(res.output);
    expect(env.results.length).toBe(3);
  });
});

describe('web_search — happy path', () => {
  afterEach(() => restoreFetch());

  test('returns parsed results from DDG Lite response', async () => {
    let posted = false;
    let receivedBody = '';
    installFetch(async (_url, init) => {
      posted = init?.method === 'POST';
      receivedBody = String(init?.body ?? '');
      return new Response(DDG_LITE_FIXTURE, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    const res = await webSearch({ query: 'typescript tutorial' }, ctx());
    expect(res.success).toBe(true);
    expect(posted).toBe(true);
    expect(receivedBody).toContain('q=typescript');
    const env = parseEnv(res.output);
    expect(env.query).toBe('typescript tutorial');
    expect(env.results.length).toBe(2);
    expect(env.results[0]?.title).toBe('TypeScript Tutorial - W3Schools');
  });
});

describe('web_search — failure modes', () => {
  afterEach(() => restoreFetch());

  test('non-2xx response → failure with HTTP status in error', async () => {
    installFetch(async () =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    );
    const res = await webSearch({ query: 'foo' }, ctx());
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/429|HTTP/);
  });

  test('network error surfaced as friendly message', async () => {
    installFetch(async () => {
      throw new TypeError('connection refused');
    });
    const res = await webSearch({ query: 'foo' }, ctx());
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/Network error|connection refused/);
  });

  test('AbortError reported as timeout', async () => {
    installFetch(async () => {
      const err = new Error('timed out');
      err.name = 'AbortError';
      throw err;
    });
    const res = await webSearch({ query: 'foo' }, ctx());
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/timed out/);
  });

  test('anomaly challenge HTML reported as bot-block', async () => {
    installFetch(async () =>
      new Response(
        '<html><body><div class="anomaly-modal__title">prove you are human</div></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      ),
    );
    const res = await webSearch({ query: 'foo' }, ctx());
    expect(res.success).toBe(false);
    expect(res.error ?? '').toMatch(/anti-bot|challenge|blocked/i);
  });

  test('zero results returns empty array with success=true', async () => {
    installFetch(async () =>
      new Response('<html><body>no results here</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const res = await webSearch({ query: 'foo' }, ctx());
    expect(res.success).toBe(true);
    const env = parseEnv(res.output);
    expect(env.results).toEqual([]);
  });
});
