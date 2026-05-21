/**
 * `web_fetch` tool — download a URL and return a model-readable snapshot.
 *
 * Modes:
 *   - HTML → run through `htmlToMarkdown` so the model sees plain prose.
 *   - text/* or application/json → return the raw body verbatim.
 *   - Anything else → return a structured `{ kind: 'binary', sizeBytes, mimeType }`
 *     envelope so the model knows there is content but doesn't get a 500KB
 *     PDF dumped into its context.
 *
 * Security rails (defence-in-depth):
 *   - Zod accepts only `http://` and `https://`. `file://`, `data:`,
 *     `ftp://`, etc. are rejected by the schema.
 *   - The resolved host is rejected when it points at loopback, link-local,
 *     RFC 1918 private space, the metadata service (169.254.169.254), or
 *     `0.0.0.0`. This is the SSRF guard — set `allowLoopback: true` to
 *     bypass it (tests only).
 *   - 15 second AbortController timeout.
 *   - `maxBytes` defaults to 500 KB and is hard-capped at 2 MB. The body
 *     is streamed and aborted as soon as the cap is exceeded; we never
 *     buffer arbitrary-sized payloads into memory.
 *
 * This tool is auto-approved — it's a read-only GET with no filesystem
 * side effects.
 */

import { z } from 'zod';

import { htmlToMarkdown } from './url-to-markdown';
import type { ToolContext, ToolResult } from './types';

/** Default per-request byte cap. */
const DEFAULT_MAX_BYTES = 500_000;
/** Absolute maximum. Requests asking for more are silently clamped. */
const HARD_MAX_BYTES = 2_000_000;
/** Network timeout (ms). */
const FETCH_TIMEOUT_MS = 15_000;

/** Zod schema for `web_fetch` arguments. */
export const WebFetchArgsSchema = z.object({
  url: z
    .string()
    .min(1, 'url must be a non-empty string')
    .refine((raw) => raw.startsWith('http://') || raw.startsWith('https://'), {
      message: 'url must start with http:// or https://',
    }),
  maxBytes: z.number().int().positive().optional(),
});

export type WebFetchArgs = z.infer<typeof WebFetchArgsSchema>;

/** Internal options bag used by tests to relax the SSRF guard. */
export interface WebFetchOptions {
  /**
   * When true, loopback / link-local / RFC-1918 hosts are accepted. Tests
   * set this so they can hit a localhost mock-server. Production code
   * never sets it (default `false`).
   */
  allowLoopback?: boolean;
}

/** Output envelope for binary (non-text, non-html, non-json) responses. */
export interface BinaryEnvelope {
  kind: 'binary';
  sizeBytes: number;
  mimeType: string;
}

/** Output envelope for the success path. Serialised into `result.output`. */
export interface WebFetchEnvelope {
  url: string;
  status: number;
  contentType: string;
  /** Either the converted text (markdown / raw text / json) or a binary stub. */
  content: string | BinaryEnvelope;
  sizeBytes: number;
  truncated: boolean;
}

/** Failure helper — tools never throw; they return a structured result. */
function fail(message: string): ToolResult {
  return {
    success: false,
    output: '',
    error: message,
  };
}

/** Success helper — envelope is JSON-stringified into `output`. */
function succeed(env: WebFetchEnvelope): ToolResult {
  return {
    success: true,
    output: JSON.stringify(env),
  };
}

/**
 * Reject hosts that point at loopback / private / link-local IP space so
 * a model can't talk the tool into making cloud-metadata or internal
 * service requests via the project root.
 */
function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase();

  // Localhost names.
  if (lower === 'localhost' || lower === 'localhost.localdomain') return true;
  if (lower.endsWith('.localhost')) return true;
  if (lower.endsWith('.local')) return true;
  if (lower.endsWith('.internal')) return true;

  // IPv6 loopback / link-local.
  if (lower === '::1' || lower === '[::1]') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('[fe80:')) return true;
  if (lower.startsWith('fc00:') || lower.startsWith('fd')) return true;

  // IPv4 dotted-quad parsing — be strict so we don't false-positive on
  // domain names like `127.example.com` (which is a perfectly valid host).
  const ipMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (!ipMatch) return false;
  const a = Number(ipMatch[1] ?? '0');
  const b = Number(ipMatch[2] ?? '0');
  const c = Number(ipMatch[3] ?? '0');
  const d = Number(ipMatch[4] ?? '0');
  if ([a, b, c, d].some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;

  // 0.0.0.0/8 — "this network".
  if (a === 0) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 10.0.0.0/8 — RFC 1918.
  if (a === 10) return true;
  // 172.16.0.0/12.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16.
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local incl. cloud metadata 169.254.169.254.
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 — CGNAT.
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

/**
 * Parse the URL and return its host or null if parsing fails. We use the
 * platform `URL` constructor for this rather than a custom regex.
 */
function safeHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/** Drop any `; charset=...` etc. and lowercase. */
function normaliseContentType(raw: string): string {
  return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Read a Response's body with an explicit byte cap. Returns the body bytes
 * (up to the cap) plus a `truncated` flag. Never reads past `cap`.
 */
async function readBodyCapped(
  response: Response,
  cap: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  // Some runtimes (and the mocked Response in tests) don't expose a
  // proper streaming reader. Fall back to .arrayBuffer() then slice if so.
  const body = response.body;
  if (body === null) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength <= cap) return { bytes: buf, truncated: false };
    return { bytes: buf.slice(0, cap), truncated: true };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < cap) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = cap - total;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    // Probe one more chunk to detect "exactly-cap" vs "exceeded" — only
    // when we filled the cap on the previous iteration.
    if (total >= cap && !truncated) {
      const { value, done } = await reader.read();
      if (!done && value && value.byteLength > 0) truncated = true;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore — best-effort cleanup.
    }
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: result, truncated };
}

/**
 * Fetch a URL and return a structured envelope. See module doc for the
 * full security contract.
 */
export async function webFetch(
  args: WebFetchArgs,
  _ctx: ToolContext,
  options?: WebFetchOptions,
): Promise<ToolResult> {
  const parsed = WebFetchArgsSchema.safeParse(args);
  if (!parsed.success) {
    return fail(
      `Invalid args: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const allowLoopback = options?.allowLoopback === true;
  const cap = Math.min(parsed.data.maxBytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
  const host = safeHost(parsed.data.url);
  if (host === null) {
    return fail(`Could not parse url: ${parsed.data.url}`);
  }
  if (!allowLoopback && isPrivateHost(host)) {
    return fail(
      `Blocked by SSRF policy: host '${host}' is loopback/private/link-local`,
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(parsed.data.url, {
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return fail(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Network error fetching url: ${msg}`);
  } finally {
    clearTimeout(timeoutId);
  }

  // Re-check the post-redirect host for SSRF.
  const finalHost = safeHost(response.url || parsed.data.url);
  if (finalHost !== null && !allowLoopback && isPrivateHost(finalHost)) {
    return fail(
      `Blocked by SSRF policy after redirect: host '${finalHost}' is loopback/private/link-local`,
    );
  }

  if (!response.ok) {
    return fail(`Fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = normaliseContentType(response.headers.get('content-type') ?? '');

  let bytes: Uint8Array;
  let truncated: boolean;
  try {
    const result = await readBodyCapped(response, cap);
    bytes = result.bytes;
    truncated = result.truncated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Failed to read response body: ${msg}`);
  }

  const sizeBytes = bytes.byteLength;

  const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml';
  const isText = contentType.startsWith('text/') || contentType === 'application/json' || contentType.endsWith('+json') || contentType.endsWith('+xml') || contentType === 'application/xml';

  if (isHtml || isText) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const content = isHtml ? htmlToMarkdown(text) : text;
    return succeed({
      url: response.url || parsed.data.url,
      status: response.status,
      contentType: contentType || '(unknown)',
      content,
      sizeBytes,
      truncated,
    });
  }

  // Binary path — return a stub. The model knows the file exists without
  // having to ingest possibly-megabytes of opaque bytes.
  return succeed({
    url: response.url || parsed.data.url,
    status: response.status,
    contentType: contentType || 'application/octet-stream',
    content: {
      kind: 'binary',
      sizeBytes,
      mimeType: contentType || 'application/octet-stream',
    },
    sizeBytes,
    truncated,
  });
}
