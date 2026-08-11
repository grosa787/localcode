/**
 * POST /api/config/provider — API-key isolation across a provider switch.
 *
 * `BackendConfig` has ONE `apiKey` slot, so a switch has to decide what
 * happens to the key of the provider being left behind. Two ways to get
 * it wrong, both of which shipped:
 *
 *   1. Passing it to the NEW provider's probe — an `sk-proj-…` posted to
 *      localhost:8888 (401, switch refused) while the correct env var
 *      sat unread.
 *   2. Leaving it on disk — `ConfigManager.update()` skips `undefined`,
 *      so the stale secret survives, gets sent on every later request,
 *      and shadows the env-var fallback in `resolveApiKey`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigManager } from '@/config/config-manager';
import { getDefaultConfig } from '@/config/defaults';
import { handleConfigProvider } from '@/web/api/config';
import type { Backend } from '@/types/global';

let tmpDir = '';
let cfgMgr: ConfigManager;

const OPENAI_KEY = 'sk-proj-PREVIOUS-PROVIDER';

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-provswitch-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  cfgMgr = new ConfigManager(path.join(tmpDir, 'config.toml'));
  const cfg = getDefaultConfig('openai');
  cfg.backend.apiKey = OPENAI_KEY;
  cfg.model.current = 'gpt-4o';
  cfg.model.available = ['gpt-4o'];
  cfg.onboarding.completed = true;
  cfgMgr.write(cfg);
  delete process.env.UNSLOTH_API_KEY;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.UNSLOTH_API_KEY;
});

/** Captures the key handed to the adapter factory. */
function deps(seen: { key?: string }[]): Parameters<typeof handleConfigProvider>[2] {
  return {
    configManager: cfgMgr,
    sessionManager: {} as never,
    workspaceRegistry: {} as never,
    createAdapterForBackend: (_b: Backend, _url: string, key?: string) => {
      seen.push({ ...(key !== undefined ? { key } : {}) });
      return { getModels: async () => ['unsloth/qwen3-coder-GGUF'] };
    },
  } as unknown as Parameters<typeof handleConfigProvider>[2];
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/config/provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('provider switch — key isolation', () => {
  test('does not hand the previous provider key to the new backend', async () => {
    process.env.UNSLOTH_API_KEY = 'sk-unsloth-from-env';
    const seen: { key?: string }[] = [];
    const url = new URL('http://localhost/api/config/provider');
    const res = await handleConfigProvider(req({ type: 'unsloth' }), url, deps(seen));
    expect(res.status).toBe(200);
    expect(seen[0]?.key).toBe('sk-unsloth-from-env');
    expect(seen[0]?.key).not.toBe(OPENAI_KEY);
  });

  test('clears the stale key on disk so the env var can win later', async () => {
    process.env.UNSLOTH_API_KEY = 'sk-unsloth-from-env';
    const url = new URL('http://localhost/api/config/provider');
    await handleConfigProvider(req({ type: 'unsloth' }), url, deps([]));
    const after = new ConfigManager(path.join(tmpDir, 'config.toml')).read();
    expect(after.backend.type).toBe('unsloth');
    expect(after.backend.apiKey ?? '').toBe('');
  });

  test('an explicit key in the request still wins', async () => {
    const seen: { key?: string }[] = [];
    const url = new URL('http://localhost/api/config/provider');
    await handleConfigProvider(
      req({ type: 'unsloth', apiKey: 'sk-unsloth-typed' }),
      url,
      deps(seen),
    );
    expect(seen[0]?.key).toBe('sk-unsloth-typed');
    const after = new ConfigManager(path.join(tmpDir, 'config.toml')).read();
    expect(after.backend.apiKey).toBe('sk-unsloth-typed');
  });

  test('re-selecting the SAME provider keeps its stored key', async () => {
    const seen: { key?: string }[] = [];
    const url = new URL('http://localhost/api/config/provider');
    await handleConfigProvider(req({ type: 'openai' }), url, deps(seen));
    expect(seen[0]?.key).toBe(OPENAI_KEY);
    const after = new ConfigManager(path.join(tmpDir, 'config.toml')).read();
    expect(after.backend.apiKey).toBe(OPENAI_KEY);
  });
});
