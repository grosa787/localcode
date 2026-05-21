/**
 * Magic-number-based MIME sniffer for image bytes.
 *
 * Why: trusting an extension alone is dangerous — a user could rename
 * `evil.exe` to `evil.png` and the model would happily be fed bytes that
 * downstream code thought were a PNG. Every byte we send to a vision
 * model passes through this sniffer first; the extension is at most a
 * hint. When the sniffer disagrees with the extension we trust the
 * sniffer (or reject, depending on caller policy).
 *
 * We inspect the first 16 bytes of the file. Each known image format has
 * a unique leading byte signature ("magic number") well-documented at
 * https://en.wikipedia.org/wiki/List_of_file_signatures.
 *
 *   PNG  89 50 4E 47 0D 0A 1A 0A
 *   JPEG FF D8 FF
 *   WEBP 52 49 46 46 ?? ?? ?? ?? 57 45 42 50  ("RIFF....WEBP")
 *   GIF  47 49 46 38 (37|39) 61                ("GIF87a"/"GIF89a")
 *   HEIC 00 00 00 ?? 66 74 79 70 (heic|heix|...) ("....ftypheic")
 *
 * Returns `null` when no signature matches — callers should reject the
 * file rather than guess. The buffer can be shorter than 16 bytes; the
 * sniffer returns `null` rather than read out of range.
 */

import * as fs from 'node:fs';

export type SniffedMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | 'image/heic';

/** Returns the MIME type of `bytes` or null when no magic matches. */
export function sniffImageMime(bytes: Uint8Array): SniffedMime | null {
  if (!(bytes instanceof Uint8Array)) return null;
  if (bytes.length < 4) return null;
  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 &&
      bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a &&
      bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  // JPEG — FF D8 FF (any third FF subtype: E0 / E1 / DB / etc.)
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF — "GIF87a" or "GIF89a"
  if (bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 &&
      bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) &&
      bytes[5] === 0x61) {
    return 'image/gif';
  }
  // WEBP — "RIFF" + 4 bytes size + "WEBP"
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 &&
      bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 &&
      bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  // HEIC — "ftyp" at bytes 4..7, HEIF-family brand at bytes 8..11.
  // Brands include `heic`, `heix`, `mif1`, `msf1`, `heif`, `hevc`,
  // `hevx` — any of these means HEIF container. We match `ftyp` then
  // accept the brands typically found on iPhone exports.
  if (bytes.length >= 12 &&
      bytes[4] === 0x66 && bytes[5] === 0x74 &&
      bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(
      bytes[8] ?? 0,
      bytes[9] ?? 0,
      bytes[10] ?? 0,
      bytes[11] ?? 0,
    );
    if (
      brand === 'heic' || brand === 'heix' ||
      brand === 'heif' || brand === 'mif1' ||
      brand === 'msf1' || brand === 'hevc' ||
      brand === 'hevx'
    ) {
      return 'image/heic';
    }
  }
  return null;
}

/**
 * Read the first 16 bytes of a file and sniff. Returns `null` on any
 * read failure (file missing, permission denied, empty file) so the
 * caller can distinguish "no signature" from "couldn't read". The
 * implementation uses synchronous `fs.openSync`/`readSync` because we
 * already paid the stat cost upstream and 16 bytes is below every
 * filesystem's block size.
 */
export function sniffImageMimeFromFile(absPath: string): SniffedMime | null {
  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(16);
      const read = fs.readSync(fd, buf, 0, 16, 0);
      if (read <= 0) return null;
      return sniffImageMime(buf.subarray(0, read));
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }
}
