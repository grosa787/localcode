/**
 * Wave 16C — inline TUI image rendering.
 *
 * The renderer in src/ui/terminal-image.ts shipped UNPROVEN (zero call
 * sites before this wave). These tests exercise the render path
 * end-to-end with a tiny real PNG and assert that:
 *   - each detected protocol (iTerm2 / Kitty) emits its expected escape
 *     sequence framing,
 *   - the fallback text line fires for `none` / sixel / unsupported
 *     formats, and never leaks escape bytes,
 *   - the MIME-aware Kitty path degrades to text for non-PNG (the bug
 *     the original `f=100`-as-JPEG comment papered over),
 *   - the render-once cache returns a byte-stable escape across repaints,
 *   - the `LOCALCODE_NO_INLINE_IMAGES` opt-out forces the text fallback.
 */

import { describe, test, expect, beforeEach, beforeAll } from 'bun:test';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import {
  renderInlineImage,
  inlineImageFallbackLabel,
  inlineImagesEnabled,
  detectTerminalImageProtocol,
  type InlineImage,
} from '@/ui/terminal-image';
import {
  __renderFetchImage,
  __TEST_CLEAR_IMAGE_CACHE,
  __TEST_IMAGE_CACHE_SIZE,
} from '@/ui/tool-renderers/fetch-image';

// A 1x1 transparent PNG (smallest valid PNG). base64, no data: prefix.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function pngEnvelope(): string {
  return JSON.stringify({
    kind: 'image',
    mimeType: 'image/png',
    dataBase64: TINY_PNG_BASE64,
    byteLength: 68,
  });
}

function jpegEnvelope(): string {
  return JSON.stringify({
    kind: 'image',
    mimeType: 'image/jpeg',
    dataBase64: TINY_PNG_BASE64, // payload bytes irrelevant for framing assertions
    byteLength: 68,
  });
}

const PNG_IMAGE: InlineImage = {
  base64: TINY_PNG_BASE64,
  mimeType: 'image/png',
  byteLength: 68,
};

const JPEG_IMAGE: InlineImage = {
  base64: TINY_PNG_BASE64,
  mimeType: 'image/jpeg',
  byteLength: 68,
};

function renderToText(element: React.ReactElement | null): string {
  if (element === null) return '';
  const buf: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      buf.push(Buffer.from(chunk));
      cb();
    },
  });
  (stream as unknown as { columns: number }).columns = 120;
  (stream as unknown as { rows: number }).rows = 40;
  (stream as unknown as { isTTY: boolean }).isTTY = true;
  const instance = render(element, {
    // ink's stdout option is typed to NodeJS.WriteStream; the Writable
    // shim above carries the columns/rows/isTTY fields ink reads.
    stdout: stream as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
  });
  instance.unmount();
  return Buffer.concat(buf).toString('utf8');
}

beforeAll(() => {
  process.env['FORCE_COLOR'] = '3';
});

beforeEach(() => {
  __TEST_CLEAR_IMAGE_CACHE();
});

describe('renderInlineImage — protocol framing', () => {
  test('iTerm2 emits OSC 1337 inline-image framing for PNG', () => {
    const out = renderInlineImage(PNG_IMAGE, 'iterm2');
    expect(out.kind).toBe('escape');
    if (out.kind !== 'escape') throw new Error('expected escape');
    expect(out.payload.startsWith('\x1b]1337;File=')).toBe(true);
    expect(out.payload).toContain('inline=1');
    expect(out.payload).toContain(TINY_PNG_BASE64);
    expect(out.payload.endsWith('\x07')).toBe(true);
  });

  test('iTerm2 also handles JPEG (format-agnostic decode)', () => {
    const out = renderInlineImage(JPEG_IMAGE, 'iterm2');
    expect(out.kind).toBe('escape');
    if (out.kind !== 'escape') throw new Error('expected escape');
    expect(out.payload.startsWith('\x1b]1337;File=')).toBe(true);
  });

  test('Kitty emits graphics-protocol APC framing for PNG (f=100)', () => {
    const out = renderInlineImage(PNG_IMAGE, 'kitty');
    expect(out.kind).toBe('escape');
    if (out.kind !== 'escape') throw new Error('expected escape');
    expect(out.payload.startsWith('\x1b_G')).toBe(true);
    expect(out.payload).toContain('f=100');
    expect(out.payload).toContain('a=T');
    expect(out.payload).toContain('t=d');
    expect(out.payload).toContain(TINY_PNG_BASE64);
    expect(out.payload.endsWith('\x1b\\')).toBe(true);
  });

  test('Kitty FALLS BACK to text for JPEG (Kitty only decodes PNG)', () => {
    // This is the bug the original f=100-as-JPEG comment masked: Kitty
    // cannot natively render JPEG, so we must NOT hand it JPEG bytes.
    const out = renderInlineImage(JPEG_IMAGE, 'kitty');
    expect(out.kind).toBe('fallback');
  });

  test('Kitty chunks large PNG payloads with m=1 continuations', () => {
    const big = 'A'.repeat(9000); // > 2 * 4096 → at least 3 chunks
    const out = renderInlineImage(
      { base64: big, mimeType: 'image/png' },
      'kitty',
    );
    expect(out.kind).toBe('escape');
    if (out.kind !== 'escape') throw new Error('expected escape');
    expect(out.payload).toContain('m=1'); // a non-final chunk exists
    // Final chunk closes with m=0.
    expect(out.payload).toContain('m=0');
    // Exactly one frame opens the transmit with the control keys.
    const opens = out.payload.split('\x1b_Gf=100,a=T,t=d').length - 1;
    expect(opens).toBe(1);
  });

  test('sixel falls back (no encoder bundled)', () => {
    const out = renderInlineImage(PNG_IMAGE, 'sixel');
    expect(out.kind).toBe('fallback');
  });

  test('none falls back', () => {
    const out = renderInlineImage(PNG_IMAGE, 'none');
    expect(out.kind).toBe('fallback');
  });

  test('empty base64 falls back regardless of protocol', () => {
    const out = renderInlineImage(
      { base64: '', mimeType: 'image/png' },
      'iterm2',
    );
    expect(out.kind).toBe('fallback');
  });
});

describe('inlineImageFallbackLabel', () => {
  test('includes subtype and byte length', () => {
    expect(inlineImageFallbackLabel(PNG_IMAGE)).toBe('[image: png 68 bytes]');
  });
  test('omits byte length when absent', () => {
    expect(inlineImageFallbackLabel({ base64: 'x', mimeType: 'image/webp' })).toBe(
      '[image: webp]',
    );
  });
  test('never contains escape bytes', () => {
    const label = inlineImageFallbackLabel(PNG_IMAGE);
    // eslint-disable-next-line no-control-regex
    expect(/\x1b/.test(label)).toBe(false);
  });
});

describe('inlineImagesEnabled opt-out', () => {
  test('default ON', () => {
    expect(inlineImagesEnabled({})).toBe(true);
  });
  test('LOCALCODE_NO_INLINE_IMAGES=1 turns it OFF', () => {
    expect(inlineImagesEnabled({ LOCALCODE_NO_INLINE_IMAGES: '1' })).toBe(false);
  });
  test('empty LOCALCODE_NO_INLINE_IMAGES is ignored (stays ON)', () => {
    expect(inlineImagesEnabled({ LOCALCODE_NO_INLINE_IMAGES: '' })).toBe(true);
  });
});

describe('fetch_image renderer — end-to-end through ink', () => {
  test('iTerm2 env → escape sequence reaches stdout', () => {
    const el = __renderFetchImage(
      { status: 'done', output: pngEnvelope() },
      { TERM_PROGRAM: 'iTerm.app' },
    );
    const text = renderToText(el);
    expect(text).toContain('\x1b]1337;File=');
    expect(text).toContain('image/png');
  });

  test('Kitty env + PNG → APC escape reaches stdout', () => {
    const el = __renderFetchImage(
      { status: 'done', output: pngEnvelope() },
      { KITTY_WINDOW_ID: '1', TERM: 'xterm-kitty' },
    );
    const text = renderToText(el);
    expect(text).toContain('\x1b_Gf=100,a=T,t=d');
  });

  test('Kitty env + JPEG → text fallback, NO escape bytes', () => {
    const el = __renderFetchImage(
      { status: 'done', output: jpegEnvelope() },
      { KITTY_WINDOW_ID: '1', TERM: 'xterm-kitty' },
    );
    const text = renderToText(el);
    expect(text).toContain('[image: jpeg 68 bytes]');
    expect(text).not.toContain('\x1b_G');
    expect(text).not.toContain('\x1b]1337');
  });

  test('unsupported terminal (none) → text fallback', () => {
    const el = __renderFetchImage(
      { status: 'done', output: pngEnvelope() },
      { TERM: 'xterm-256color' },
    );
    const text = renderToText(el);
    expect(text).toContain('[image: png 68 bytes]');
    expect(text).not.toContain('\x1b]1337');
    expect(text).not.toContain('\x1b_G');
  });

  test('opt-out env forces text fallback even on a capable terminal', () => {
    const el = __renderFetchImage(
      { status: 'done', output: pngEnvelope() },
      { TERM_PROGRAM: 'iTerm.app', LOCALCODE_NO_INLINE_IMAGES: '1' },
    );
    const text = renderToText(el);
    expect(text).toContain('[image: png 68 bytes]');
    expect(text).not.toContain('\x1b]1337');
  });

  test('non-done status renders nothing', () => {
    expect(
      __renderFetchImage({ status: 'pending' }, { TERM_PROGRAM: 'iTerm.app' }),
    ).toBeNull();
  });

  test('unparseable / non-envelope output renders nothing', () => {
    expect(
      __renderFetchImage(
        { status: 'done', output: 'not json' },
        { TERM_PROGRAM: 'iTerm.app' },
      ),
    ).toBeNull();
    expect(
      __renderFetchImage(
        { status: 'done', output: JSON.stringify({ kind: 'other' }) },
        { TERM_PROGRAM: 'iTerm.app' },
      ),
    ).toBeNull();
  });
});

describe('render-once cache survives <Static> repaints', () => {
  test('repeated renders of the same image hit the cache (size stays 1)', () => {
    const env = { TERM_PROGRAM: 'iTerm.app' } as const;
    const out = pngEnvelope();
    const first = renderToText(
      __renderFetchImage({ status: 'done', output: out }, env),
    );
    expect(__TEST_IMAGE_CACHE_SIZE()).toBe(1);
    // Simulate a parent repaint: re-render the identical row.
    const second = renderToText(
      __renderFetchImage({ status: 'done', output: out }, env),
    );
    // Byte-stable escape across repaints (load-bearing for <Static>).
    expect(first).toBe(second);
    expect(__TEST_IMAGE_CACHE_SIZE()).toBe(1);
  });

  test('different images get separate cache entries', () => {
    const env = { TERM_PROGRAM: 'iTerm.app' } as const;
    renderToText(__renderFetchImage({ status: 'done', output: pngEnvelope() }, env));
    const other = JSON.stringify({
      kind: 'image',
      mimeType: 'image/png',
      dataBase64: TINY_PNG_BASE64 + 'AAAA',
      byteLength: 70,
    });
    renderToText(__renderFetchImage({ status: 'done', output: other }, env));
    expect(__TEST_IMAGE_CACHE_SIZE()).toBe(2);
  });

  test('fallback path does NOT populate the cache', () => {
    renderToText(
      __renderFetchImage(
        { status: 'done', output: pngEnvelope() },
        { TERM: 'xterm-256color' },
      ),
    );
    expect(__TEST_IMAGE_CACHE_SIZE()).toBe(0);
  });
});

describe('detector sanity (regression anchor for the wired path)', () => {
  test('iTerm.app → iterm2', () => {
    expect(detectTerminalImageProtocol({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2');
  });
  test('kitty → kitty', () => {
    expect(detectTerminalImageProtocol({ TERM: 'xterm-kitty' })).toBe('kitty');
  });
});
