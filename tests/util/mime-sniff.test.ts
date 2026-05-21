/**
 * Magic-number MIME sniff tests.
 *
 * We exercise each supported magic number plus the negative path (random
 * bytes / not-an-image) to lock down behaviour. The file-based variant
 * is also covered using a tmp file.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  sniffImageMime,
  sniffImageMimeFromFile,
} from '@/util/mime-sniff';

describe('sniffImageMime — magic numbers', () => {
  test('PNG → image/png', () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    expect(sniffImageMime(bytes)).toBe('image/png');
  });

  test('JPEG (FF D8 FF E0) → image/jpeg', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(sniffImageMime(bytes)).toBe('image/jpeg');
  });

  test('JPEG (FF D8 FF DB) → image/jpeg', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x00]);
    expect(sniffImageMime(bytes)).toBe('image/jpeg');
  });

  test('GIF87a → image/gif', () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00]);
    expect(sniffImageMime(bytes)).toBe('image/gif');
  });

  test('GIF89a → image/gif', () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00]);
    expect(sniffImageMime(bytes)).toBe('image/gif');
  });

  test('WEBP → image/webp', () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,  // RIFF
      0xff, 0xff, 0xff, 0xff,  // size (irrelevant)
      0x57, 0x45, 0x42, 0x50,  // WEBP
    ]);
    expect(sniffImageMime(bytes)).toBe('image/webp');
  });

  test('HEIC (ftyp heic) → image/heic', () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18,  // box size
      0x66, 0x74, 0x79, 0x70,  // ftyp
      0x68, 0x65, 0x69, 0x63,  // heic brand
    ]);
    expect(sniffImageMime(bytes)).toBe('image/heic');
  });

  test('HEIC (ftyp mif1) → image/heic', () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x20,
      0x66, 0x74, 0x79, 0x70,
      0x6d, 0x69, 0x66, 0x31,
    ]);
    expect(sniffImageMime(bytes)).toBe('image/heic');
  });

  test('HEIC (ftyp heix) → image/heic', () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x20,
      0x66, 0x74, 0x79, 0x70,
      0x68, 0x65, 0x69, 0x78,
    ]);
    expect(sniffImageMime(bytes)).toBe('image/heic');
  });
});

describe('sniffImageMime — rejection paths', () => {
  test('random bytes → null', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);
    expect(sniffImageMime(bytes)).toBeNull();
  });

  test('plain text → null', () => {
    const bytes = new TextEncoder().encode('hello world');
    expect(sniffImageMime(bytes)).toBeNull();
  });

  test('ELF executable → null', () => {
    // ELF magic is 7F 45 4C 46 — a real executable header.
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
    expect(sniffImageMime(bytes)).toBeNull();
  });

  test('PDF (incorrectly extension-renamed) → null', () => {
    // %PDF — would be 25 50 44 46. NOT an image.
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    expect(sniffImageMime(bytes)).toBeNull();
  });

  test('too-short input → null', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBeNull();
  });

  test('empty buffer → null', () => {
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });

  test('ftyp but unknown brand → null', () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x4d, 0x50, 0x34, 0x32,  // "MP42" — MP4, not HEIF
    ]);
    expect(sniffImageMime(bytes)).toBeNull();
  });
});

describe('sniffImageMimeFromFile', () => {
  let tmpDir = '';
  beforeAll(async () => {
    tmpDir = path.join(os.tmpdir(), `lc-sniff-${crypto.randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('reads PNG header from disk and sniffs correctly', async () => {
    const pngPath = path.join(tmpDir, 'real.png');
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    await writeFile(pngPath, pngBytes);
    expect(sniffImageMimeFromFile(pngPath)).toBe('image/png');
  });

  test('rejects fake.png whose content is plain text', async () => {
    const fakePath = path.join(tmpDir, 'fake.png');
    await writeFile(fakePath, 'this is not really a PNG');
    expect(sniffImageMimeFromFile(fakePath)).toBeNull();
  });

  test('returns null for a missing file', () => {
    expect(sniffImageMimeFromFile(path.join(tmpDir, 'no-such.png'))).toBeNull();
  });

  test('returns null for an empty file', async () => {
    const emptyPath = path.join(tmpDir, 'empty.png');
    await writeFile(emptyPath, Buffer.alloc(0));
    expect(sniffImageMimeFromFile(emptyPath)).toBeNull();
  });
});
