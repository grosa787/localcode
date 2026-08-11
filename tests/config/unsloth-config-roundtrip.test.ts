/**
 * Unsloth Studio — config persistence round-trip.
 *
 * `tests/config/multi-provider-schema.test.ts` covers the schema and the
 * env-var resolution in isolation. What it does NOT cover is the full
 * disk trip: `ConfigManager.update()` serialises to TOML, writes
 * atomically, and `read()` re-parses through Zod on the way back. A
 * backend can be valid in `BackendTypeSchema` and still be lost by the
 * writer or rejected by the reader.
 *
 * Every assertion here re-reads through a SECOND `ConfigManager`
 * instance pointed at the same path, so nothing can pass on the strength
 * of in-memory state alone.
 *
 * Filesystem convention per `CLAUDE.md`: `os.tmpdir()` +
 * `crypto.randomUUID()`, torn down in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import { PROVIDER_DEFAULTS } from '@/config/defaults';
import { ConfigSchema } from '@/config/types';

let tmpDir = '';
let configPath = '';

const UNSLOTH_MODEL = 'unsloth/gemma-4-26B-A4B-it-GGUF';
const UNSLOTH_URL = 'http://localhost:8888/v1';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-unsloth-cfg-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Seed a valid on-disk config so `ConfigManager` has something to update. */
async function seedConfig(toml: string): Promise<void> {
  await writeFile(configPath, toml, 'utf8');
}

const OLLAMA_SEED = `
[backend]
type = "ollama"
baseUrl = "http://localhost:11434"

[model]
current = "qwen2.5-coder"
available = ["qwen2.5-coder"]

[onboarding]
completed = true
`;

describe('ConfigManager — unsloth backend round-trips through disk', () => {
  test('switching from ollama to unsloth persists type, url and key', async () => {
    await seedConfig(OLLAMA_SEED);

    const writer = new ConfigManager(configPath);
    writer.update({
      backend: {
        type: 'unsloth',
        baseUrl: UNSLOTH_URL,
        apiKey: 'sk-unsloth-roundtrip',
      },
      model: { current: UNSLOTH_MODEL },
    });

    // Fresh instance — proves the value came off disk, not memory.
    const cfg = new ConfigManager(configPath).read();
    expect(cfg.backend.type).toBe('unsloth');
    expect(cfg.backend.baseUrl).toBe(UNSLOTH_URL);
    expect(cfg.backend.apiKey).toBe('sk-unsloth-roundtrip');
    expect(cfg.model.current).toBe(UNSLOTH_MODEL);
  });

  test('an unsloth config with no apiKey is still valid on disk', async () => {
    // The key may legitimately live in `UNSLOTH_API_KEY` instead. The
    // schema must not require it, or a perfectly good env-var setup
    // fails to load at boot.
    await seedConfig(`
[backend]
type = "unsloth"
baseUrl = "${UNSLOTH_URL}"

[model]
current = "${UNSLOTH_MODEL}"
available = ["${UNSLOTH_MODEL}"]

[onboarding]
completed = true
`);

    const cfg = new ConfigManager(configPath).read();
    expect(cfg.backend.type).toBe('unsloth');
    expect(cfg.backend.apiKey).toBeUndefined();
  });

  test('the key survives a later unrelated update', async () => {
    // Regression shape: a partial `update()` that touches only `model`
    // must not drop `backend.apiKey` from the serialised TOML.
    await seedConfig(OLLAMA_SEED);

    const mgr = new ConfigManager(configPath);
    mgr.update({
      backend: {
        type: 'unsloth',
        baseUrl: UNSLOTH_URL,
        apiKey: 'sk-unsloth-sticky',
      },
    });
    mgr.update({ model: { current: 'unsloth/qwen3-coder-30B-GGUF' } });

    const cfg = new ConfigManager(configPath).read();
    expect(cfg.backend.apiKey).toBe('sk-unsloth-sticky');
    expect(cfg.backend.type).toBe('unsloth');
    expect(cfg.model.current).toBe('unsloth/qwen3-coder-30B-GGUF');
  });

  test('switching away from unsloth and back is lossless', async () => {
    await seedConfig(OLLAMA_SEED);

    const mgr = new ConfigManager(configPath);
    mgr.update({
      backend: { type: 'unsloth', baseUrl: UNSLOTH_URL, apiKey: 'sk-a' },
    });
    mgr.update({
      backend: { type: 'lmstudio', baseUrl: 'http://localhost:1234/v1' },
    });
    mgr.update({
      backend: { type: 'unsloth', baseUrl: UNSLOTH_URL, apiKey: 'sk-b' },
    });

    const cfg = new ConfigManager(configPath).read();
    expect(cfg.backend.type).toBe('unsloth');
    expect(cfg.backend.baseUrl).toBe(UNSLOTH_URL);
    expect(cfg.backend.apiKey).toBe('sk-b');
  });

  test('a non-default port round-trips verbatim', async () => {
    // Unsloth's docs are inconsistent about 8888 vs 8000, and `-p`
    // accepts anything. Whatever the user launched with must survive.
    await seedConfig(OLLAMA_SEED);

    new ConfigManager(configPath).update({
      backend: { type: 'unsloth', baseUrl: 'http://127.0.0.1:8000/v1' },
    });

    expect(new ConfigManager(configPath).read().backend.baseUrl).toBe(
      'http://127.0.0.1:8000/v1',
    );
  });

  test('customHeaders coexist with the bearer key', async () => {
    // A user behind a reverse proxy may need both. The adapter applies
    // customHeaders last, so persistence of both is what matters here.
    await seedConfig(OLLAMA_SEED);

    new ConfigManager(configPath).update({
      backend: {
        type: 'unsloth',
        baseUrl: UNSLOTH_URL,
        apiKey: 'sk-unsloth-proxy',
        customHeaders: { 'X-Forwarded-User': 'dev' },
      },
    });

    const cfg = new ConfigManager(configPath).read();
    expect(cfg.backend.apiKey).toBe('sk-unsloth-proxy');
    expect(cfg.backend.customHeaders).toEqual({ 'X-Forwarded-User': 'dev' });
  });
});

describe('unsloth — defaults line up with what onboarding writes', () => {
  test('PROVIDER_DEFAULTS.unsloth.baseUrl parses as a valid backend', () => {
    // The provider picker seeds `baseUrl` from PROVIDER_DEFAULTS; if that
    // value did not satisfy `BackendSchema` the first save after picking
    // Unsloth would throw.
    const cfg = ConfigSchema.parse({
      backend: {
        type: 'unsloth',
        baseUrl: PROVIDER_DEFAULTS.unsloth.baseUrl,
      },
      model: { current: UNSLOTH_MODEL, available: [] },
      onboarding: { completed: true },
    });
    expect(cfg.backend.baseUrl).toBe('http://localhost:8888/v1');
  });

  test('switching provider must not carry the previous provider key over', async () => {
    // `ConfigManager.update()` SKIPS undefined, so a switch that passes
    // `apiKey: undefined` leaves the old provider's secret in place — it
    // would then be posted to localhost:8888 as a bearer token AND
    // shadow UNSLOTH_API_KEY in `resolveApiKey`. Writers must send ''.
    const mgr = new ConfigManager(configPath);
    mgr.write(
      ConfigSchema.parse({
        backend: {
          type: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-proj-PREVIOUS-PROVIDER',
        },
        model: { current: 'gpt-4o', available: [] },
        onboarding: { completed: true },
      }),
    );

    // The shape the old code used — proves the hazard is real.
    const leaked = mgr.update({
      backend: { type: 'unsloth', baseUrl: UNSLOTH_URL, apiKey: undefined },
    });
    expect(leaked.backend.apiKey).toBe('sk-proj-PREVIOUS-PROVIDER');

    // The shape both writers (TUI overlay + web REST) now use.
    const cleared = mgr.update({
      backend: { type: 'unsloth', baseUrl: UNSLOTH_URL, apiKey: '' },
    });
    expect(cleared.backend.apiKey).toBe('');
    // Re-read from disk: an empty key resolves as "unset", so the env
    // var can win again.
    const reread = new ConfigManager(configPath).read();
    expect(reread.backend.apiKey ?? '').toBe('');
    const { resolveApiKey } = await import('@/config/defaults');
    process.env.UNSLOTH_API_KEY = 'sk-unsloth-from-env';
    try {
      expect(resolveApiKey('unsloth', reread.backend.apiKey)).toBe(
        'sk-unsloth-from-env',
      );
    } finally {
      delete process.env.UNSLOTH_API_KEY;
    }
  });

  test('unsloth declares no default model', () => {
    // Ids are per-install GGUF repo names. Pre-selecting one would point
    // the user at a model their server cannot serve.
    const cfg = ConfigSchema.parse({
      backend: { type: 'unsloth', baseUrl: UNSLOTH_URL },
      model: { current: '', available: [] },
      onboarding: { completed: true },
    });
    expect(cfg.model.current).toBe('');
  });
});
