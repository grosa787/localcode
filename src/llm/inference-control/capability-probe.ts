/**
 * Wave 16B — capability probe.
 *
 * Detects which constrained-decoding knobs a LOCAL OpenAI-compatible
 * server actually honours, by sending TINY non-streaming requests that
 * carry one knob each and observing 200 (accepted) vs 4xx (rejected).
 * llama.cpp / LM Studio echo a 400 when they don't recognise a field;
 * Ollama silently ignores unknown fields (so it 200s) — we treat a 200
 * as "supported" which is the conservative, correct outcome for the
 * adapter (worst case the field is a harmless no-op).
 *
 * Cloud backends are NEVER probed — they don't expose these knobs, and a
 * stray `grammar` field would 400 a real billed request. They report all
 * capabilities false without a network round-trip.
 *
 * Results are cached to `~/.localcode/capabilities.json`, keyed by
 * `backend|baseUrl|model`, with a 7-day TTL. The cache is best-effort:
 * any read/write error degrades to "probe again", never throws.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Backend } from '@/types/global';
import {
  type CapabilityReport,
  disabledReport,
  isLocalInferenceBackend,
} from './types';

/**
 * Minimal fetch signature the probe relies on. We deliberately do NOT
 * use `typeof fetch` so tests (and any caller) can inject a plain
 * `(url, init) => Promise<Response>` without supplying Bun's extra
 * `fetch.preconnect` member. The global `fetch` is assignable to this.
 */
export type FetchImpl = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProbeCapabilitiesParams {
  baseUrl: string;
  backend: Backend | undefined;
  model: string;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Override the on-disk cache path (tests). */
  cachePath?: string;
  /** Override the TTL (ms). Default 7 days. */
  ttlMs?: number;
  /** Skip the cache entirely (force a fresh probe). */
  noCache?: boolean;
  /** Per-probe timeout (ms). Default 4000. */
  timeoutMs?: number;
}

/** 7 days. */
export const DEFAULT_CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 4000;

function defaultCachePath(): string {
  return path.join(os.homedir(), '.localcode', 'capabilities.json');
}

function cacheKey(backend: string, baseUrl: string, model: string): string {
  return `${backend}|${baseUrl}|${model}`;
}

interface CacheFile {
  reports: Record<string, CapabilityReport>;
}

async function readCache(file: string): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'reports' in parsed &&
      typeof (parsed as { reports: unknown }).reports === 'object'
    ) {
      return parsed as CacheFile;
    }
  } catch {
    // Missing / corrupt cache → start fresh.
  }
  return { reports: {} };
}

async function writeCache(file: string, data: CacheFile): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch {
    // Cache write is best-effort — never surface to the caller.
  }
}

function isReportFresh(report: CapabilityReport, ttlMs: number): boolean {
  return Date.now() - report.probedAt < ttlMs;
}

/** Strip a trailing slash so we can append `/v1/...` cleanly. */
function stripTrailingSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

/** Build the chat-completions URL for a base that may or may not end in /v1. */
function chatUrl(baseUrl: string): string {
  const base = stripTrailingSlash(baseUrl);
  return base.endsWith('/v1')
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

/**
 * Fire one tiny probe request carrying `extra` and report whether the
 * server accepted it (HTTP 200). Network/abort errors → false (we cannot
 * confirm support, so we conservatively disable the knob).
 */
async function probeOne(
  fetchImpl: FetchImpl,
  url: string,
  model: string,
  extra: Record<string, unknown>,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        // Minimal, non-streaming, near-zero-cost completion.
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
        ...extra,
      }),
      signal: controller.signal,
    });
    // Drain the body so the socket can be reused; ignore content.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** A trivial GBNF grammar used only to test server acceptance. */
const PROBE_GRAMMAR = 'root ::= "ok"';

/**
 * Probe (or load from cache) the constrained-decoding capabilities of a
 * server. Cloud backends short-circuit to all-false without any I/O.
 */
export async function probeCapabilities(
  params: ProbeCapabilitiesParams,
): Promise<CapabilityReport> {
  const { baseUrl, backend, model } = params;
  const backendName = backend ?? 'custom';

  // Cloud / non-local backends never get probed.
  if (!isLocalInferenceBackend(backend)) {
    return disabledReport(backendName, model);
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const cachePath = params.cachePath ?? defaultCachePath();
  const ttlMs = params.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  const timeoutMs = params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const key = cacheKey(backendName, baseUrl, model);

  if (!params.noCache) {
    const cache = await readCache(cachePath);
    const cached = cache.reports[key];
    if (cached && isReportFresh(cached, ttlMs)) {
      return cached;
    }
  }

  const url = chatUrl(baseUrl);

  // Probe each knob independently — a server may honour one but not
  // another (e.g. LM Studio: json_schema + grammar yes, cache_prompt no).
  const [grammar, jsonSchema, logitBias, cachePrompt] = await Promise.all([
    probeOne(fetchImpl, url, model, { grammar: PROBE_GRAMMAR }, timeoutMs),
    probeOne(
      fetchImpl,
      url,
      model,
      {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'probe',
            schema: { type: 'object', properties: {} },
          },
        },
      },
      timeoutMs,
    ),
    probeOne(fetchImpl, url, model, { logit_bias: { 0: 0 } }, timeoutMs),
    probeOne(fetchImpl, url, model, { cache_prompt: true }, timeoutMs),
  ]);

  const report: CapabilityReport = {
    grammar,
    jsonSchema,
    logitBias,
    cachePrompt,
    probedAt: Date.now(),
    backend: backendName,
    model,
  };

  if (!params.noCache) {
    const cache = await readCache(cachePath);
    cache.reports[key] = report;
    await writeCache(cachePath, cache);
  }

  return report;
}
