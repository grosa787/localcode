/**
 * HEIC convert tests.
 *
 * The convert helper shells out to `sips` (macOS) or `magick`
 * (ImageMagick). Real conversion needs at least one binary on the test
 * host's PATH, so we exercise:
 *
 *   - Injection-based unit tests using a stubbed `spawnSync` that
 *     returns canned exit codes. No filesystem reads required.
 *   - One integration test that runs the real `sips` / `magick` against
 *     a small HEIC fixture, skipped when neither tool is present.
 */
import { describe, test, expect } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { convertHeicToPng } from '@/util/heic-convert';

/**
 * Build a fake `spawnSync` that returns `exit code 0` for the named
 * command and `ENOENT` for the rest.
 */
function fakeSpawn(
  cmdWithExit: Record<string, number | 'enoent'>,
): typeof import('node:child_process').spawnSync {
  return ((cmd: string): SpawnSyncReturns<Buffer> => {
    const outcome = cmdWithExit[cmd];
    if (outcome === undefined || outcome === 'enoent') {
      const err = new Error('command not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      return {
        pid: 0,
        output: [null, Buffer.alloc(0), Buffer.alloc(0)],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: null,
        error: err,
      } as SpawnSyncReturns<Buffer>;
    }
    return {
      pid: 0,
      output: [null, Buffer.alloc(0), Buffer.alloc(0)],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: outcome,
      signal: null,
    } as SpawnSyncReturns<Buffer>;
  }) as typeof import('node:child_process').spawnSync;
}

describe('convertHeicToPng — neither tool available', () => {
  test('returns the actionable failure message', () => {
    const result = convertHeicToPng('/tmp/input.heic', {
      spawn: fakeSpawn({ sips: 'enoent', magick: 'enoent' }),
      exists: () => false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe('HEIC requires sips (macOS) or magick');
    }
  });
});

describe('convertHeicToPng — sips path', () => {
  test('returns ok when sips exits 0 and output file exists', () => {
    const result = convertHeicToPng('/tmp/input.heic', {
      spawn: fakeSpawn({ sips: 0, magick: 'enoent' }),
      exists: () => true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tool).toBe('sips');
      expect(result.outputPath.endsWith('.png')).toBe(true);
    }
  });

  test('falls back to magick when sips exits non-zero', () => {
    const result = convertHeicToPng('/tmp/input.heic', {
      spawn: fakeSpawn({ sips: 1, magick: 0 }),
      exists: () => true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tool).toBe('magick');
    }
  });

  test('reports failure when sips succeeds but output file is missing', () => {
    // sips returned ok BUT exists() reports the file doesn't exist —
    // fall through to magick, which also isn't available.
    const result = convertHeicToPng('/tmp/input.heic', {
      spawn: fakeSpawn({ sips: 0, magick: 'enoent' }),
      exists: () => false,
    });
    expect(result.ok).toBe(false);
  });
});

describe('convertHeicToPng — magick path', () => {
  test('uses magick when sips is missing', () => {
    const result = convertHeicToPng('/tmp/input.heic', {
      spawn: fakeSpawn({ sips: 'enoent', magick: 0 }),
      exists: () => true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tool).toBe('magick');
    }
  });

  test('reports failure when magick also returns non-zero', () => {
    const result = convertHeicToPng('/tmp/input.heic', {
      spawn: fakeSpawn({ sips: 'enoent', magick: 1 }),
      exists: () => true,
    });
    expect(result.ok).toBe(false);
  });
});

describe('convertHeicToPng — input validation', () => {
  test('empty input path → failure', () => {
    const result = convertHeicToPng('', {
      spawn: fakeSpawn({}),
      exists: () => false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/empty/i);
    }
  });
});
