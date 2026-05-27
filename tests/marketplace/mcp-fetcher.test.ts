/**
 * mcp-fetcher tests — uses a mocked globalThis.fetch to canned-response
 * the modelcontextprotocol/servers GitHub catalog. Covers:
 *
 *   - Catalog parsing (subdirectory listing → package.json + README scrape).
 *   - Cache TTL (fresh cache short-circuits, expired refetches).
 *   - Rate-limit fallback (403 → cached + rateLimited flag).
 *   - Install path resolution (writes mcpServers entry to the config TOML
 *     via ConfigManager, env-var values seeded correctly).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  mkdir,
  rm,
  writeFile,
  readFile,
} from 'node:fs/promises';
import {
  fetchMcpCatalog,
  installMcpServer,
} from '@/marketplace/mcp-fetcher';
import { ConfigManager } from '@/config/config-manager';
import type { MarketplaceMcpServer } from '@/marketplace/types';

type FetchImpl = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

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
const realFetch = globalThis.fetch;

beforeEach(async () => {
  cacheDir = path.join(os.tmpdir(), `lc-mcp-cache-${crypto.randomUUID()}`);
  await mkdir(cacheDir, { recursive: true });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(cacheDir, { recursive: true, force: true });
});

describe('fetchMcpCatalog — parsing', () => {
  test('parses subdirectory listing + package.json/README', async () => {
    const fetchImpl: FetchImpl = async (url) => {
      const u = String(url);
      if (u.endsWith('/contents/src')) {
        return jsonResponse(200, [
          {
            name: 'github',
            type: 'dir',
            path: 'src/github',
            url: 'https://api.github.com/x',
            html_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
          },
          {
            name: 'filesystem',
            type: 'dir',
            path: 'src/filesystem',
            url: 'https://api.github.com/x',
            html_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
          },
        ]);
      }
      if (u.endsWith('/github/package.json')) {
        return textResponse(
          200,
          JSON.stringify({
            name: '@modelcontextprotocol/server-github',
            description: 'GitHub MCP server',
          }),
        );
      }
      if (u.endsWith('/github/README.md')) {
        return textResponse(
          200,
          [
            '# GitHub MCP',
            '',
            'Set `GITHUB_PERSONAL_ACCESS_TOKEN`:',
            '',
            '```json',
            '{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }',
            '```',
          ].join('\n'),
        );
      }
      if (u.endsWith('/filesystem/package.json')) {
        return textResponse(
          200,
          JSON.stringify({
            name: '@modelcontextprotocol/server-filesystem',
            description: 'Filesystem MCP server',
          }),
        );
      }
      if (u.endsWith('/filesystem/README.md')) {
        return textResponse(
          200,
          'Run with: `npx -y @modelcontextprotocol/server-filesystem /tmp`',
        );
      }
      return new Response('not found', { status: 404 });
    };

    const result = await fetchMcpCatalog({ cacheDir, fetchImpl });
    expect(result.entries.length).toBe(2);

    const gh = result.entries.find((e) => e.id === 'github');
    expect(gh).toBeDefined();
    expect(gh?.description).toBe('GitHub MCP server');
    expect(gh?.command).toBe('npx');
    expect(gh?.args).toContain('@modelcontextprotocol/server-github');
    expect(gh?.envVars).toContain('GITHUB_PERSONAL_ACCESS_TOKEN');

    const fs = result.entries.find((e) => e.id === 'filesystem');
    expect(fs).toBeDefined();
    expect(fs?.command).toBe('npx');
  });
});

describe('fetchMcpCatalog — cache TTL', () => {
  test('fresh cache short-circuits the network', async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return jsonResponse(200, []);
    };
    const cacheFile = path.join(cacheDir, 'mcp-cache.json');
    await writeFile(
      cacheFile,
      JSON.stringify({
        fetchedAt: Date.now(),
        entries: [
          {
            id: 'cached',
            name: 'Cached',
            description: '',
            source: 'community',
            url: 'https://example.test',
            command: 'npx',
            args: [],
            envVars: [],
          },
        ],
      }),
      'utf8',
    );

    const result = await fetchMcpCatalog({
      cacheDir,
      cacheTtlMs: 60_000,
      fetchImpl,
    });
    expect(calls).toBe(0);
    expect(result.entries[0]?.id).toBe('cached');
  });

  test('expired cache triggers re-fetch', async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async (url) => {
      calls += 1;
      const u = String(url);
      if (u.endsWith('/contents/src')) return jsonResponse(200, []);
      return new Response('', { status: 404 });
    };
    const cacheFile = path.join(cacheDir, 'mcp-cache.json');
    await writeFile(
      cacheFile,
      JSON.stringify({
        fetchedAt: Date.now() - 10 * 60 * 60 * 1000,
        entries: [],
      }),
      'utf8',
    );
    await fetchMcpCatalog({ cacheDir, cacheTtlMs: 60_000, fetchImpl });
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

describe('fetchMcpCatalog — rate-limit fallback', () => {
  test('403 returns cached entries with rateLimited flag', async () => {
    const cacheFile = path.join(cacheDir, 'mcp-cache.json');
    await writeFile(
      cacheFile,
      JSON.stringify({
        fetchedAt: Date.now() - 10 * 60 * 60 * 1000,
        entries: [
          {
            id: 'stash',
            name: 'Stash',
            description: '',
            source: 'community',
            url: 'https://example.test',
            command: 'npx',
            args: [],
            envVars: [],
          },
        ],
      }),
      'utf8',
    );

    const fetchImpl: FetchImpl = async () =>
      new Response('rate limited', { status: 403 });

    const result = await fetchMcpCatalog({
      cacheDir,
      cacheTtlMs: 60_000,
      fetchImpl,
    });
    expect(result.rateLimited).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.entries[0]?.id).toBe('stash');
  });
});

describe('installMcpServer — config write path', () => {
  test('writes mcpServers entry into config TOML with env values', async () => {
    const tmpDir = path.join(os.tmpdir(), `lc-mcp-cfg-${crypto.randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    const cfgPath = path.join(tmpDir, 'config.toml');
    // Seed a minimal valid config so update() can deep-merge.
    await writeFile(
      cfgPath,
      [
        '[backend]',
        'type = "ollama"',
        'baseUrl = "http://localhost:11434"',
        '',
        '[model]',
        'current = "test"',
        'available = ["test"]',
        '',
        '[onboarding]',
        'completed = true',
        '',
        '[permissions]',
        'autoApprove = []',
        'profile = "default"',
        '',
        'outputStyle = "concise"',
        '',
      ].join('\n'),
      'utf8',
    );
    const manager = new ConfigManager(cfgPath);
    try {
      const server: MarketplaceMcpServer = {
        id: 'github',
        name: 'github',
        description: 'GitHub MCP server',
        source: 'community',
        url: 'https://example.test',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        envVars: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
      };
      const result = await installMcpServer(server, {
        configManager: manager,
        envValues: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxx' },
      });
      expect(result.installedAs).toBe('github');

      const updated = manager.read();
      const mcp = updated.mcpServers ?? {};
      expect(mcp['github']).toBeDefined();
      const entry = mcp['github'] as {
        type: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      };
      expect(entry.type).toBe('stdio');
      expect(entry.command).toBe('npx');
      expect(entry.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
      expect(entry.env?.['GITHUB_PERSONAL_ACCESS_TOKEN']).toBe('ghp_xxx');

      // The on-disk TOML carries the entry too.
      const toml = await readFile(cfgPath, 'utf8');
      expect(toml).toContain('mcpServers');
      expect(toml).toContain('github');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite an existing mcpServers entry', async () => {
    const tmpDir = path.join(os.tmpdir(), `lc-mcp-cfg2-${crypto.randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    const cfgPath = path.join(tmpDir, 'config.toml');
    await writeFile(
      cfgPath,
      [
        '[backend]',
        'type = "ollama"',
        'baseUrl = "http://localhost:11434"',
        '',
        '[model]',
        'current = "test"',
        'available = ["test"]',
        '',
        '[onboarding]',
        'completed = true',
        '',
        '[permissions]',
        'autoApprove = []',
        'profile = "default"',
        '',
        'outputStyle = "concise"',
        '',
        '[mcpServers.dup]',
        'type = "stdio"',
        'command = "npx"',
        'args = ["-y", "x"]',
        '',
      ].join('\n'),
      'utf8',
    );
    const manager = new ConfigManager(cfgPath);
    try {
      const server: MarketplaceMcpServer = {
        id: 'dup',
        name: 'dup',
        description: '',
        source: 'community',
        url: 'https://example.test',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-dup'],
        envVars: [],
      };
      await expect(
        installMcpServer(server, { configManager: manager }),
      ).rejects.toThrow(/already configured/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
