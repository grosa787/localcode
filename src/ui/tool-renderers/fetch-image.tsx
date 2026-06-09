/**
 * TOOL-RENDERERS-SECTION + INLINE-IMAGE-SECTION — `fetch_image` rich
 * renderer (Wave 16C: inline TUI image rendering).
 *
 * Closes the perception asymmetry: the agent can SEE images you send,
 * but a `fetch_image` result previously rendered as the raw JSON
 * envelope (`{"kind":"image",...}`) — the user saw nothing. This
 * renderer decodes that envelope and draws the image INLINE using the
 * terminal's native graphics protocol (iTerm2 OSC 1337 / Kitty graphics)
 * when supported, falling back to a clean `[image: <type> <N> bytes]`
 * line otherwise. Never emits escape bytes on an unsupported terminal.
 *
 * RENDER-ONCE CACHE: ink's `<Static>` writes a committed row to stdout
 * once and it rides scrollback unchanged — but a parent re-render still
 * re-invokes this renderer. We hash the (protocol, base64) pair with
 * FNV-1a (mirroring src/ui/highlighting/syntax-highlight.ts) and reuse
 * the already-built escape string, so the emitted block is byte-stable
 * across repaints and we never re-wrap a multi-megabyte base64 payload.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { z } from 'zod';
import { noxPalette, textMuted } from '../theme.js';
import {
  detectTerminalImageProtocol,
  inlineImageFallbackLabel,
  inlineImagesEnabled,
  renderInlineImage,
  type InlineImage,
  type TerminalEnvSnapshot,
} from '../terminal-image.js';
import type { RenderToolResult, ToolRendererResult } from './types.js';

/**
 * The `fetch_image` success envelope (see src/tools/fetch-image.ts
 * `succeed`). Validated with zod — the output is external (model-driven
 * tool result) data crossing into the UI.
 */
const ImageEnvelopeSchema = z.object({
  kind: z.literal('image'),
  mimeType: z.string().min(1),
  dataBase64: z.string().min(1),
  byteLength: z.number().optional(),
});

type ImageEnvelope = z.infer<typeof ImageEnvelopeSchema>;

function parseEnvelope(output: string | undefined): ImageEnvelope | undefined {
  if (output === undefined || output.length === 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return undefined;
  }
  const parsed = ImageEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * FNV-1a 32-bit hash (identical algorithm to
 * src/ui/highlighting/syntax-highlight.ts `fnv1a32`). Single pass over
 * UTF-16 code units, `Math.imul` keeps the multiply 32-bit safe. NOT
 * cryptographic — collisions are tolerated because the cache value is
 * an opaque escape string derived deterministically from the same input.
 */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Module-local render-once cache. Keyed on
 * `<protocol>:<fnv1a(base64)>:<length>` so two different payloads that
 * collide on the hash still differ on length. Bounded LRU (drop-oldest
 * via Map insertion order) — same shape as the highlight cache. Caps the
 * worst case at a few hundred large base64 strings; a long session of
 * screenshots stays well inside.
 */
const ESCAPE_CACHE = new Map<string, string>();
const MAX_CACHE = 200;

function cacheKey(protocol: string, base64: string): string {
  return `${protocol}:${fnv1a32(base64)}:${base64.length}`;
}

function cacheInsert(key: string, value: string): void {
  ESCAPE_CACHE.set(key, value);
  if (ESCAPE_CACHE.size > MAX_CACHE) {
    const oldest = ESCAPE_CACHE.keys().next().value;
    if (oldest !== undefined) ESCAPE_CACHE.delete(oldest);
  }
}

/**
 * Build (or reuse from cache) the inline escape sequence for an image
 * under the given protocol. Returns the escape string when the protocol
 * can display the image, or `undefined` to signal the text fallback.
 */
function escapeForImage(
  image: InlineImage,
  env: TerminalEnvSnapshot,
): string | undefined {
  const protocol = detectTerminalImageProtocol(env);
  const key = cacheKey(protocol, image.base64);
  const cached = ESCAPE_CACHE.get(key);
  if (cached !== undefined) return cached;
  const result = renderInlineImage(image, protocol);
  if (result.kind === 'escape') {
    cacheInsert(key, result.payload);
    return result.payload;
  }
  return undefined;
}

/**
 * Resolve the env snapshot the renderer detects against. Reads
 * `process.env` (the live terminal). Kept private so the component stays
 * a pure function of its inputs for the common path and tests inject via
 * the exported `__renderFetchImage`.
 */
function liveEnv(): TerminalEnvSnapshot & { readonly LOCALCODE_NO_INLINE_IMAGES?: string } {
  const e = process.env;
  return {
    TERM_PROGRAM: e['TERM_PROGRAM'],
    TERM: e['TERM'],
    COLORTERM: e['COLORTERM'],
    LC_TERMINAL: e['LC_TERMINAL'],
    KITTY_WINDOW_ID: e['KITTY_WINDOW_ID'],
    WT_SESSION: e['WT_SESSION'],
    LOCALCODE_IMAGE_PROTOCOL: e['LOCALCODE_IMAGE_PROTOCOL'],
    LOCALCODE_NO_INLINE_IMAGES: e['LOCALCODE_NO_INLINE_IMAGES'],
  };
}

interface FetchImageViewProps {
  readonly envelope: ImageEnvelope;
  readonly env: TerminalEnvSnapshot & { readonly LOCALCODE_NO_INLINE_IMAGES?: string };
}

function FetchImageView({ envelope, env }: FetchImageViewProps): React.JSX.Element {
  const image: InlineImage = {
    base64: envelope.dataBase64,
    mimeType: envelope.mimeType,
    byteLength: envelope.byteLength,
  };

  // Opt-out (LOCALCODE_NO_INLINE_IMAGES) → always text fallback.
  const escape = inlineImagesEnabled(env) ? escapeForImage(image, env) : undefined;

  if (escape !== undefined) {
    // Raw escape sequence written verbatim into a <Text>. ink passes the
    // children through to stdout unchanged; the terminal interprets the
    // graphics protocol. The label sits above so the row still reads as
    // an image even before the terminal paints the pixels.
    return (
      <Box flexDirection="column" paddingLeft={3} marginTop={0}>
        <Text color={noxPalette.highlight}>{`🖼  ${envelope.mimeType}`}</Text>
        <Text>{escape}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={3} marginTop={0}>
      <Text color={textMuted}>{inlineImageFallbackLabel(image)}</Text>
    </Box>
  );
}

export const render: RenderToolResult = (_args, result) => {
  if (result.status !== 'done') return null;
  const envelope = parseEnvelope(result.output);
  if (envelope === undefined) return null;
  return <FetchImageView envelope={envelope} env={liveEnv()} />;
};

/**
 * Test-only entry point: render with an injected env snapshot so we can
 * exercise every protocol branch without mutating `process.env`. Returns
 * `null` for the same reasons `render` does (non-done / unparseable).
 */
export function __renderFetchImage(
  result: ToolRendererResult,
  env: TerminalEnvSnapshot & { readonly LOCALCODE_NO_INLINE_IMAGES?: string },
): React.ReactElement | null {
  if (result.status !== 'done') return null;
  const envelope = parseEnvelope(result.output);
  if (envelope === undefined) return null;
  return <FetchImageView envelope={envelope} env={env} />;
}

/** Test-only: clear the render-once cache between cases. */
export function __TEST_CLEAR_IMAGE_CACHE(): void {
  ESCAPE_CACHE.clear();
}

/** Test-only: current cache size. */
export function __TEST_IMAGE_CACHE_SIZE(): number {
  return ESCAPE_CACHE.size;
}
