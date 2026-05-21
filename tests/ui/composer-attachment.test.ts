/**
 * InputBar `@image <path>` attachment helpers.
 *
 * The end-to-end keystroke pipeline is exercised by the manual smoke
 * harness; here we lock down the pure helpers exposed via the
 * `__test__` namespace:
 *
 *   - `parseAtImageDirective` — recognises both `@image <path>` and
 *     `@img <path>`, unwraps quoted paths, rejects non-matches.
 *   - `readImageMetaForAttach` — happy path on an existing PNG, reject
 *     paths on missing/empty/non-image files.
 *   - `promoteAtImageDirectives` — transforms an editor state with a
 *     `@image <path>` line into one where the line has been replaced
 *     with an image paste-token marker. Failed resolves leave the line
 *     verbatim.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __test__ } from '@/ui/components/InputBar';

const { parseAtImageDirective, promoteAtImageDirectives, readImageMetaForAttach, splitMultiline } =
  __test__;

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let tmpDir = '';
let pngPath = '';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-attach-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  pngPath = path.join(tmpDir, 'snap.png');
  await writeFile(pngPath, PNG_BYTES);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('parseAtImageDirective', () => {
  test('matches @image <path>', () => {
    expect(parseAtImageDirective('@image /tmp/foo.png')).toBe('/tmp/foo.png');
  });

  test('matches @img <path> (short alias)', () => {
    expect(parseAtImageDirective('@img /tmp/foo.png')).toBe('/tmp/foo.png');
  });

  test('matches case-insensitively', () => {
    expect(parseAtImageDirective('@Image /tmp/foo.png')).toBe('/tmp/foo.png');
  });

  test('strips quoted path with spaces', () => {
    expect(parseAtImageDirective("@image '/Users/me/My Pic.png'")).toBe(
      '/Users/me/My Pic.png',
    );
  });

  test('non-directive returns null', () => {
    expect(parseAtImageDirective('please describe this')).toBeNull();
  });

  test('empty path returns null', () => {
    expect(parseAtImageDirective('@image   ')).toBeNull();
  });
});

describe('readImageMetaForAttach', () => {
  test('existing PNG → metadata', () => {
    const meta = readImageMetaForAttach(pngPath);
    expect(meta).not.toBeNull();
    if (meta === null) return;
    expect(meta.mimeType).toBe('image/png');
    expect(meta.fileName).toBe('snap.png');
    expect(meta.bytes).toBe(PNG_BYTES.length);
  });

  test('missing path → null', () => {
    expect(readImageMetaForAttach(path.join(tmpDir, 'ghost.png'))).toBeNull();
  });

  test('non-image extension → null', async () => {
    const txt = path.join(tmpDir, 'note.txt');
    await writeFile(txt, 'hi');
    expect(readImageMetaForAttach(txt)).toBeNull();
  });
});

describe('promoteAtImageDirectives', () => {
  test('`@image <png>` is replaced with an image paste token', () => {
    const before = splitMultiline(`@image ${pngPath}`);
    const after = promoteAtImageDirectives(before);
    expect(after).not.toBe(before);
    expect(after.pastes.size).toBe(1);
    const token = [...after.pastes.values()][0]!;
    expect(token.kind).toBe('image');
    expect(token.text.startsWith('data:image/png;base64,')).toBe(true);
    expect(token.label).toContain('snap.png');
  });

  test('failed resolve leaves the line verbatim', () => {
    const before = splitMultiline(`@image /nonexistent/path.png`);
    const after = promoteAtImageDirectives(before);
    expect(after).toBe(before);
    expect(after.pastes.size).toBe(0);
  });

  test('non-directive lines pass through unchanged', () => {
    const before = splitMultiline('just a regular message');
    const after = promoteAtImageDirectives(before);
    expect(after).toBe(before);
  });

  test('committed line containing @image is promoted', () => {
    const before = splitMultiline(`@image ${pngPath}\nDescribe what you see.`);
    const after = promoteAtImageDirectives(before);
    expect(after).not.toBe(before);
    expect(after.pastes.size).toBe(1);
    // The active line is unchanged ("Describe what you see."); the
    // committed first line now holds only the marker (no path text).
    expect(after.value).toBe('Describe what you see.');
    expect(after.committedLines.length).toBe(1);
    const firstCommitted = after.committedLines[0]!;
    expect(firstCommitted.includes('PASTE:')).toBe(true);
  });
});
