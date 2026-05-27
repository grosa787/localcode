/**
 * Clipboard image reader tests.
 *
 * The reader shells out to platform-specific tools (`osascript` on
 * macOS, `xclip` on Linux, `powershell` on Windows). We:
 *
 *   - Stub `spawnSync` + `readFile` + `unlink` per case so the tests
 *     never touch the real OS clipboard.
 *   - Verify the happy paths return the expected bytes + MIME.
 *   - Verify every failure mode (tool missing, non-zero exit, empty
 *     bytes, unrecognised MIME) returns null.
 *   - Verify the platform router is exhaustive (unknown platform → null).
 */
import { describe, test, expect } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { readClipboardImage } from '@/util/clipboard';

/** Minimal PNG header — first 8 bytes of any valid PNG file. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Build a fake PNG buffer of length `n` whose first 8 bytes are the magic. */
function fakePng(n = 128): Buffer {
  const buf = Buffer.alloc(Math.max(n, 8));
  PNG_MAGIC.copy(buf, 0);
  return buf;
}

/** Minimal JPEG header — FF D8 FF E0. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
function fakeJpeg(n = 128): Buffer {
  const buf = Buffer.alloc(Math.max(n, 4));
  JPEG_MAGIC.copy(buf, 0);
  return buf;
}

/**
 * Build a fake `spawnSync` that, for each invocation, records the
 * call and returns a canned outcome.
 *
 * Outcomes:
 *   - `{ status: number; stdout?: Buffer }`  — successful or non-zero exit
 *   - `'enoent'`                              — simulate missing binary
 */
type SpawnOutcome =
  | { readonly status: number; readonly stdout?: Buffer; readonly stderr?: Buffer }
  | 'enoent';

interface SpawnCall {
  readonly cmd: string;
  readonly args: readonly string[];
}

function fakeSpawn(
  cmdOutcome: Record<string, SpawnOutcome>,
): { fn: typeof import('node:child_process').spawnSync; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const fn = ((cmd: string, args: readonly string[]): SpawnSyncReturns<Buffer> => {
    calls.push({ cmd, args: [...(args ?? [])] });
    const outcome = cmdOutcome[cmd];
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
    const stdout = outcome.stdout ?? Buffer.alloc(0);
    const stderr = outcome.stderr ?? Buffer.alloc(0);
    return {
      pid: 0,
      output: [null, stdout, stderr],
      stdout,
      stderr,
      status: outcome.status,
      signal: null,
    } as SpawnSyncReturns<Buffer>;
  }) as typeof import('node:child_process').spawnSync;
  return { fn, calls };
}

describe('readClipboardImage — darwin', () => {
  test('returns PNG bytes when osascript succeeds and the temp file holds a PNG', async () => {
    const png = fakePng(256);
    const { fn: spawn, calls } = fakeSpawn({
      osascript: { status: 0, stdout: Buffer.from('ok\n') },
    });
    const result = await readClipboardImage({
      platform: 'darwin',
      spawn,
      readFile: () => png,
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.mime).toBe('image/png');
    expect(result.bytes.byteLength).toBe(png.byteLength);
    expect(result.bytes[0]).toBe(0x89);
    expect(calls.length).toBe(1);
    expect(calls[0]?.cmd).toBe('osascript');
  });

  test('returns null when osascript is missing (ENOENT)', async () => {
    const { fn: spawn } = fakeSpawn({ osascript: 'enoent' });
    const result = await readClipboardImage({
      platform: 'darwin',
      spawn,
      readFile: () => fakePng(),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });

  test('returns null when osascript exits non-zero (no image on clipboard)', async () => {
    const { fn: spawn } = fakeSpawn({
      osascript: { status: 1, stdout: Buffer.alloc(0) },
    });
    const result = await readClipboardImage({
      platform: 'darwin',
      spawn,
      readFile: () => fakePng(),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });

  test('returns null when osascript prints err:... on its stdout', async () => {
    const { fn: spawn } = fakeSpawn({
      osascript: { status: 0, stdout: Buffer.from('err:bad coercion\n') },
    });
    const result = await readClipboardImage({
      platform: 'darwin',
      spawn,
      readFile: () => fakePng(),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });

  test('returns null when the temp file is empty after a successful spawn', async () => {
    const { fn: spawn } = fakeSpawn({
      osascript: { status: 0, stdout: Buffer.from('ok\n') },
    });
    const result = await readClipboardImage({
      platform: 'darwin',
      spawn,
      readFile: () => Buffer.alloc(0),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });

  test('returns null when the temp file contains random non-image bytes', async () => {
    const { fn: spawn } = fakeSpawn({
      osascript: { status: 0, stdout: Buffer.from('ok\n') },
    });
    const result = await readClipboardImage({
      platform: 'darwin',
      spawn,
      readFile: () => Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });

  test('unlinks the temp file after a successful read', async () => {
    const { fn: spawn } = fakeSpawn({
      osascript: { status: 0, stdout: Buffer.from('ok\n') },
    });
    const unlinked: string[] = [];
    const result = await readClipboardImage({
      platform: 'darwin',
      spawn,
      readFile: () => fakePng(),
      unlink: (p) => {
        unlinked.push(p);
      },
      tmpDir: '/tmp',
    });
    expect(result).not.toBeNull();
    expect(unlinked.length).toBeGreaterThan(0);
    expect(unlinked[0]?.startsWith('/tmp/localcode-clipboard-')).toBe(true);
  });
});

describe('readClipboardImage — linux', () => {
  test('returns PNG bytes when xclip succeeds', async () => {
    const png = fakePng(64);
    const { fn: spawn, calls } = fakeSpawn({
      xclip: { status: 0, stdout: png },
    });
    const result = await readClipboardImage({
      platform: 'linux',
      spawn,
      readFile: () => Buffer.alloc(0),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.mime).toBe('image/png');
    expect(result.bytes.byteLength).toBe(png.byteLength);
    expect(calls.length).toBe(1);
    expect(calls[0]?.cmd).toBe('xclip');
    expect(calls[0]?.args).toEqual([
      '-selection',
      'clipboard',
      '-t',
      'image/png',
      '-o',
    ]);
  });

  test('returns null when xclip is missing (ENOENT)', async () => {
    const { fn: spawn } = fakeSpawn({ xclip: 'enoent' });
    const result = await readClipboardImage({
      platform: 'linux',
      spawn,
      readFile: () => Buffer.alloc(0),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });

  test('returns null when xclip exits non-zero (no image on clipboard)', async () => {
    const { fn: spawn } = fakeSpawn({ xclip: { status: 1 } });
    const result = await readClipboardImage({
      platform: 'linux',
      spawn,
      readFile: () => Buffer.alloc(0),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });

  test('returns null when xclip emits non-image bytes', async () => {
    const { fn: spawn } = fakeSpawn({
      xclip: { status: 0, stdout: Buffer.from('not an image at all') },
    });
    const result = await readClipboardImage({
      platform: 'linux',
      spawn,
      readFile: () => Buffer.alloc(0),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });

  test('rejects oversized payloads (> 10 MB)', async () => {
    // Build an 11 MB buffer starting with the PNG magic — sniffer
    // would normally accept, but the size cap should reject.
    const huge = Buffer.alloc(11 * 1024 * 1024);
    PNG_MAGIC.copy(huge, 0);
    const { fn: spawn } = fakeSpawn({
      xclip: { status: 0, stdout: huge },
    });
    const result = await readClipboardImage({
      platform: 'linux',
      spawn,
      readFile: () => Buffer.alloc(0),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });

  test('accepts JPEG bytes (different magic, same path)', async () => {
    const jpeg = fakeJpeg(64);
    const { fn: spawn } = fakeSpawn({
      xclip: { status: 0, stdout: jpeg },
    });
    const result = await readClipboardImage({
      platform: 'linux',
      spawn,
      readFile: () => Buffer.alloc(0),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.mime).toBe('image/jpeg');
  });
});

describe('readClipboardImage — win32', () => {
  test('returns PNG bytes when powershell succeeds and the temp file holds a PNG', async () => {
    const png = fakePng(96);
    const { fn: spawn, calls } = fakeSpawn({
      powershell: { status: 0 },
    });
    const result = await readClipboardImage({
      platform: 'win32',
      spawn,
      readFile: () => png,
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.mime).toBe('image/png');
    expect(result.bytes.byteLength).toBe(png.byteLength);
    expect(calls.length).toBe(1);
    expect(calls[0]?.cmd).toBe('powershell');
  });

  test('returns null when powershell exits non-zero (no image on clipboard)', async () => {
    const { fn: spawn } = fakeSpawn({ powershell: { status: 1 } });
    const result = await readClipboardImage({
      platform: 'win32',
      spawn,
      readFile: () => fakePng(),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });

  test('returns null when powershell is missing (ENOENT)', async () => {
    const { fn: spawn } = fakeSpawn({ powershell: 'enoent' });
    const result = await readClipboardImage({
      platform: 'win32',
      spawn,
      readFile: () => fakePng(),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });

  test('returns null when the temp file read throws (file vanished mid-flow)', async () => {
    const { fn: spawn } = fakeSpawn({ powershell: { status: 0 } });
    const result = await readClipboardImage({
      platform: 'win32',
      spawn,
      readFile: () => {
        throw new Error('ENOENT');
      },
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
  });
});

describe('readClipboardImage — unsupported platform', () => {
  test('aix returns null without spawning anything', async () => {
    const { fn: spawn, calls } = fakeSpawn({});
    const result = await readClipboardImage({
      // Cast through `unknown` to satisfy NodeJS.Platform; aix is a
      // valid Node platform string but not one we support.
      platform: 'aix' as NodeJS.Platform,
      spawn,
      readFile: () => fakePng(),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
    expect(calls.length).toBe(0);
  });

  test('freebsd returns null without spawning anything', async () => {
    const { fn: spawn, calls } = fakeSpawn({});
    const result = await readClipboardImage({
      platform: 'freebsd' as NodeJS.Platform,
      spawn,
      readFile: () => fakePng(),
      unlink: () => undefined,
      tmpDir: '/tmp',
    });
    expect(result).toBeNull();
    expect(calls.length).toBe(0);
  });
});
