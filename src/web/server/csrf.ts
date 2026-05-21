/**
 * CSRF helpers for the `--web` server.
 *
 * The token is a 32-byte random value, hex-encoded (64 chars), generated
 * once per server boot. It is delivered to the browser via the URL fragment
 * (so it never appears in server logs or referer headers) and then echoed
 * back on every state-changing REST call via the `X-LocalCode-CSRF`
 * header. The WS handshake performs an equivalent check via its first
 * `hello` frame; that lives in Agent C's WS module.
 *
 * Origin validation is a defence-in-depth measure: browsers always send an
 * `Origin` header for cross-origin (and same-origin POST/fetch) requests,
 * so a missing Origin generally indicates a non-browser client (curl, the
 * CLI itself, integration tests). Those are allowed through; browsers are
 * pinned to `127.0.0.1` / `localhost` on the bound port.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Length in bytes of the random CSRF secret (hex output is 2x). */
const CSRF_TOKEN_BYTES = 32;

/** Header browsers must echo on every state-changing REST request. */
export const CSRF_HEADER = 'X-LocalCode-CSRF';

/**
 * Generate a fresh CSRF token. Called once per `startWebServer` invocation;
 * the token is then closed over by the request dispatcher and the WS hello
 * verifier.
 */
export function generateCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString('hex');
}

/**
 * Constant-time header check (audit M5).
 *
 * Threat model: today the server only binds to `127.0.0.1` and the Origin
 * gate already blocks cross-site abuse, so a timing oracle on this check
 * is not directly exploitable from a browser. Defence-in-depth: a local
 * attacker with a low-privilege foothold could otherwise infer the token
 * via repeated probes. `timingSafeEqual` removes that vector for free.
 */
export function validateCsrfHeader(req: Request, expected: string): boolean {
  const supplied = req.headers.get(CSRF_HEADER);
  if (supplied === null) return false;
  // Different byte length: short-circuit (timingSafeEqual would throw).
  // Branching on length doesn't leak useful timing — the secret length
  // is a fixed public constant.
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (suppliedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(suppliedBuf, expectedBuf);
}

/**
 * Validate the request's `Origin` header. Returns true when:
 *   - no Origin header was sent (non-browser client), OR
 *   - the Origin matches the local server bound port on either
 *     `127.0.0.1` or `localhost`.
 *
 * Audit L2 — threat model for the allow-no-origin branch:
 *   Browsers always set `Origin` on cross-origin and state-changing
 *   requests, so a missing header reliably indicates a non-browser
 *   caller (curl, the LocalCode CLI itself, integration tests).
 *   Allowing these through is intentional and matches the CSRF gate
 *   that already pins POST/PUT/DELETE to the per-boot token. A future
 *   `--strict-origin` flag could refuse the no-Origin case for
 *   high-trust deployments — out of scope for v1.
 */
export function validateOrigin(req: Request, port: number): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true; // non-browser clients don't send Origin
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  );
}
