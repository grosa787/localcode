/**
 * Path-detection unit tests for the composer's bare-image-path
 * auto-attach pipeline.
 *
 * Pure unit tests — no filesystem touch, no React. The detector accepts
 * a line + cwd and returns `DetectedImagePath[]`; we exercise every
 * supported path shape, the auto-promote rule (line is JUST paths), and
 * the bail conditions (multi-line, embedded prose, too many paths,
 * non-image extension).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  detectImagePathsInLine,
  looksLikeBareImagePath,
  __setHomeDirForTests,
  MAX_PATHS_PER_LINE,
  SUPPORTED_IMAGE_EXTENSIONS,
} from '@/ui/composer/path-detection';

const HOME = '/Users/test';
const CWD = '/Users/test/project';

beforeEach(() => {
  __setHomeDirForTests(HOME);
});

afterEach(() => {
  __setHomeDirForTests(null);
});

describe('looksLikeBareImagePath — fast pre-check', () => {
  test('returns true for a clean absolute PNG path', () => {
    expect(looksLikeBareImagePath('/Users/me/pic.png')).toBe(true);
  });
  test('returns true for a clean relative path', () => {
    expect(looksLikeBareImagePath('./pic.jpg')).toBe(true);
  });
  test('returns true for a Windows drive path', () => {
    expect(looksLikeBareImagePath('C:\\photos\\pic.png')).toBe(true);
  });
  test('returns true for a quoted path', () => {
    expect(looksLikeBareImagePath("'/Users/me/My Pic.png'")).toBe(true);
  });
  test('returns false for plain prose', () => {
    expect(looksLikeBareImagePath('hello world')).toBe(false);
  });
  test('returns false for empty string', () => {
    expect(looksLikeBareImagePath('')).toBe(false);
  });
  test('returns false for non-path-shape input', () => {
    expect(looksLikeBareImagePath('?foo.png')).toBe(false);
  });
  test('returns false for a very short string', () => {
    expect(looksLikeBareImagePath('a')).toBe(false);
  });
});

describe('detectImagePathsInLine — absolute POSIX paths', () => {
  test('detects absolute PNG', () => {
    const r = detectImagePathsInLine('/Users/me/pic.png', CWD);
    expect(r).toHaveLength(1);
    expect(r[0]?.absolutePath).toBe('/Users/me/pic.png');
    expect(r[0]?.mimeType).toBe('image/png');
  });
  test('detects absolute JPEG', () => {
    const r = detectImagePathsInLine('/var/foo.jpeg', CWD);
    expect(r[0]?.mimeType).toBe('image/jpeg');
  });
  test('detects absolute JPG (mapped to jpeg)', () => {
    const r = detectImagePathsInLine('/x/y.jpg', CWD);
    expect(r[0]?.mimeType).toBe('image/jpeg');
  });
  test('detects absolute WEBP', () => {
    const r = detectImagePathsInLine('/x/y.webp', CWD);
    expect(r[0]?.mimeType).toBe('image/webp');
  });
  test('detects absolute GIF', () => {
    const r = detectImagePathsInLine('/x/y.gif', CWD);
    expect(r[0]?.mimeType).toBe('image/gif');
  });
  test('detects absolute HEIC', () => {
    const r = detectImagePathsInLine('/x/y.heic', CWD);
    expect(r[0]?.mimeType).toBe('image/heic');
  });
  test('records start/end offsets correctly', () => {
    const r = detectImagePathsInLine('  /x/y.png  ', CWD);
    expect(r[0]?.start).toBe(2);
    expect(r[0]?.end).toBe(10);
  });
});

describe('detectImagePathsInLine — home-relative', () => {
  test('detects `~` alone (legal directory shorthand, but not an image)', () => {
    // `~` alone has no extension → null.
    expect(detectImagePathsInLine('~', CWD)).toHaveLength(0);
  });
  test('detects `~/pic.png` → resolves into HOME', () => {
    const r = detectImagePathsInLine('~/pic.png', CWD);
    expect(r).toHaveLength(1);
    expect(r[0]?.absolutePath).toBe('/Users/test/pic.png');
  });
  test('detects `~/Pictures/snap.jpeg`', () => {
    const r = detectImagePathsInLine('~/Pictures/snap.jpeg', CWD);
    expect(r[0]?.absolutePath).toBe('/Users/test/Pictures/snap.jpeg');
    expect(r[0]?.mimeType).toBe('image/jpeg');
  });
});

describe('detectImagePathsInLine — relative paths', () => {
  test('`./pic.png` resolves against cwd', () => {
    const r = detectImagePathsInLine('./pic.png', CWD);
    expect(r[0]?.absolutePath).toBe('/Users/test/project/pic.png');
  });
  test('`../sib/foo.gif` resolves against cwd', () => {
    const r = detectImagePathsInLine('../sib/foo.gif', CWD);
    expect(r[0]?.absolutePath).toBe('/Users/test/sib/foo.gif');
  });
});

describe('detectImagePathsInLine — quoted paths', () => {
  test('single quotes around path with spaces', () => {
    const r = detectImagePathsInLine("'/Users/me/My Pic.png'", CWD);
    expect(r).toHaveLength(1);
    expect(r[0]?.absolutePath).toBe('/Users/me/My Pic.png');
  });
  test('double quotes around path with spaces', () => {
    const r = detectImagePathsInLine('"/Users/me/My Pic.png"', CWD);
    expect(r[0]?.absolutePath).toBe('/Users/me/My Pic.png');
  });
  test('unmatched single quote → bail (returns [])', () => {
    const r = detectImagePathsInLine("'/Users/me/pic.png", CWD);
    expect(r).toHaveLength(0);
  });
  test('backslash-space escape in unquoted path', () => {
    const r = detectImagePathsInLine('/Users/me/My\\ Pic.png', CWD);
    expect(r[0]?.absolutePath).toBe('/Users/me/My Pic.png');
  });
});

describe('detectImagePathsInLine — URI-encoded', () => {
  test('%20 decodes to space in path', () => {
    const r = detectImagePathsInLine('/Users/me/My%20Pic.png', CWD);
    expect(r[0]?.absolutePath).toBe('/Users/me/My Pic.png');
  });
  test('malformed %XX falls back to raw', () => {
    // %ZZ is not a valid escape — decoder throws, we fall back.
    const r = detectImagePathsInLine('/x/y%ZZ.png', CWD);
    expect(r).toHaveLength(1);
    expect(r[0]?.absolutePath).toBe('/x/y%ZZ.png');
  });
});

describe('detectImagePathsInLine — Windows drive paths', () => {
  test('uppercase drive + backslashes', () => {
    const r = detectImagePathsInLine('C:\\photos\\pic.png', CWD);
    expect(r).toHaveLength(1);
    expect(r[0]?.mimeType).toBe('image/png');
  });
  test('lowercase drive + forward slashes', () => {
    const r = detectImagePathsInLine('d:/x/y.png', CWD);
    expect(r).toHaveLength(1);
  });
});

describe('detectImagePathsInLine — auto-promote rule', () => {
  test('"path" line → detected', () => {
    expect(detectImagePathsInLine('/x/y.png', CWD)).toHaveLength(1);
  });
  test('"whitespace + path" line → detected', () => {
    expect(detectImagePathsInLine('  /x/y.png  ', CWD)).toHaveLength(1);
  });
  test('"hello /x/y.png" → bail (embedded prose)', () => {
    // `hello` is not a path-shape token, so the whole line bails.
    expect(detectImagePathsInLine('hello /x/y.png', CWD)).toHaveLength(0);
  });
  test('"check /x/y.png please" → bail', () => {
    expect(detectImagePathsInLine('check /x/y.png please', CWD)).toHaveLength(0);
  });
  test('multi-line input → bail (paths are one-line tokens)', () => {
    // The detector itself doesn't see multi-line; the caller passes
    // one line at a time. Still, the splitter must not crash.
    const r = detectImagePathsInLine('/x/y.png\nother', CWD);
    // The `\n` lands as part of the token; not a valid extension.
    expect(r).toHaveLength(0);
  });
  test('two paths on one line → both detected', () => {
    const r = detectImagePathsInLine('/x/a.png /y/b.gif', CWD);
    expect(r).toHaveLength(2);
    expect(r[0]?.absolutePath).toBe('/x/a.png');
    expect(r[1]?.absolutePath).toBe('/y/b.gif');
  });
  test(`more than MAX_PATHS_PER_LINE (${MAX_PATHS_PER_LINE}) → bail`, () => {
    const many = Array.from(
      { length: MAX_PATHS_PER_LINE + 1 },
      (_, i) => `/x/p${i}.png`,
    ).join(' ');
    expect(detectImagePathsInLine(many, CWD)).toHaveLength(0);
  });
  test('exactly MAX_PATHS_PER_LINE → detected', () => {
    const many = Array.from(
      { length: MAX_PATHS_PER_LINE },
      (_, i) => `/x/p${i}.png`,
    ).join(' ');
    expect(detectImagePathsInLine(many, CWD)).toHaveLength(MAX_PATHS_PER_LINE);
  });
});

describe('detectImagePathsInLine — reject paths', () => {
  test('non-image extension → bail', () => {
    expect(detectImagePathsInLine('/Users/me/note.txt', CWD)).toHaveLength(0);
  });
  test('no extension at all → bail', () => {
    expect(detectImagePathsInLine('/Users/me/file', CWD)).toHaveLength(0);
  });
  test('relative without `./` prefix (bare filename) → bail', () => {
    // We deliberately don't auto-promote `pic.png` alone — too easy
    // for the user to type that mid-prose.
    expect(detectImagePathsInLine('pic.png', CWD)).toHaveLength(0);
  });
  test('empty string → []', () => {
    expect(detectImagePathsInLine('', CWD)).toHaveLength(0);
  });
  test('whitespace-only → []', () => {
    expect(detectImagePathsInLine('   ', CWD)).toHaveLength(0);
  });
  test('very long input → []', () => {
    expect(detectImagePathsInLine('/x/' + 'a'.repeat(5000) + '.png', CWD)).toHaveLength(0);
  });
  test('http://example.com/foo.png → bail (URL, not filesystem path)', () => {
    expect(detectImagePathsInLine('http://example.com/foo.png', CWD)).toHaveLength(0);
  });
});

describe('detectImagePathsInLine — extension case-insensitivity', () => {
  test('uppercase .PNG → detected', () => {
    expect(detectImagePathsInLine('/x/y.PNG', CWD)[0]?.mimeType).toBe('image/png');
  });
  test('mixed case .JpEg → detected', () => {
    expect(detectImagePathsInLine('/x/y.JpEg', CWD)[0]?.mimeType).toBe('image/jpeg');
  });
  test('HEIC uppercase → detected', () => {
    expect(detectImagePathsInLine('/x/IMG_1234.HEIC', CWD)[0]?.mimeType).toBe('image/heic');
  });
});

describe('SUPPORTED_IMAGE_EXTENSIONS — pinned list', () => {
  test('contains exactly the 6 supported types', () => {
    expect(new Set(SUPPORTED_IMAGE_EXTENSIONS)).toEqual(
      new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic']),
    );
  });
});
