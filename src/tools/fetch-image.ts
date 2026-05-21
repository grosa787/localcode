/**
 * `fetch_image` tool — downloads an image from an HTTP(S) URL or decodes a
 * `data:image/*;base64,…` URI and returns the raw bytes as base64 so the
 * caller (the LLM adapter) can splice it into a vision-capable multimodal
 * request.
 *
 * This tool is PREVIEW-ONLY: the work happens in `preview` and there is no
 * `commit` step. It still reports `requiresApproval: true` because it is a
 * network side-effect (outbound GET) — the permissions subsystem may later
 * grant auto-approval per-tool.
 *
 * Safety rails:
 *   - Zod rejects any URL that is not `http://`, `https://`, or
 *     `data:image/<subtype>;base64,`. `file://` and relative paths are refused.
 *   - Network fetch has a 10-second AbortController timeout.
 *   - Response must be 2xx with an image/* Content-Type from the whitelist.
 *   - Decoded payload is capped at 10 MB.
 *   - No stdout logging (tools must stay quiet — the result is the channel).
 */

import { z } from 'zod';

import type { FetchImageArgs, ToolContext, ToolResult } from './types';

/** 10 MB cap on fetched image size, post-decode. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Network timeout (ms) for remote fetches. Does not apply to data URIs. */
const FETCH_TIMEOUT_MS = 10_000;

/** MIME types we accept — vision models universally support these. */
const ALLOWED_MIME_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

/** Matches the prefix of a `data:image/*;base64,…` URI (case-insensitive). */
const DATA_URI_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,/i;

/**
 * Zod schema for `fetch_image` arguments.
 *
 * The URL is refined to reject any scheme other than http(s):// and
 * data:image/*. Defence-in-depth: the preview function re-checks the scheme
 * before doing anything with it.
 */
export const FetchImageArgsSchema = z.object({
  url: z
    .string()
    .min(1, 'url must be a non-empty string')
    .refine(
      (raw) => {
        if (raw.startsWith('http://') || raw.startsWith('https://')) return true;
        if (DATA_URI_PATTERN.test(raw)) return true;
        return false;
      },
      {
        message:
          'url must start with http://, https://, or data:image/<type>;base64,',
      },
    ),
  description: z.string().optional(),
});

/** Failure helper — tools never throw; they return a structured result. */
function fail(message: string): ToolResult {
  return {
    success: false,
    output: '',
    error: message,
    requiresApproval: true,
  };
}

/** Success helper — always serialises the payload envelope the same way. */
function succeed(mimeType: string, dataBase64: string, byteLength: number): ToolResult {
  return {
    success: true,
    output: JSON.stringify({
      kind: 'image',
      mimeType,
      dataBase64,
      byteLength,
    }),
    requiresApproval: true,
  };
}

/** Decode a `data:image/<type>;base64,…` URI without touching the network. */
function decodeDataUri(url: string): ToolResult {
  const match = DATA_URI_PATTERN.exec(url);
  if (match === null) {
    return fail('Invalid data URI: expected data:image/<type>;base64,<payload>');
  }
  const mimeType = match[1]?.toLowerCase() ?? '';
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return fail(
      `Unsupported image MIME type '${mimeType}'. Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
    );
  }
  const payload = url.slice(match[0].length);
  if (payload.length === 0) {
    return fail('Data URI has no base64 payload');
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(payload, 'base64');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Failed to decode base64 payload: ${msg}`);
  }
  if (bytes.byteLength === 0) {
    return fail('Decoded image is empty');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return fail('Image too large (>10MB)');
  }
  // Re-encode so the caller always receives a canonicalised base64 string
  // without whitespace/line breaks that some data-URI producers inject.
  return succeed(mimeType, bytes.toString('base64'), bytes.byteLength);
}

/**
 * Fetch an image over HTTP(S). Caller is responsible for whitelisting the
 * scheme — this function does NOT re-validate it.
 */
async function fetchRemoteImage(url: string): Promise<ToolResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return fail(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Network error fetching image: ${msg}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    return fail(`Fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  const rawContentType = response.headers.get('content-type') ?? '';
  // Strip any `; charset=...` or other parameters for the whitelist check.
  const mimeType = rawContentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return fail(
      `Unsupported Content-Type '${rawContentType || '(missing)'}'. Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
    );
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Failed to read response body: ${msg}`);
  }

  if (buffer.byteLength === 0) {
    return fail('Fetched image is empty');
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return fail('Image too large (>10MB)');
  }

  const base64 = Buffer.from(buffer).toString('base64');
  return succeed(mimeType, base64, buffer.byteLength);
}

/**
 * Preview (and complete) a `fetch_image` request. Despite the `preview`
 * name the entire work — including the network call — happens here;
 * there is no commit step because nothing on the file system changes.
 */
export async function fetchImage(
  args: FetchImageArgs,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = FetchImageArgsSchema.safeParse(args);
  if (!parsed.success) {
    return fail(
      `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const { url } = parsed.data;

  if (url.startsWith('data:')) {
    return decodeDataUri(url);
  }

  // Zod already rejected anything other than http(s):// or data:image/*,
  // but re-guard as defence-in-depth in case the schema is changed later.
  if (!(url.startsWith('http://') || url.startsWith('https://'))) {
    return fail('URL scheme not allowed; use http(s):// or data:image/*');
  }

  return fetchRemoteImage(url);
}
