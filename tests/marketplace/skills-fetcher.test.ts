/**
 * skills-fetcher tests — uses a mocked globalThis.fetch to return canned
 * GitHub API responses, ensuring NO real network traffic is made. Covers:
 *
 *   - Catalog parsing (subdirectory listing → SKILL.md fetch → frontmatter).
 *   - Cache TTL (fresh cache short-circuits the network).
 *   - Rate-limit fallback (403 → returns cached entries with rateLimited: true).
 *   - Install path resolution (target='global' and target='project').
 *   - Install body fetch + atomic write.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
  fetchSkillCatalog,
  installSkill,
} from '@/marketplace/skills-fetcher';
import type { MarketplaceSkill } from '@/marketplace/types';

type FetchImpl = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

function captureHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (h === undefined) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const pair of h) {
      if (Array.isArray(pair) && pair.length === 2) {
        const [k, v] = pair;
        if (typeof k === 'string' && typeof v === 'string') out[k] = v;
      }
    }
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) {
    out[k] = String(v);
  }
  return out;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

let cacheDir = '';

beforeEach(async () => {
  cacheDir = path.join(os.tmpdir(), `lc-skills-cache-${crypto.randomUUID()}`);
  await mkdir(cacheDir, { recursive: true });
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('fetchSkillCatalog — parsing', () => {
  test('parses subdirectory listing + SKILL.md frontmatter', async () => {
    const recorded: RecordedRequest[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      const u = String(url);
      recorded.push({ url: u, headers: captureHeaders(init) });

      if (u.endsWith('/contents')) {
        return jsonResponse(
          200,
          [
            {
              name: 'code-review',
              type: 'dir',
              path: 'code-review',
              url: 'https://api.github.com/repos/anthropics/skills/contents/code-review',
              html_url: 'https://github.com/anthropics/skills/tree/main/code-review',
            },
            {
              name: 'README.md',
              type: 'file',
              path: 'README.md',
              url: 'https://api.github.com/repos/anthropics/skills/contents/README.md',
              html_url: 'https://github.com/anthropics/skills/blob/main/README.md',
            },
            {
              name: 'debugging',
              type: 'dir',
              path: 'debugging',
              url: 'https://api.github.com/repos/anthropics/skills/contents/debugging',
              html_url: 'https://github.com/anthropics/skills/tree/main/debugging',
            },
          ],
          { etag: '"abc123"' },
        );
      }
      if (u.endsWith('/code-review/SKILL.md')) {
        return textResponse(
          200,
          '---\nname: Code Review\ndescription: Review code changes thoroughly\n---\n\n# Code Review\n\nDo it.\n',
        );
      }
      if (u.endsWith('/debugging/SKILL.md')) {
        return textResponse(
          200,
          '---\nname: Debugging Helper\ndescription: Find root causes fast\n---\n\nBody.\n',
        );
      }
      return new Response('not found', { status: 404 });
    };

    const result = await fetchSkillCatalog({
      cacheDir,
      fetchImpl,
    });

    expect(result.entries.length).toBe(2);
    const byId = new Map(result.entries.map((e) => [e.id, e]));
    expect(byId.get('code-review')?.name).toBe('Code Review');
    expect(byId.get('code-review')?.description).toBe(
      'Review code changes thoroughly',
    );
    expect(byId.get('code-review')?.installPath).toBe('code-review.md');
    expect(byId.get('debugging')?.name).toBe('Debugging Helper');
    expect(result.stale).toBe(false);
    expect(result.rateLimited).toBe(false);

    // Listing request carries the GitHub API accept header.
    const listing = recorded.find((r) => r.url.endsWith('/contents'));
    expect(listing).toBeDefined();
    expect((listing as RecordedRequest).headers['accept']).toContain(
      'application/vnd.github',
    );
  });

  test('falls back to README.md when SKILL.md missing', async () => {
    let skillCalls = 0;
    const fetchImpl: FetchImpl = async (url) => {
      const u = String(url);
      if (u.endsWith('/contents')) {
        return jsonResponse(200, [
          {
            name: 'helper',
            type: 'dir',
            path: 'helper',
            url: 'https://api.github.com/x',
            html_url: 'https://github.com/anthropics/skills/tree/main/helper',
          },
        ]);
      }
      if (u.endsWith('/helper/SKILL.md')) {
        skillCalls += 1;
        return new Response('nope', { status: 404 });
      }
      if (u.endsWith('/helper/README.md')) {
        return textResponse(200, '---\nname: H\ndescription: D\n---\nBody');
      }
      return new Response('not found', { status: 404 });
    };

    const result = await fetchSkillCatalog({ cacheDir, fetchImpl });
    expect(skillCalls).toBe(1);
    expect(result.entries[0]?.name).toBe('H');
  });
});

describe('fetchSkillCatalog — cache TTL', () => {
  test('fresh cache short-circuits the network', async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return jsonResponse(200, []);
    };

    // Pre-seed a fresh cache.
    const cacheFile = path.join(cacheDir, 'skills-cache.json');
    await writeFile(
      cacheFile,
      JSON.stringify({
        fetchedAt: Date.now(),
        etag: '"cached"',
        entries: [
          {
            id: 'cached-one',
            name: 'Cached One',
            description: 'Already on disk',
            source: 'anthropics',
            url: 'https://example.test',
            installPath: 'cached-one.md',
          },
        ],
      }),
      'utf8',
    );

    const result = await fetchSkillCatalog({
      cacheDir,
      cacheTtlMs: 60_000,
      fetchImpl,
    });

    expect(calls).toBe(0);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.id).toBe('cached-one');
    expect(result.stale).toBe(false);
    expect(result.ageMs).toBeGreaterThanOrEqual(0);
  });

  test('expired cache triggers a re-fetch', async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async (url) => {
      calls += 1;
      const u = String(url);
      if (u.endsWith('/contents')) return jsonResponse(200, []);
      return new Response('', { status: 404 });
    };

    const cacheFile = path.join(cacheDir, 'skills-cache.json');
    await writeFile(
      cacheFile,
      JSON.stringify({
        fetchedAt: Date.now() - 10 * 60 * 60 * 1000,
        entries: [
          {
            id: 'stale',
            name: 'Stale',
            description: '',
            source: 'anthropics',
            url: 'https://example.test',
            installPath: 'stale.md',
          },
        ],
      }),
      'utf8',
    );

    const result = await fetchSkillCatalog({
      cacheDir,
      cacheTtlMs: 60_000,
      fetchImpl,
    });

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(result.entries.length).toBe(0);
  });

  test('force=true bypasses fresh cache', async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async (url) => {
      calls += 1;
      const u = String(url);
      if (u.endsWith('/contents')) return jsonResponse(200, []);
      return new Response('', { status: 404 });
    };
    const cacheFile = path.join(cacheDir, 'skills-cache.json');
    await writeFile(
      cacheFile,
      JSON.stringify({ fetchedAt: Date.now(), entries: [] }),
      'utf8',
    );

    await fetchSkillCatalog({ cacheDir, fetchImpl, force: true });
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

describe('fetchSkillCatalog — rate-limit + 304 fallback', () => {
  test('403 returns cached entries with rateLimited flag', async () => {
    const cacheFile = path.join(cacheDir, 'skills-cache.json');
    await writeFile(
      cacheFile,
      JSON.stringify({
        fetchedAt: Date.now() - 10 * 60 * 60 * 1000, // expired
        entries: [
          {
            id: 'cached-fallback',
            name: 'Cached',
            description: '',
            source: 'anthropics',
            url: 'https://example.test',
            installPath: 'cached-fallback.md',
          },
        ],
      }),
      'utf8',
    );

    const fetchImpl: FetchImpl = async () =>
      new Response('rate limited', { status: 403 });

    const result = await fetchSkillCatalog({
      cacheDir,
      cacheTtlMs: 60_000,
      fetchImpl,
    });
    expect(result.rateLimited).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.entries[0]?.id).toBe('cached-fallback');
  });

  test('304 with cached entries refreshes fetchedAt timestamp', async () => {
    const cacheFile = path.join(cacheDir, 'skills-cache.json');
    await writeFile(
      cacheFile,
      JSON.stringify({
        fetchedAt: Date.now() - 10 * 60 * 60 * 1000,
        etag: '"cached-etag"',
        entries: [
          {
            id: 'unchanged',
            name: 'Unchanged',
            description: '',
            source: 'anthropics',
            url: 'https://example.test',
            installPath: 'unchanged.md',
          },
        ],
      }),
      'utf8',
    );

    const seenHeaders: Record<string, string> = {};
    const fetchImpl: FetchImpl = async (_url, init) => {
      Object.assign(seenHeaders, captureHeaders(init));
      return new Response('', { status: 304 });
    };

    const result = await fetchSkillCatalog({
      cacheDir,
      cacheTtlMs: 60_000,
      fetchImpl,
    });
    expect(result.stale).toBe(false);
    expect(result.rateLimited).toBe(false);
    expect(result.entries[0]?.id).toBe('unchanged');
    expect(seenHeaders['if-none-match']).toBe('"cached-etag"');
  });

  test('network exception with no cache returns empty list (no throw)', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('socket reset');
    };
    const result = await fetchSkillCatalog({ cacheDir, fetchImpl });
    expect(result.entries).toEqual([]);
    expect(result.stale).toBe(false);
  });
});

describe('installSkill — install path resolution', () => {
  test("target='global' writes into the user's global skills dir", async () => {
    // We DON'T fake $HOME — Node caches homedir() at startup and ignores
    // env mutations. Instead use a unique installPath under the real
    // ~/.localcode/skills so we always start from a clean slate, then
    // clean up afterwards.
    const uniqueId = `lc-test-${crypto.randomUUID()}`;
    const skill: MarketplaceSkill = {
      id: uniqueId,
      name: 'Demo',
      description: 'd',
      source: 'anthropics',
      url: 'https://raw.example/demo.md',
      installPath: `${uniqueId}.md`,
    };
    const fetchImpl: FetchImpl = async () =>
      textResponse(200, '---\nname: Demo\n---\nBody!');

    const result = await installSkill(skill, 'global', { fetchImpl });
    try {
      expect(result.installedAt).toContain(
        path.join('.localcode', 'skills', `${uniqueId}.md`),
      );
      const body = await readFile(result.installedAt, 'utf8');
      expect(body).toContain('Body!');
    } finally {
      await rm(result.installedAt, { force: true });
    }
  });

  test("target='project' requires projectRoot and writes there", async () => {
    const projectRoot = path.join(
      os.tmpdir(),
      `lc-proj-${crypto.randomUUID()}`,
    );
    await mkdir(projectRoot, { recursive: true });
    try {
      const skill: MarketplaceSkill = {
        id: 'p-demo',
        name: 'PDemo',
        description: '',
        source: 'anthropics',
        url: 'https://raw.example/p.md',
        installPath: 'p-demo.md',
      };
      const fetchImpl: FetchImpl = async () =>
        textResponse(200, '# project skill');

      await expect(
        installSkill(skill, 'project', { fetchImpl }),
      ).rejects.toThrow(/projectRoot/);

      const result = await installSkill(skill, 'project', {
        projectRoot,
        fetchImpl,
      });
      expect(result.installedAt).toBe(
        path.join(projectRoot, '.localcode', 'skills', 'p-demo.md'),
      );
      const body = await readFile(result.installedAt, 'utf8');
      expect(body).toContain('# project skill');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite an existing skill', async () => {
    const projectRoot = path.join(
      os.tmpdir(),
      `lc-proj2-${crypto.randomUUID()}`,
    );
    const targetDir = path.join(projectRoot, '.localcode', 'skills');
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, 'dup.md'), 'existing', 'utf8');
    try {
      const skill: MarketplaceSkill = {
        id: 'dup',
        name: 'Dup',
        description: '',
        source: 'anthropics',
        url: 'https://raw.example/dup.md',
        installPath: 'dup.md',
      };
      const fetchImpl: FetchImpl = async () =>
        textResponse(200, 'new body');
      await expect(
        installSkill(skill, 'project', { projectRoot, fetchImpl }),
      ).rejects.toThrow(/already installed/);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test('install falls back to frontmatter stub on fetch failure', async () => {
    const projectRoot = path.join(
      os.tmpdir(),
      `lc-proj3-${crypto.randomUUID()}`,
    );
    await mkdir(projectRoot, { recursive: true });
    try {
      const skill: MarketplaceSkill = {
        id: 'stub',
        name: 'Stub Skill',
        description: 'Falls back',
        source: 'anthropics',
        url: 'https://raw.example/stub.md',
        installPath: 'stub.md',
      };
      const fetchImpl: FetchImpl = async () => {
        throw new Error('offline');
      };
      const result = await installSkill(skill, 'project', {
        projectRoot,
        fetchImpl,
      });
      const body = await readFile(result.installedAt, 'utf8');
      expect(body).toContain('name: Stub Skill');
      expect(body).toContain('description: Falls back');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
