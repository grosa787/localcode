/**
 * Unsloth Studio — local-inference classification, pricing, and doctor.
 *
 * These four surfaces are all SILENT: `tsc` is green whether or not
 * `unsloth` appears in them, so a regression here ships without any
 * build signal. That is exactly why they get an explicit test.
 *
 * The invariant under test: Unsloth is local for INFERENCE SHAPE
 * (llama.cpp / MLX → constrained-decoding knobs apply, no per-token
 * cost) but keyed for AUTH (localhost server that 401s without a bearer
 * token). Any code that derives one from the other is wrong.
 */

import { describe, test, expect } from 'bun:test';

import { isLocalInferenceBackend, LOCAL_BACKENDS } from '@/llm/inference-control';
import { getPricing } from '@/llm/pricing';
import { resolvePrice } from '@/llm/pricing/resolver';
import { supportsVision } from '@/llm/model-capabilities';
import { PROVIDER_DEFAULTS } from '@/config/defaults';
import { ConfigSchema, type Config } from '@/config/types';
import { checkApiKeys } from '@/cli/doctor-checks/api-keys';
import { checkBackend } from '@/cli/doctor-checks/backends';

/** A GGUF repo id of the shape Unsloth Studio actually serves. */
const UNSLOTH_MODEL = 'unsloth/qwen3-coder-GGUF';

function unslothConfig(apiKey?: string): Config {
  return ConfigSchema.parse({
    backend: {
      type: 'unsloth',
      baseUrl: 'http://127.0.0.1:8888/v1',
      ...(apiKey !== undefined ? { apiKey } : {}),
    },
    model: { current: UNSLOTH_MODEL, available: [] },
    onboarding: { completed: true },
  });
}

/** Minimal stub standing in for `globalThis.fetch` in the ping check. */
function stubFetch(status: number): typeof globalThis.fetch {
  const fn = (): Promise<Response> =>
    Promise.resolve(new Response(status === 200 ? '{"data":[]}' : '', { status }));
  return fn as unknown as typeof globalThis.fetch;
}

/**
 * Fetch stub that behaves like the real Unsloth server: 200 only when a
 * matching bearer token arrives, 401 otherwise. Records every call so a
 * test can assert what was actually sent.
 */
function authAwareFetch(expected: string): {
  fetchFn: typeof globalThis.fetch;
  calls: { url: string; auth: string | null }[];
} {
  const calls: { url: string; auth: string | null }[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? {});
    const auth = headers.get('authorization');
    calls.push({ url: String(url), auth });
    const ok = auth === `Bearer ${expected}`;
    return Promise.resolve(
      new Response(ok ? '{"data":[]}' : '', { status: ok ? 200 : 401 }),
    );
  };
  return { fetchFn: fn as unknown as typeof globalThis.fetch, calls };
}

describe('unsloth — inference-control classification', () => {
  test('counts as a local inference backend', () => {
    expect(isLocalInferenceBackend('unsloth')).toBe(true);
    expect(LOCAL_BACKENDS).toContain('unsloth');
  });

  test('does not disturb the existing classification', () => {
    expect(isLocalInferenceBackend('ollama')).toBe(true);
    expect(isLocalInferenceBackend('lmstudio')).toBe(true);
    expect(isLocalInferenceBackend('custom')).toBe(true);
    expect(isLocalInferenceBackend('openai')).toBe(false);
    expect(isLocalInferenceBackend('anthropic')).toBe(false);
    expect(isLocalInferenceBackend('openrouter')).toBe(false);
    expect(isLocalInferenceBackend('google')).toBe(false);
  });
});

describe('unsloth — pricing', () => {
  test('resolvePrice returns null (local, not "unknown-priced")', () => {
    expect(resolvePrice('unsloth', UNSLOTH_MODEL)).toBeNull();
  });

  test('resolvePrice never inherits a paid row via prefix matching', () => {
    // A user could plausibly load any of these locally. None may be
    // billed at the cloud rate just because the id contains the slug.
    for (const id of [
      'unsloth/gpt-4o-clone-GGUF',
      'unsloth/claude-3.5-sonnet-distill-GGUF',
      'qwen/qwen3-coder',
      'gpt-4o',
    ]) {
      expect(resolvePrice('unsloth', id)).toBeNull();
    }
    // Control: the same ids DO resolve to a paid row on a cloud backend.
    expect(resolvePrice('openrouter', 'qwen/qwen3-coder')).not.toBeNull();
  });

  test('getPricing returns all-zero — "free", not "unknown"', () => {
    const p = getPricing('unsloth', UNSLOTH_MODEL);
    expect(p).not.toBeNull();
    expect(p?.inputPer1M).toBe(0);
    expect(p?.outputPer1M).toBe(0);
    expect(p?.cachedInputPer1M).toBe(0);
  });

  test('getPricing is zero even for an id that matches a paid row', () => {
    expect(getPricing('unsloth', 'gpt-4o')?.inputPer1M).toBe(0);
    // Control: the same id on OpenAI is billed.
    expect(getPricing('openai', 'gpt-4o')?.inputPer1M).toBe(2.5);
  });
});

describe('unsloth — vision heuristic', () => {
  test('a plain GGUF id is not assumed vision-capable', () => {
    expect(supportsVision('unsloth', UNSLOTH_MODEL)).toBe(false);
  });

  test('the generic vision-hint substrings still apply', () => {
    expect(supportsVision('unsloth', 'unsloth/qwen2.5-vl-7b-GGUF')).toBe(true);
    expect(supportsVision('unsloth', 'unsloth/llava-1.6-GGUF')).toBe(true);
    expect(supportsVision('unsloth', 'unsloth/pixtral-12b-GGUF')).toBe(true);
  });

  test('force overrides the heuristic', () => {
    expect(supportsVision('unsloth', UNSLOTH_MODEL, true)).toBe(true);
  });
});

describe('doctor — API key check', () => {
  test('unsloth requires a key despite being local', async () => {
    expect(PROVIDER_DEFAULTS.unsloth.requiresApiKey).toBe(true);
    const r = await checkApiKeys(unslothConfig(), { env: {} });
    expect(r.status).toBe('fail');
    expect(r.message).toContain('UNSLOTH_API_KEY');
    // The old CLOUD_BACKENDS membership test produced this — it is a lie
    // for unsloth and must never come back.
    expect(r.message).not.toContain('Not required');
  });

  test('key from config passes', async () => {
    const r = await checkApiKeys(unslothConfig('sk-unsloth-abc'), { env: {} });
    expect(r.status).toBe('ok');
    expect(r.message).toContain('config');
  });

  test('key from the canonical env var passes', async () => {
    const r = await checkApiKeys(unslothConfig(), {
      env: { UNSLOTH_API_KEY: 'sk-unsloth-abc' },
    });
    expect(r.status).toBe('ok');
    expect(r.message).toContain('UNSLOTH_API_KEY');
  });

  test('key from the alias env var passes', async () => {
    const r = await checkApiKeys(unslothConfig(), {
      env: { UNSLOTH_STUDIO_AUTH_TOKEN: 'sk-unsloth-abc' },
    });
    expect(r.status).toBe('ok');
  });

  test('genuinely keyless local backends still report "not required"', async () => {
    const cfg = ConfigSchema.parse({
      backend: { type: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' },
      model: { current: 'local-model', available: [] },
      onboarding: { completed: true },
    });
    const r = await checkApiKeys(cfg, { env: {} });
    expect(r.status).toBe('ok');
    expect(r.message).toContain('Not required');
  });
});

describe('doctor — backend reachability', () => {
  test('the probe SENDS the resolved key — a good key must report ok', async () => {
    // The whole point: an unauthenticated probe 401s against every
    // correctly configured Unsloth install and tells the user to fix a
    // key that was already right.
    const { fetchFn, calls } = authAwareFetch('sk-unsloth-good');
    const r = await checkBackend(unslothConfig('sk-unsloth-good'), { fetchFn });
    expect(r.status).toBe('ok');
    expect(calls[0]?.auth).toBe('Bearer sk-unsloth-good');
    // And the reachable row is where the --disable-tools trap is named.
    expect(r.detail).toContain('--disable-tools');
  });

  test('the key may come from the (injected) env, exactly like the adapter', async () => {
    const { fetchFn, calls } = authAwareFetch('sk-unsloth-env');
    const r = await checkBackend(unslothConfig(), {
      fetchFn,
      env: { UNSLOTH_API_KEY: 'sk-unsloth-env' },
    });
    expect(r.status).toBe('ok');
    expect(calls[0]?.auth).toBe('Bearer sk-unsloth-env');
  });

  test('alias env vars resolve for the probe too', async () => {
    const { fetchFn } = authAwareFetch('sk-unsloth-alias');
    const r = await checkBackend(unslothConfig(), {
      fetchFn,
      env: { UNSLOTH_STUDIO_AUTH_TOKEN: 'sk-unsloth-alias' },
    });
    expect(r.status).toBe('ok');
  });

  test('a genuinely wrong key still fails, and blames the key not the server', async () => {
    const { fetchFn } = authAwareFetch('sk-unsloth-good');
    const r = await checkBackend(unslothConfig('sk-unsloth-WRONG'), { fetchFn });
    expect(r.status).toBe('fail');
    expect(r.message).not.toContain('unreachable');
    expect(r.detail).toContain('UNSLOTH_API_KEY');
  });

  test('403 takes the same branch', async () => {
    const r = await checkBackend(unslothConfig('sk-unsloth-any'), {
      fetchFn: stubFetch(403),
    });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('UNSLOTH_API_KEY');
  });

  test('a reachable server still surfaces the --disable-tools trap', async () => {
    const r = await checkBackend(unslothConfig('sk-unsloth-any'), {
      fetchFn: stubFetch(200),
    });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('--disable-tools');
  });

  test('other backends get no unsloth-specific detail', async () => {
    const cfg = ConfigSchema.parse({
      backend: { type: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' },
      model: { current: 'local-model', available: [] },
      onboarding: { completed: true },
    });
    const r = await checkBackend(cfg, { fetchFn: stubFetch(200) });
    expect(r.status).toBe('ok');
    expect(r.detail).toBeUndefined();
  });

  test('REGRESSION GUARD: a keyless `custom` behind auth stays a warn', async () => {
    // `custom` does not declare `requiresApiKey`, so a gateway that
    // gates GET /v1/models must not start failing doctor (exit 1) on
    // installs where every real chat request succeeds.
    const cfg = ConfigSchema.parse({
      backend: { type: 'custom', baseUrl: 'https://gateway.example.com/v1' },
      model: { current: 'some-model', available: [] },
      onboarding: { completed: true },
    });
    const r = await checkBackend(cfg, { fetchFn: stubFetch(401), env: {} });
    expect(r.status).toBe('warn');
  });

  test('no Authorization header is sent when there is no key at all', async () => {
    const calls: (string | null)[] = [];
    const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
      void url;
      calls.push(new Headers(init?.headers ?? {}).get('authorization'));
      return Promise.resolve(new Response('{"data":[]}', { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    const cfg = ConfigSchema.parse({
      backend: { type: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' },
      model: { current: 'local-model', available: [] },
      onboarding: { completed: true },
    });
    await checkBackend(cfg, { fetchFn, env: {} });
    expect(calls[0]).toBeNull();
  });
});
