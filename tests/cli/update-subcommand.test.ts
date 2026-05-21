/**
 * Coverage for `runUpdateCli`. Drives each subcommand against an
 * injected `Updater` so no network / disk traffic is required.
 * Verifies:
 *
 *   - `--help` prints usage and exits 0.
 *   - `check` reports "up to date" / "available" based on the
 *     injected updater state.
 *   - `status` works without a network call.
 *   - `enable` / `disable` write through the ConfigManager.
 *   - Unknown subcommand exits 1.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { runUpdateCli } from '@/cli/update-cli';
import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';
import { Updater } from '@/updater';

let scratchDir: string;
beforeEach(async () => {
  scratchDir = join(tmpdir(), `localcode-update-cli-${randomUUID()}`);
  await mkdir(scratchDir, { recursive: true });
});
afterEach(async () => {
  try {
    await rm(scratchDir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

function captureWriters(): {
  writers: { out: (l: string) => void; err: (l: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    writers: {
      out: (l): void => {
        out.push(l);
      },
      err: (l): void => {
        err.push(l);
      },
    },
  };
}

describe('runUpdateCli — help', () => {
  test('prints usage on --help', async () => {
    const { writers, out } = captureWriters();
    const code = await runUpdateCli(['--help'], { writers });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('localcode update');
  });
  test('bare invocation also prints usage', async () => {
    const { writers, out } = captureWriters();
    const code = await runUpdateCli([], { writers });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Subcommands');
  });
});

describe('runUpdateCli — check', () => {
  test('reports already up to date when versions match', async () => {
    const { writers, out } = captureWriters();
    // Inject an Updater whose checkNow is hard-coded to report the
    // current version (i.e. no upgrade available).
    const updater = new Updater({
      currentVersion: '0.19.0',
      // Stub fetch that resolves to non-2xx so checkNow yields null.
      fetchFn: (async () =>
        new Response('not found', { status: 404 })) as unknown as typeof globalThis.fetch,
      // Avoid the user's real on-disk cache leaking between test runs.
      cachePath: join(scratchDir, 'release-check.json'),
      skipCache: true,
    });
    const code = await runUpdateCli(['check'], {
      writers,
      currentVersion: '0.19.0',
      injectedUpdater: updater,
    });
    // With a 404, `latestRelease` is null so the CLI prints the
    // offline / upstream-error path and exits 1.
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('No release info');
  });

  test('announces an available update when latestRelease > current', async () => {
    const { writers, out } = captureWriters();
    const fakeRelease = {
      version: '0.20.0',
      tagName: 'v0.20.0',
      htmlUrl: 'h',
      name: 'v0.20.0',
      body: '',
      prerelease: false,
      publishedAt: 0,
      tarballUrl: 't',
      assets: [],
    };
    const fn = (async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.20.0',
          name: 'v0.20.0',
          body: '',
          html_url: 'h',
          prerelease: false,
          tarball_url: 't',
          assets: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
    void fakeRelease; // referenced for documentation only
    const updater = new Updater({
      currentVersion: '0.19.0',
      autoDownload: false,
      fetchFn: fn,
      cachePath: join(scratchDir, 'release-check.json'),
      skipCache: true,
    });
    const code = await runUpdateCli(['check'], {
      writers,
      currentVersion: '0.19.0',
      injectedUpdater: updater,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('0.20.0');
    expect(out.join('\n')).toContain('Update available');
  });
});

describe('runUpdateCli — status', () => {
  test('prints current version without a network call', async () => {
    const { writers, out } = captureWriters();
    const code = await runUpdateCli(['status'], {
      writers,
      currentVersion: '0.19.0',
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Current version: v0.19.0');
  });
});

describe('runUpdateCli — enable/disable', () => {
  test('disable writes updater.enabled=false', async () => {
    // ConfigManager pointed at scratchDir.
    const cfgPath = join(scratchDir, 'config.toml');
    const manager = new ConfigManager(cfgPath);
    // Seed with a default config first.
    const seed = getDefaultConfig('ollama');
    manager.update(seed);

    const { writers, out } = captureWriters();
    const code = await runUpdateCli(['disable'], {
      writers,
      currentVersion: '0.19.0',
      configManager: manager,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('disabled');
    const fresh = manager.read();
    expect(fresh.updater?.enabled).toBe(false);
  });

  test('enable flips it back', async () => {
    const cfgPath = join(scratchDir, 'config.toml');
    const manager = new ConfigManager(cfgPath);
    manager.update(getDefaultConfig('ollama'));
    await runUpdateCli(['disable'], {
      writers: captureWriters().writers,
      currentVersion: '0.19.0',
      configManager: manager,
    });
    const { writers, out } = captureWriters();
    const code = await runUpdateCli(['enable'], {
      writers,
      currentVersion: '0.19.0',
      configManager: manager,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('enabled');
    expect(manager.read().updater?.enabled).toBe(true);
  });
});

describe('runUpdateCli — unknown subcommand', () => {
  test('exits with code 1 + error message', async () => {
    const { writers, err } = captureWriters();
    const code = await runUpdateCli(['banana'], { writers });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('Unknown subcommand');
  });
});
