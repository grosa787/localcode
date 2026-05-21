/**
 * Tiny HTTP helpers shared by the REST handlers.
 *
 * - `jsonOk` / `jsonError` — uniform response envelopes.
 * - `parseJsonBody` — Zod-validate a JSON request body and return a
 *   discriminated result. Errors short-circuit with a 400 envelope.
 * - `SECURITY_HEADERS` — defence-in-depth response headers applied to
 *   every JSON envelope. Defeats MIME sniffing, blocks framing, and
 *   strips referrer leaks for static assets that link off-host.
 */

import type { z } from 'zod';

import type { ApiErrorBody } from '../protocol/rest-types.js';

/**
 * Hardening headers applied to every JSON response (audit bonus).
 *
 * - `X-Content-Type-Options: nosniff` — block IE/older-browser MIME
 *   sniffing, which could otherwise treat a JSON body as HTML.
 * - `X-Frame-Options: DENY` — refuse to be framed; we never embed.
 * - `Referrer-Policy: no-referrer` — never leak the loopback URL (with
 *   its `#token=…` hash) when the SPA links to docs / GitHub etc.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function jsonHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
  };
}

export function jsonOk(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders(),
  });
}

export function jsonError(error: string, message: string, status: number): Response {
  const body: ApiErrorBody = { error, details: message };
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders(),
  });
}

export type ParsedBody<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

export async function parseJsonBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<ParsedBody<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: jsonError('invalid_json', 'Request body is not valid JSON', 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, response: jsonError('invalid_body', summary, 400) };
  }
  return { ok: true, value: parsed.data };
}
