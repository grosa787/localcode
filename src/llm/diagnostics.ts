/**
 * OpenRouter failure diagnostics.
 *
 * When a request to OpenRouter (or any backend) fails with a non-2xx
 * response, write a sanitized JSON dump to disk so the user can share
 * it for debugging without leaking their API key.
 *
 * Triggered from `LLMAdapter` when:
 *   - `config.diagnostics.dumpFailedRequests === true` (off by default), AND
 *   - the response is non-OK on the OpenRouter backend.
 *
 * Files land in `~/.localcode/diagnostics/<timestamp>-<backend>-<status>.json`.
 *
 * SAFETY INVARIANT — `Authorization` header values are replaced with
 * `Bearer ***`, and any nested `apiKey` / `api_key` / `authorization`
 * field anywhere in the request body is recursively redacted before
 * the file is written. The dump format is documented in
 * `docs/DEBUGGING_OPENROUTER.md`.
 */

import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-request timing breakdown (milliseconds, measured via
 * `performance.now()`). Captured by `LLMAdapter.runStreamOnce` and
 * attached to failure dumps so users can tell whether a slow turn was
 * caused by:
 *
 *   - `connectMs` — DNS + TCP + TLS handshake + request upload + server
 *     time-to-first-byte of the response headers. Cold connections to
 *     OpenRouter typically run 200-400ms; warm (pooled) reconnects
 *     should be <50ms. A multi-second value here points at a slow
 *     network, a saturated provider, or — if it climbs back to cold
 *     levels every turn — a broken keep-alive (cf. R30 audit).
 *   - `firstByteMs` — gap between response headers arriving and the
 *     first SSE chunk surfacing visible bytes. This is essentially
 *     "model ramp-up": prefix-cache miss penalty on the upstream side
 *     plus any queue time. Anthropic / OpenAI cold paths can be 500ms+;
 *     warm prefix caches drop this under 100ms.
 *   - `totalMs` — wall-clock from request start to the final `done`
 *     event (including all retries within a single attempt loop).
 *
 * Field names use `Ms` suffixes so JSON dumps are self-documenting.
 * All values are integers (we floor on capture). When a phase is not
 * observable (e.g. the request never produced a first byte), the
 * corresponding field is omitted rather than zero-filled — `0` would
 * be ambiguous with "instant".
 */
export interface RequestTiming {
  /**
   * DNS resolution time. Bun's `fetch` does NOT expose the phase
   * boundary directly (no `Performance Timing` hooks for cross-origin
   * fetches), so this stays `undefined` in practice — kept in the
   * interface so future Bun releases that DO expose it can populate
   * without a breaking change. DNS for `openrouter.ai` is typically
   * sub-50ms after the first request thanks to the OS resolver cache.
   */
  dnsResolveMs?: number;
  /** TCP+TLS+upload+headers (request start → response headers received). */
  connectMs?: number;
  /** Headers received → first visible SSE chunk. */
  firstByteMs?: number;
  /** Request start → done event. */
  totalMs?: number;
}

export interface FailureDump {
  timestamp: string;
  backend: string;
  model: string;
  status: number;
  responseBody: string;
  responseHeaders: Record<string, string>;
  /** Sanitized request body — keys with secret-looking names are redacted. */
  requestBody: unknown;
  /** Sanitized request headers — `Authorization` value is replaced with `Bearer ***`. */
  requestHeaders: Record<string, string>;
  /**
   * Optional per-phase timing breakdown. Populated when timing
   * instrumentation captured at least one phase (always available on
   * the `runStreamOnce` path; older callers may omit this entirely).
   */
  timing?: RequestTiming;
}

const REDACTED = 'Bearer ***';
const REDACTED_FIELD = '***';

/** Header keys whose values must never be persisted verbatim. */
const SECRET_HEADER_KEYS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'openai-api-key',
  'anthropic-api-key',
]);

/** Body field names whose values must never be persisted verbatim. */
const SECRET_BODY_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'token',
  'access_token',
  'secret',
]);

/**
 * Return a copy of `headers` with secret-looking values replaced.
 * Case-insensitive on the key. Original casing is preserved on the way
 * out so the dump still shows what the client actually sent.
 */
export function sanitizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SECRET_HEADER_KEYS.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Recursively sanitize a request body. Leaves arrays and objects'
 * structure intact; replaces any string value whose key looks
 * secret-ish with `'***'`.
 */
export function sanitizeBody(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeBody(v));
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_BODY_KEYS.has(k.toLowerCase()) && typeof v === 'string') {
        out[k] = REDACTED_FIELD;
      } else {
        out[k] = sanitizeBody(v);
      }
    }
    return out;
  }
  return value;
}

/** Default diagnostics directory: `~/.localcode/diagnostics/`. */
export function defaultDiagnosticsDir(): string {
  return join(homedir(), '.localcode', 'diagnostics');
}

/**
 * Write a failure dump to disk and return the absolute file path.
 *
 * `dir` is overridable for tests; production callers pass nothing and
 * land in `~/.localcode/diagnostics/`. Sanitization happens here, NOT
 * at the call site — callers can safely pass raw headers/body and we
 * guarantee no `Authorization` value reaches the disk.
 */
export async function captureFailure(
  d: FailureDump,
  dir: string = defaultDiagnosticsDir(),
): Promise<string> {
  const sanitized: FailureDump = {
    timestamp: d.timestamp,
    backend: d.backend,
    model: d.model,
    status: d.status,
    responseBody: d.responseBody,
    responseHeaders: { ...d.responseHeaders },
    requestBody: sanitizeBody(d.requestBody),
    requestHeaders: sanitizeHeaders(d.requestHeaders),
    // Timing has no PII risk — forward shallow-cloned. Omitted when
    // the caller never populated it (older paths and ping/getModels).
    ...(d.timing ? { timing: { ...d.timing } } : {}),
  };

  await mkdir(dir, { recursive: true });
  // Filename uses ISO timestamp with `:` swapped for `-` so paths are
  // valid on every filesystem (Windows rejects `:` in file names).
  const safeTs = d.timestamp.replace(/:/g, '-');
  const filename = `${safeTs}-${d.backend}-${d.status}.json`;
  const path = join(dir, filename);
  await writeFile(path, JSON.stringify(sanitized, null, 2), 'utf8');
  // L6 — fire-and-forget rotation. We never `await` cleanup so a
  // slow `readdir` can't delay the actual capture, and we swallow
  // all errors so a flaky filesystem (e.g. read-only home dir) can't
  // tank the failure-capture path itself.
  rotateDiagnostics(dir).catch(() => {
    // ignore — rotation is best-effort
  });
  return path;
}

/**
 * L6 — keep the diagnostics directory bounded. Without this it grows
 * one file per failed request forever; long-running developer
 * sessions on a flaky OpenRouter day can produce thousands of dumps.
 *
 * Policy (whichever is more aggressive wins):
 *   - keep at most {@link DIAGNOSTICS_MAX_FILES} dump files,
 *   - delete files older than {@link DIAGNOSTICS_MAX_AGE_MS}.
 *
 * Runs asynchronously; errors are swallowed by the caller's
 * `.catch(() => {})` so cleanup failure never propagates. Operates
 * only on files matching the dump filename pattern — we never delete
 * a file we did not write (so an unrelated `.txt` someone dropped in
 * the dir stays put).
 */
const DIAGNOSTICS_MAX_FILES = 100;
const DIAGNOSTICS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DUMP_FILENAME_RE = /^\d{4}-\d{2}-\d{2}T.*-.+-\d+\.json$/;

export async function rotateDiagnostics(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Dir doesn't exist (first capture races a stat) — nothing to do.
    return;
  }
  const candidates = entries.filter((name) => DUMP_FILENAME_RE.test(name));
  if (candidates.length === 0) return;

  // Stat each candidate so we can sort by mtime AND know its age.
  // Failures on individual files are tolerated.
  const stats: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of candidates) {
    try {
      const st = await stat(join(dir, name));
      stats.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      // skip — file may have been deleted between readdir and stat
    }
  }
  // Newest first so slicing keeps recent dumps and drops the tail.
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const now = Date.now();
  const toDelete = new Set<string>();
  // Age-based eviction.
  for (const s of stats) {
    if (now - s.mtimeMs > DIAGNOSTICS_MAX_AGE_MS) {
      toDelete.add(s.name);
    }
  }
  // Count-based eviction — anything past the cap, oldest first.
  if (stats.length > DIAGNOSTICS_MAX_FILES) {
    for (const s of stats.slice(DIAGNOSTICS_MAX_FILES)) {
      toDelete.add(s.name);
    }
  }

  for (const name of toDelete) {
    try {
      await unlink(join(dir, name));
    } catch {
      // ignore — file may have been removed concurrently
    }
  }
}
