/**
 * Coverage for `fetchLatestRelease`. Uses a fetch stub + tmp HOME so no
 * real network or filesystem is touched. Verifies:
 *
 *   - Happy path parses the GitHub payload into our ReleaseInfo shape.
 *   - 5s timeout is enforced via an injected AbortController.
 *   - Disk cache short-circuits a second call within the TTL.
 *   - Network failure / non-2xx / malformed JSON each resolve to `null`
 *     without throwing.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  fetchLatestRelease,
  compareSemver,
  isNewerThan,
  stripVersionPrefix,
  CACHE_TTL_MS,
} from '@/updater/github-releases';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function buildFetchStub(
  pages: readonly { ok: boolean; status?: number; body: unknown; delayMs?: number }[],
): {
  fn: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : 'unknown';
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    const page = pages[i] ?? pages[pages.length - 1];
    if (page === undefined) {
      throw new Error('no fetch stub page configured');
    }
    i += 1;
    if (page.delayMs !== undefined && page.delayMs > 0) {
      const signal = init?.signal;
      await new Promise<void>((resolveCb, rejectCb) => {
        const t = setTimeout(resolveCb, page.delayMs);
        if (signal !== undefined && signal !== null) {
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              rejectCb(new Error('aborted'));
            },
            { once: true },
          );
        }
      });
    }
    if (!page.ok) {
      return new Response(JSON.stringify(page.body), {
        status: page.status ?? 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(page.body), {
      status: page.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn: impl as unknown as typeof globalThis.fetch, calls };
}

let scratchDir: string;
beforeEach(async () => {
  scratchDir = join(tmpdir(), `localcode-updater-test-${randomUUID()}`);
  await mkdir(scratchDir, { recursive: true });
});
afterEach(async () => {
  try {
    await rm(scratchDir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

const cachePath = (): string => join(scratchDir, 'release-check.json');

describe('stripVersionPrefix', () => {
  test('removes a leading v', () => {
    expect(stripVersionPrefix('v1.2.3')).toBe('1.2.3');
  });
  test('leaves bare semver alone', () => {
    expect(stripVersionPrefix('1.2.3')).toBe('1.2.3');
  });
});

describe('compareSemver / isNewerThan', () => {
  test('orders core versions correctly', () => {
    expect(compareSemver('0.19.0', '0.20.0')).toBe(-1);
    expect(compareSemver('0.20.0', '0.19.0')).toBe(1);
    expect(compareSemver('0.20.0', '0.20.0')).toBe(0);
  });
  test('treats pre-release as < release', () => {
    expect(compareSemver('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0-beta')).toBe(1);
  });
  test('isNewerThan strict inequality', () => {
    expect(isNewerThan('0.20.0', '0.19.0')).toBe(true);
    expect(isNewerThan('0.19.0', '0.19.0')).toBe(false);
  });
});

describe('fetchLatestRelease — happy path', () => {
  test('parses the upstream payload into ReleaseInfo', async () => {
    const { fn } = buildFetchStub([
      {
        ok: true,
        body: {
          tag_name: 'v0.20.0',
          name: 'v0.20.0',
          body: 'release notes',
          html_url: 'https://github.com/example/repo/releases/tag/v0.20.0',
          prerelease: false,
          published_at: '2026-01-01T00:00:00Z',
          tarball_url: 'https://api.github.com/repos/example/repo/tarball/v0.20.0',
          assets: [
            {
              name: 'localcode-darwin-arm64.tar.gz',
              browser_download_url: 'https://example.test/asset.tar.gz',
              size: 4096,
              digest: 'sha256:abc',
            },
          ],
        },
      },
    ]);
    const release = await fetchLatestRelease('example/repo', {
      fetchFn: fn,
      cachePath: cachePath(),
    });
    expect(release).not.toBeNull();
    expect(release?.version).toBe('0.20.0');
    expect(release?.tagName).toBe('v0.20.0');
    expect(release?.assets.length).toBe(1);
    expect(release?.assets[0]?.digest).toBe('sha256:abc');
  });
});

describe('fetchLatestRelease — failure modes resolve to null', () => {
  test('non-2xx', async () => {
    const { fn } = buildFetchStub([{ ok: false, status: 404, body: {} }]);
    const release = await fetchLatestRelease('example/repo', {
      fetchFn: fn,
      cachePath: cachePath(),
    });
    expect(release).toBeNull();
  });

  test('malformed payload', async () => {
    const { fn } = buildFetchStub([{ ok: true, body: { not_a_release: true } }]);
    const release = await fetchLatestRelease('example/repo', {
      fetchFn: fn,
      cachePath: cachePath(),
    });
    expect(release).toBeNull();
  });

  test('network throws', async () => {
    const fn = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof globalThis.fetch;
    const release = await fetchLatestRelease('example/repo', {
      fetchFn: fn,
      cachePath: cachePath(),
    });
    expect(release).toBeNull();
  });

  test('timeout fires via AbortController', async () => {
    const { fn } = buildFetchStub([
      { ok: true, body: { tag_name: 'v0.20.0', html_url: 'h', tarball_url: 't' }, delayMs: 100 },
    ]);
    const release = await fetchLatestRelease('example/repo', {
      fetchFn: fn,
      cachePath: cachePath(),
      timeoutMs: 5,
    });
    expect(release).toBeNull();
  });
});

describe('fetchLatestRelease — disk cache', () => {
  test('cache hit short-circuits a second call', async () => {
    const { fn, calls } = buildFetchStub([
      {
        ok: true,
        body: {
          tag_name: 'v0.20.0',
          html_url: 'h',
          tarball_url: 't',
          assets: [],
        },
      },
      {
        ok: true,
        body: {
          tag_name: 'v0.21.0',
          html_url: 'h',
          tarball_url: 't',
          assets: [],
        },
      },
    ]);
    const path = cachePath();
    const r1 = await fetchLatestRelease('example/repo', {
      fetchFn: fn,
      cachePath: path,
    });
    const r2 = await fetchLatestRelease('example/repo', {
      fetchFn: fn,
      cachePath: path,
    });
    expect(r1?.version).toBe('0.20.0');
    expect(r2?.version).toBe('0.20.0'); // cache hit returned same
    expect(calls.length).toBe(1);
  });

  test('cache expires after TTL', async () => {
    const { fn, calls } = buildFetchStub([
      {
        ok: true,
        body: { tag_name: 'v0.20.0', html_url: 'h', tarball_url: 't', assets: [] },
      },
      {
        ok: true,
        body: { tag_name: 'v0.21.0', html_url: 'h', tarball_url: 't', assets: [] },
      },
    ]);
    const path = cachePath();
    let t = 1_000_000;
    const nowFn = (): number => t;
    const r1 = await fetchLatestRelease('example/repo', {
      fetchFn: fn,
      cachePath: path,
      nowFn,
    });
    t += CACHE_TTL_MS + 1;
    const r2 = await fetchLatestRelease('example/repo', {
      fetchFn: fn,
      cachePath: path,
      nowFn,
    });
    expect(r1?.version).toBe('0.20.0');
    expect(r2?.version).toBe('0.21.0');
    expect(calls.length).toBe(2);
  });

  test('skipCache bypasses the cached value', async () => {
    const { fn, calls } = buildFetchStub([
      {
        ok: true,
        body: { tag_name: 'v0.20.0', html_url: 'h', tarball_url: 't', assets: [] },
      },
      {
        ok: true,
        body: { tag_name: 'v0.21.0', html_url: 'h', tarball_url: 't', assets: [] },
      },
    ]);
    const path = cachePath();
    await fetchLatestRelease('example/repo', { fetchFn: fn, cachePath: path });
    const fresh = await fetchLatestRelease('example/repo', {
      fetchFn: fn,
      cachePath: path,
      skipCache: true,
    });
    expect(fresh?.version).toBe('0.21.0');
    expect(calls.length).toBe(2);
  });
});
