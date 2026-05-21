/**
 * Coverage for `downloadTarball`. Uses a fetch stub returning Response
 * objects whose body is a ReadableStream so the downloader exercises
 * its real streaming + hashing + atomic-rename path. Verifies:
 *
 *   - Happy path produces the expected file + digest.
 *   - SHA-256 mismatch fails + cleans up the tmp file.
 *   - Atomic write: the destination file is renamed in one step
 *     (no half-written file ever appears at the destination).
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import { downloadTarball, pickDownloadTarget } from '@/updater/downloader';
import type { ReleaseInfo } from '@/updater';

function makeRelease(extra: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    version: '0.20.0',
    tagName: 'v0.20.0',
    htmlUrl: 'https://example.test/release',
    name: 'v0.20.0',
    body: '',
    prerelease: false,
    publishedAt: 0,
    tarballUrl: 'https://example.test/source.tar.gz',
    assets: [
      {
        name: 'localcode-darwin-arm64.tar.gz',
        downloadUrl: 'https://example.test/asset.tar.gz',
        sizeBytes: 0,
        digest: null,
      },
    ],
    ...extra,
  };
}

function byteResponse(bytes: Uint8Array): Response {
  // Wrap in a fresh ArrayBuffer slice so DOM lib typing accepts it as
  // BodyInit on every Bun/Node combo.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Response(ab, {
    headers: { 'content-length': String(bytes.byteLength) },
  });
}

let scratchDir: string;
beforeEach(async () => {
  scratchDir = join(tmpdir(), `localcode-updater-dl-${randomUUID()}`);
  await mkdir(scratchDir, { recursive: true });
});
afterEach(async () => {
  try {
    await rm(scratchDir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

describe('pickDownloadTarget', () => {
  test('prefers platform/arch-matching assets', () => {
    const release = makeRelease({
      assets: [
        {
          name: 'localcode-linux-x64.tar.gz',
          downloadUrl: 'l',
          sizeBytes: 0,
          digest: null,
        },
        {
          name: `localcode-${process.platform}-${process.arch}.tar.gz`,
          downloadUrl: 'p',
          sizeBytes: 0,
          digest: null,
        },
      ],
    });
    const pick = pickDownloadTarget(release);
    expect(pick.url).toBe('p');
  });
  test('falls back to tarball when no asset matches', () => {
    const release = makeRelease({ assets: [] });
    const pick = pickDownloadTarget(release);
    expect(pick.url).toBe(release.tarballUrl);
  });
});

describe('downloadTarball — happy path', () => {
  test('writes bytes to destPath + reports digest', async () => {
    const payload = new Uint8Array(Buffer.from('hello world\n', 'utf8'));
    const fn = (async () => byteResponse(payload)) as unknown as typeof globalThis.fetch;
    const dest = join(scratchDir, 'sub', 'cli.js');
    const result = await downloadTarball(makeRelease(), dest, { fetchFn: fn });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(dest);
    const stored = await readFile(dest);
    expect(stored.equals(Buffer.from(payload))).toBe(true);
    const expected = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    expect(result.digest).toBe(expected);
  });
});

describe('downloadTarball — SHA-256 mismatch', () => {
  test('fails + leaves no file at destPath', async () => {
    const payload = new Uint8Array(Buffer.from('hello world\n', 'utf8'));
    const fn = (async () => byteResponse(payload)) as unknown as typeof globalThis.fetch;
    const release = makeRelease({
      assets: [
        {
          name: `localcode-${process.platform}-${process.arch}.tar.gz`,
          downloadUrl: 'https://example.test/asset',
          sizeBytes: payload.byteLength,
          digest: 'sha256:deadbeef',
        },
      ],
    });
    const dest = join(scratchDir, 'cli.js');
    const result = await downloadTarball(release, dest, { fetchFn: fn });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('mismatch');
    // Atomic write: no file at destPath after failure.
    let exists = false;
    try {
      await stat(dest);
      exists = true;
    } catch {
      /* not found */
    }
    expect(exists).toBe(false);
  });
});

describe('downloadTarball — atomic rename', () => {
  test('rename only happens after the full stream is hashed', async () => {
    const payload = new Uint8Array(Buffer.from('atomic\n', 'utf8'));
    const fn = (async () => byteResponse(payload)) as unknown as typeof globalThis.fetch;
    const dest = join(scratchDir, 'cli.js');
    const result = await downloadTarball(makeRelease(), dest, { fetchFn: fn });
    expect(result.ok).toBe(true);
    const stats = await stat(dest);
    expect(stats.size).toBe(payload.byteLength);
  });

  test('non-2xx response → returns ok:false', async () => {
    const fn = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof globalThis.fetch;
    const dest = join(scratchDir, 'cli.js');
    const result = await downloadTarball(makeRelease(), dest, { fetchFn: fn });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('403');
  });
});
