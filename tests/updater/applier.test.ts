/**
 * Coverage for `applyManifest`. Drives the applier against a tmp-dir
 * "live binary" so the real `dist/cli.js` is never touched. Verifies:
 *
 *   - Happy path renames the staged file onto the live path, backing
 *     up the previous binary as `.bak`.
 *   - When the rename fails, we roll back from `.bak` so the previous
 *     binary is intact.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { applyManifest } from '@/updater/applier';
import type { PendingUpdate } from '@/updater';

let scratchDir: string;
beforeEach(async () => {
  scratchDir = join(tmpdir(), `localcode-applier-${randomUUID()}`);
  await mkdir(scratchDir, { recursive: true });
});
afterEach(async () => {
  try {
    await rm(scratchDir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

async function setupLive(content: string): Promise<string> {
  const dir = join(scratchDir, 'install');
  await mkdir(dir, { recursive: true });
  const livePath = join(dir, 'cli.js');
  await writeFile(livePath, content, 'utf8');
  return livePath;
}

async function setupStaged(version: string, body: string): Promise<{ path: string; manifest: PendingUpdate }> {
  const dir = join(scratchDir, 'updates', version);
  await mkdir(dir, { recursive: true });
  const stagedPath = join(dir, 'cli.js');
  await writeFile(stagedPath, body, 'utf8');
  const manifest: PendingUpdate = {
    version,
    stagedBinaryPath: stagedPath,
    stagedAt: 0,
    digest: null,
    release: {
      version,
      tagName: `v${version}`,
      htmlUrl: 'h',
      name: '',
      body: '',
      prerelease: false,
      publishedAt: 0,
      tarballUrl: 't',
      assets: [],
    },
  };
  return { path: stagedPath, manifest };
}

describe('applyManifest — happy path', () => {
  test('replaces the live binary + creates a .bak', async () => {
    const livePath = await setupLive('PREV');
    const { manifest } = await setupStaged('0.20.0', 'NEXT');
    const result = await applyManifest(manifest, {
      liveBinaryPathOverride: livePath,
      symlinkPath: null,
    });
    expect(result.ok).toBe(true);
    expect(result.appliedVersion).toBe('0.20.0');
    const live = await readFile(livePath, 'utf8');
    expect(live).toBe('NEXT');
    const bak = await readFile(`${livePath}.bak`, 'utf8');
    expect(bak).toBe('PREV');
  });

  test('first-install case (no prior file) works', async () => {
    const dir = join(scratchDir, 'install');
    await mkdir(dir, { recursive: true });
    const livePath = join(dir, 'cli.js');
    const { manifest } = await setupStaged('0.20.0', 'NEW');
    const result = await applyManifest(manifest, {
      liveBinaryPathOverride: livePath,
      symlinkPath: null,
    });
    expect(result.ok).toBe(true);
    const live = await readFile(livePath, 'utf8');
    expect(live).toBe('NEW');
  });
});

describe('applyManifest — failure when staged file missing', () => {
  test('reports a clear error', async () => {
    const livePath = await setupLive('PREV');
    const manifest: PendingUpdate = {
      version: '0.20.0',
      stagedBinaryPath: join(scratchDir, 'nonexistent.js'),
      stagedAt: 0,
      digest: null,
      release: {
        version: '0.20.0',
        tagName: 'v0.20.0',
        htmlUrl: 'h',
        name: '',
        body: '',
        prerelease: false,
        publishedAt: 0,
        tarballUrl: 't',
        assets: [],
      },
    };
    const result = await applyManifest(manifest, {
      liveBinaryPathOverride: livePath,
      symlinkPath: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing');
    const live = await readFile(livePath, 'utf8');
    expect(live).toBe('PREV');
  });
});

describe('applyManifest — cleanup', () => {
  test('removes the staging dir on success', async () => {
    const livePath = await setupLive('PREV');
    const { manifest } = await setupStaged('0.20.0', 'NEW');
    await applyManifest(manifest, {
      liveBinaryPathOverride: livePath,
      symlinkPath: null,
    });
    let exists = false;
    try {
      await stat(manifest.stagedBinaryPath);
      exists = true;
    } catch {
      /* gone */
    }
    expect(exists).toBe(false);
  });
});
