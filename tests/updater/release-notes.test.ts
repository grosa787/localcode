/**
 * Coverage for `fetchReleaseNotesBetween` — the delta release-notes
 * fetcher used by the update modal. Uses an in-memory fetch stub +
 * tmp cache path so no real network or filesystem write hits the real
 * machine.
 *
 * Asserts:
 *   - Versions strictly between `current` and `latest` are included.
 *   - Result is sorted newest-first.
 *   - When `current === latest` no fetch fires and the result is empty.
 *   - Disk cache short-circuits a second call within the TTL.
 *   - Network failure / non-2xx leaves us with `partial: true`.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  fetchReleaseNotesBetween,
  NOTES_CACHE_TTL_MS,
} from '@/updater/release-notes';

interface FetchCall {
  url: string;
}

function buildFetchStub(
  pages: readonly { ok: boolean; status?: number; body: unknown }[],
): { fn: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const impl = async (input: unknown): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : 'unknown';
    calls.push({ url });
    const page = pages[i] ?? pages[pages.length - 1];
    if (page === undefined) throw new Error('no page configured');
    i += 1;
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

function makeRelease(opts: {
  tag: string;
  body?: string;
  publishedAt?: string;
  prerelease?: boolean;
  draft?: boolean;
}): Record<string, unknown> {
  return {
    tag_name: opts.tag,
    name: opts.tag,
    body: opts.body ?? '',
    html_url: `https://github.com/local/code/releases/tag/${opts.tag}`,
    prerelease: opts.prerelease ?? false,
    draft: opts.draft ?? false,
    published_at: opts.publishedAt ?? '2026-05-19T12:00:00Z',
    assets: [],
  };
}

let scratchDir: string;
beforeEach(async () => {
  scratchDir = join(tmpdir(), `localcode-rel-notes-${randomUUID()}`);
  await mkdir(scratchDir, { recursive: true });
});
afterEach(async () => {
  try {
    await rm(scratchDir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

const cachePath = (): string => join(scratchDir, 'release-notes.json');

describe('fetchReleaseNotesBetween — delta range', () => {
  test('filters strictly between current (exclusive) and latest (inclusive)', async () => {
    const stub = buildFetchStub([
      {
        ok: true,
        body: [
          makeRelease({ tag: 'v0.21.0', body: '## 0.21\n' }),
          makeRelease({ tag: 'v0.20.0', body: '## 0.20\n' }),
          makeRelease({ tag: 'v0.19.0', body: '## 0.19\n' }),
          makeRelease({ tag: 'v0.18.0', body: '## 0.18\n' }),
        ],
      },
    ]);
    const out = await fetchReleaseNotesBetween('local/code', '0.19.0', '0.21.0', {
      fetchFn: stub.fn,
      cachePath: cachePath(),
    });
    expect(out.segments.map((s) => s.version)).toEqual(['0.21.0', '0.20.0']);
    expect(out.notes).toContain('## 0.21');
    expect(out.notes).toContain('## 0.20');
    expect(out.notes).not.toContain('## 0.19');
    expect(out.partial).toBe(false);
  });

  test('empty result when current === latest', async () => {
    const stub = buildFetchStub([{ ok: true, body: [] }]);
    const out = await fetchReleaseNotesBetween('local/code', '0.20.0', '0.20.0', {
      fetchFn: stub.fn,
      cachePath: cachePath(),
    });
    expect(out.segments).toEqual([]);
    expect(out.notes).toBe('');
    expect(out.partial).toBe(false);
    expect(stub.calls.length).toBe(0); // short-circuit, no fetch
  });

  test('partial=true when latest tag missing from the page', async () => {
    const stub = buildFetchStub([
      {
        ok: true,
        body: [
          makeRelease({ tag: 'v0.20.0', body: '## 0.20\n' }),
        ],
      },
    ]);
    const out = await fetchReleaseNotesBetween('local/code', '0.18.0', '0.21.0', {
      fetchFn: stub.fn,
      cachePath: cachePath(),
    });
    expect(out.segments.map((s) => s.version)).toEqual(['0.20.0']);
    expect(out.partial).toBe(true);
  });

  test('non-2xx returns partial+empty without throwing', async () => {
    const stub = buildFetchStub([{ ok: false, status: 503, body: { error: 'down' } }]);
    const out = await fetchReleaseNotesBetween('local/code', '0.19.0', '0.21.0', {
      fetchFn: stub.fn,
      cachePath: cachePath(),
    });
    expect(out.segments).toEqual([]);
    expect(out.partial).toBe(true);
  });

  test('drafts and out-of-range tags are dropped', async () => {
    const stub = buildFetchStub([
      {
        ok: true,
        body: [
          makeRelease({ tag: 'v0.21.0', body: '## 0.21\n' }),
          makeRelease({ tag: 'v0.20.5-draft', body: 'draft', draft: true }),
          makeRelease({ tag: 'v0.20.0', body: '## 0.20\n' }),
          makeRelease({ tag: 'v0.17.0', body: '## 0.17\n' }),
        ],
      },
    ]);
    const out = await fetchReleaseNotesBetween('local/code', '0.19.0', '0.21.0', {
      fetchFn: stub.fn,
      cachePath: cachePath(),
    });
    expect(out.segments.map((s) => s.version)).toEqual(['0.21.0', '0.20.0']);
  });
});

describe('fetchReleaseNotesBetween — disk cache', () => {
  test('second call within TTL hits cache (no second fetch)', async () => {
    const stub = buildFetchStub([
      {
        ok: true,
        body: [
          makeRelease({ tag: 'v0.20.0', body: '## 0.20\n' }),
        ],
      },
    ]);
    let now = 1_000_000;
    const opts = {
      fetchFn: stub.fn,
      cachePath: cachePath(),
      nowFn: (): number => now,
    };
    const first = await fetchReleaseNotesBetween('local/code', '0.19.0', '0.20.0', opts);
    expect(first.segments.length).toBe(1);
    expect(stub.calls.length).toBe(1);

    const second = await fetchReleaseNotesBetween('local/code', '0.19.0', '0.20.0', opts);
    expect(second.segments.length).toBe(1);
    expect(stub.calls.length).toBe(1); // unchanged

    // The on-disk file mentions our key.
    const onDisk = await readFile(cachePath(), 'utf8');
    expect(onDisk).toContain('0.19.0..0.20.0');
  });

  test('TTL expiry forces a refetch', async () => {
    const stub = buildFetchStub([
      {
        ok: true,
        body: [makeRelease({ tag: 'v0.20.0', body: 'a' })],
      },
      {
        ok: true,
        body: [makeRelease({ tag: 'v0.20.0', body: 'b' })],
      },
    ]);
    let now = 1_000_000;
    const opts = {
      fetchFn: stub.fn,
      cachePath: cachePath(),
      nowFn: (): number => now,
    };
    const first = await fetchReleaseNotesBetween('local/code', '0.19.0', '0.20.0', opts);
    expect(first.notes).toContain('a');
    now += NOTES_CACHE_TTL_MS + 1;
    const second = await fetchReleaseNotesBetween('local/code', '0.19.0', '0.20.0', opts);
    expect(second.notes).toContain('b');
    expect(stub.calls.length).toBe(2);
  });
});
