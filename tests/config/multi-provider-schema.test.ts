/**
 * R7 (Agent 9) — multi-provider config schema tests.
 *
 * Covers:
 *   - `BackendSchema` accepts every member of the widened `Backend`
 *     enum, including new cloud providers (`openai`, `anthropic`,
 *     `openrouter`, `google`, `custom`).
 *   - Old TOML configs (no `apiKey`, no `customHeaders`) parse cleanly
 *     because both fields are optional.
 *   - `apiKey` and `customHeaders` round-trip through `ConfigManager`.
 *   - `PROVIDER_DEFAULTS[backend].baseUrl` returns the expected URL for
 *     each backend.
 *   - `PROVIDER_META[backend].displayName` is defined for every
 *     backend.
 *   - `resolveApiKey()` reads the explicit config value first, then
 *     falls back to the per-provider env var declared in
 *     `PROVIDER_META[backend].apiKeyEnvVar`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import {
  PROVIDER_DEFAULTS,
  PROVIDER_META,
  resolveApiKey,
} from '@/config/defaults';
import {
  BackendSchema,
  BackendTypeSchema,
  ConfigSchema,
} from '@/config/types';
import type { Backend } from '@/types/global';

let tmpDir = '';
let configPath = '';

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `lc-multi-provider-${crypto.randomUUID()}`,
  );
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const ALL_BACKENDS: Backend[] = [
  'ollama',
  'lmstudio',
  'openai',
  'anthropic',
  'openrouter',
  'google',
  'unsloth',
  'custom',
];

describe('BackendTypeSchema — accepts every backend kind', () => {
  test('every member of the Backend union parses', () => {
    for (const b of ALL_BACKENDS) {
      const result = BackendTypeSchema.safeParse(b);
      expect(result.success).toBe(true);
    }
  });

  test('rejects unknown backend strings', () => {
    const result = BackendTypeSchema.safeParse('palm');
    expect(result.success).toBe(false);
  });

  // Explicit, non-loop assertion. The `ALL_BACKENDS` loop above only
  // covers what the array lists, so it cannot fail when a provider is
  // missing from the schema — it would simply never be tested. This
  // names `unsloth` directly so dropping it from `BackendTypeSchema`
  // is a red test rather than silent loss of coverage.
  test('unsloth parses', () => {
    expect(BackendTypeSchema.parse('unsloth')).toBe('unsloth');
  });
});

describe('BackendSchema — apiKey + customHeaders are optional', () => {
  test('parses without apiKey or customHeaders (old TOML shape)', () => {
    const parsed = BackendSchema.safeParse({
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.apiKey).toBeUndefined();
      expect(parsed.data.customHeaders).toBeUndefined();
    }
  });

  test('parses with apiKey only', () => {
    const parsed = BackendSchema.safeParse({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-123',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.apiKey).toBe('sk-test-123');
    }
  });

  test('parses with customHeaders only', () => {
    const parsed = BackendSchema.safeParse({
      type: 'custom',
      baseUrl: 'https://api.groq.com/openai/v1',
      customHeaders: { 'X-Org': 'acme' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.customHeaders).toEqual({ 'X-Org': 'acme' });
    }
  });

  test('accepts the empty literal baseUrl for custom', () => {
    const parsed = BackendSchema.safeParse({
      type: 'custom',
      baseUrl: '',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('ConfigManager — old TOML without apiKey parses cleanly', () => {
  test('legacy TOML (pre-R9) reads without errors and apiKey is undefined', async () => {
    const toml = `
[backend]
type = "ollama"
baseUrl = "http://localhost:11434"

[model]
current = "llama3"
available = ["llama3"]

[onboarding]
completed = true
`;
    await fsWriteFile(configPath, toml, 'utf8');
    const mgr = new ConfigManager(configPath);
    const cfg = mgr.read();
    expect(cfg.backend.type).toBe('ollama');
    expect(cfg.backend.apiKey).toBeUndefined();
    expect(cfg.backend.customHeaders).toBeUndefined();
  });
});

describe('ConfigManager — apiKey field round-trips', () => {
  test('writing apiKey persists through write+read', async () => {
    const toml = `
[backend]
type = "openai"
baseUrl = "https://api.openai.com/v1"

[model]
current = "gpt-4o"
available = ["gpt-4o"]

[onboarding]
completed = true
`;
    await fsWriteFile(configPath, toml, 'utf8');
    const mgr = new ConfigManager(configPath);
    mgr.update({
      backend: {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-roundtrip-test',
      },
    });
    const cfg = mgr.read();
    expect(cfg.backend.apiKey).toBe('sk-roundtrip-test');
    expect(cfg.backend.type).toBe('openai');
  });
});

describe('ConfigManager — customHeaders field round-trips', () => {
  test('customHeaders persist through write+read', async () => {
    const toml = `
[backend]
type = "custom"
baseUrl = "https://api.fireworks.ai/inference/v1"

[model]
current = "accounts/fireworks/models/llama"
available = ["accounts/fireworks/models/llama"]

[onboarding]
completed = true
`;
    await fsWriteFile(configPath, toml, 'utf8');
    const mgr = new ConfigManager(configPath);
    mgr.update({
      backend: {
        type: 'custom',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        customHeaders: {
          'X-Tenant': 'team-1',
          'X-Trace-Id': 'abc-123',
        },
      },
    });
    const cfg = mgr.read();
    expect(cfg.backend.customHeaders).toEqual({
      'X-Tenant': 'team-1',
      'X-Trace-Id': 'abc-123',
    });
  });
});

describe('PROVIDER_DEFAULTS — base URLs', () => {
  test('every backend has a defined base URL entry', () => {
    for (const b of ALL_BACKENDS) {
      const entry = PROVIDER_DEFAULTS[b];
      expect(entry).toBeDefined();
      expect(typeof entry.baseUrl).toBe('string');
      expect(typeof entry.requiresApiKey).toBe('boolean');
    }
  });

  test('returns expected URLs for known providers', () => {
    expect(PROVIDER_DEFAULTS.ollama.baseUrl).toBe('http://localhost:11434');
    expect(PROVIDER_DEFAULTS.lmstudio.baseUrl).toBe(
      'http://localhost:1234/v1',
    );
    expect(PROVIDER_DEFAULTS.openai.baseUrl).toBe(
      'https://api.openai.com/v1',
    );
    expect(PROVIDER_DEFAULTS.anthropic.baseUrl).toBe(
      'https://api.anthropic.com/v1',
    );
    expect(PROVIDER_DEFAULTS.openrouter.baseUrl).toBe(
      'https://openrouter.ai/api/v1',
    );
    expect(PROVIDER_DEFAULTS.google.baseUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
    expect(PROVIDER_DEFAULTS.custom.baseUrl).toBe('');
    expect(PROVIDER_DEFAULTS.unsloth.baseUrl).toBe(
      'http://localhost:8888/v1',
    );
  });

  test('cloud providers requireApiKey, local providers do not', () => {
    expect(PROVIDER_DEFAULTS.ollama.requiresApiKey).toBe(false);
    expect(PROVIDER_DEFAULTS.lmstudio.requiresApiKey).toBe(false);
    expect(PROVIDER_DEFAULTS.openai.requiresApiKey).toBe(true);
    expect(PROVIDER_DEFAULTS.anthropic.requiresApiKey).toBe(true);
    expect(PROVIDER_DEFAULTS.openrouter.requiresApiKey).toBe(true);
    expect(PROVIDER_DEFAULTS.google.requiresApiKey).toBe(true);
  });

  // The load-bearing exception to the rule above. Unsloth Studio runs on
  // localhost yet rejects unauthenticated requests, so "local" must NOT
  // be read as "needs no key" anywhere in the codebase. If this flips to
  // false, the provider UI hides the key field and every request 401s.
  test('unsloth is local BUT requires an API key', () => {
    expect(PROVIDER_DEFAULTS.unsloth.requiresApiKey).toBe(true);
  });
});

describe('PROVIDER_META — display names + env vars', () => {
  test('displayName is defined for every backend', () => {
    for (const b of ALL_BACKENDS) {
      const meta = PROVIDER_META[b];
      expect(meta).toBeDefined();
      expect(typeof meta.displayName).toBe('string');
      expect(meta.displayName.length).toBeGreaterThan(0);
    }
  });

  test('cloud providers declare an apiKeyEnvVar', () => {
    expect(PROVIDER_META.openai.apiKeyEnvVar).toBe('OPENAI_API_KEY');
    expect(PROVIDER_META.anthropic.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY');
    expect(PROVIDER_META.openrouter.apiKeyEnvVar).toBe('OPENROUTER_API_KEY');
    expect(PROVIDER_META.google.apiKeyEnvVar).toBe('GEMINI_API_KEY');
  });

  test('keyless local providers do NOT declare an apiKeyEnvVar', () => {
    expect(PROVIDER_META.ollama.apiKeyEnvVar).toBeUndefined();
    expect(PROVIDER_META.lmstudio.apiKeyEnvVar).toBeUndefined();
    expect(PROVIDER_META.custom.apiKeyEnvVar).toBeUndefined();
  });

  test('unsloth declares UNSLOTH_API_KEY as its canonical env var', () => {
    expect(PROVIDER_META.unsloth.apiKeyEnvVar).toBe('UNSLOTH_API_KEY');
  });

  test('unsloth declares UNSLOTH_STUDIO_AUTH_TOKEN as an alias', () => {
    // Unsloth's own tooling exports the *_STUDIO_AUTH_TOKEN name, so a
    // shell already set up for Unsloth must work untouched. The UI still
    // shows only the canonical name.
    expect(PROVIDER_META.unsloth.apiKeyEnvVarAliases).toContain(
      'UNSLOTH_STUDIO_AUTH_TOKEN',
    );
  });

  test('unsloth is labelled "Unsloth Studio (local)"', () => {
    expect(PROVIDER_META.unsloth.displayName).toBe('Unsloth Studio (local)');
  });

  test('unsloth key help mentions the mandatory --disable-tools flag', () => {
    // Without --disable-tools the server swallows tool calls and the
    // agent silently does nothing, so this hint must stay discoverable
    // wherever the key is entered.
    expect(PROVIDER_META.unsloth.apiKeyHelp ?? '').toContain(
      '--disable-tools',
    );
  });
});

describe('resolveApiKey — explicit config value wins', () => {
  test('returns the explicit config key when non-empty', () => {
    const got = resolveApiKey('openai', 'sk-explicit');
    expect(got).toBe('sk-explicit');
  });

  test('falls back to env var when config key is undefined', () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-from-env';
    try {
      const got = resolveApiKey('openai', undefined);
      expect(got).toBe('sk-from-env');
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  test('falls back to env var when config key is empty string', () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-from-env-2';
    try {
      const got = resolveApiKey('openai', '');
      expect(got).toBe('sk-from-env-2');
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });
});

describe('resolveApiKey — env var fallback for all cloud providers', () => {
  test('Anthropic: ANTHROPIC_API_KEY', () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xyz';
    try {
      expect(resolveApiKey('anthropic', undefined)).toBe('sk-ant-xyz');
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });

  test('OpenRouter: OPENROUTER_API_KEY', () => {
    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'or-xyz';
    try {
      expect(resolveApiKey('openrouter', undefined)).toBe('or-xyz');
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });

  test('Google: GEMINI_API_KEY', () => {
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIza-xyz';
    try {
      expect(resolveApiKey('google', undefined)).toBe('AIza-xyz');
    } finally {
      if (original === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original;
    }
  });

  test('local providers: returns undefined regardless of env state', () => {
    expect(resolveApiKey('ollama', undefined)).toBeUndefined();
    expect(resolveApiKey('lmstudio', undefined)).toBeUndefined();
  });

  test('custom provider has no env var fallback (returns undefined when no config key)', () => {
    expect(resolveApiKey('custom', undefined)).toBeUndefined();
  });

  test('custom provider returns explicit key when supplied', () => {
    expect(resolveApiKey('custom', 'gsk-test-key')).toBe('gsk-test-key');
  });
});

describe('resolveApiKey — unsloth canonical + alias env vars', () => {
  /**
   * Runs `fn` with both Unsloth env vars forced to a known state, then
   * restores whatever the ambient environment had. Necessary because
   * these tests assert on *absence* as well as presence, and a developer
   * with UNSLOTH_API_KEY exported would otherwise get false greens.
   */
  function withUnslothEnv(
    canonical: string | undefined,
    alias: string | undefined,
    fn: () => void,
  ): void {
    const origCanonical = process.env.UNSLOTH_API_KEY;
    const origAlias = process.env.UNSLOTH_STUDIO_AUTH_TOKEN;
    try {
      if (canonical === undefined) delete process.env.UNSLOTH_API_KEY;
      else process.env.UNSLOTH_API_KEY = canonical;
      if (alias === undefined) delete process.env.UNSLOTH_STUDIO_AUTH_TOKEN;
      else process.env.UNSLOTH_STUDIO_AUTH_TOKEN = alias;
      fn();
    } finally {
      if (origCanonical === undefined) delete process.env.UNSLOTH_API_KEY;
      else process.env.UNSLOTH_API_KEY = origCanonical;
      if (origAlias === undefined) {
        delete process.env.UNSLOTH_STUDIO_AUTH_TOKEN;
      } else {
        process.env.UNSLOTH_STUDIO_AUTH_TOKEN = origAlias;
      }
    }
  }

  test('canonical UNSLOTH_API_KEY resolves', () => {
    withUnslothEnv('sk-unsloth-canonical', undefined, () => {
      expect(resolveApiKey('unsloth', undefined)).toBe(
        'sk-unsloth-canonical',
      );
    });
  });

  test('alias UNSLOTH_STUDIO_AUTH_TOKEN resolves when it is the only one set', () => {
    withUnslothEnv(undefined, 'sk-unsloth-alias', () => {
      expect(resolveApiKey('unsloth', undefined)).toBe('sk-unsloth-alias');
    });
  });

  test('canonical wins when both are exported', () => {
    // The alias is a compatibility shim, not an override — the name the
    // UI advertises must be the one that takes effect.
    withUnslothEnv('sk-unsloth-canonical', 'sk-unsloth-alias', () => {
      expect(resolveApiKey('unsloth', undefined)).toBe(
        'sk-unsloth-canonical',
      );
    });
  });

  test('explicit config key beats both env vars', () => {
    withUnslothEnv('sk-unsloth-canonical', 'sk-unsloth-alias', () => {
      expect(resolveApiKey('unsloth', 'sk-unsloth-explicit')).toBe(
        'sk-unsloth-explicit',
      );
    });
  });

  test('undefined when neither env var is set and no config key', () => {
    withUnslothEnv(undefined, undefined, () => {
      expect(resolveApiKey('unsloth', undefined)).toBeUndefined();
    });
  });

  test('empty-string env values are ignored, alias still consulted', () => {
    withUnslothEnv('', 'sk-unsloth-alias', () => {
      expect(resolveApiKey('unsloth', undefined)).toBe('sk-unsloth-alias');
    });
  });
});

describe('ConfigSchema — full root parse with multi-provider backend', () => {
  test('parses a full config with anthropic backend + apiKey', () => {
    const minimal = {
      backend: {
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test',
      },
      model: { current: 'claude-3-5-sonnet-20241022', available: [] },
      onboarding: { completed: true },
    };
    const parsed = ConfigSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.backend.type).toBe('anthropic');
      expect(parsed.data.backend.apiKey).toBe('sk-ant-test');
    }
  });

  test('parses with customHeaders embedded under backend', () => {
    const minimal = {
      backend: {
        type: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'or-test',
        customHeaders: {
          'HTTP-Referer': 'https://example.com',
          'X-Title': 'MyApp',
        },
      },
      model: { current: 'anthropic/claude-3.5-sonnet', available: [] },
      onboarding: { completed: true },
    };
    const parsed = ConfigSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.backend.customHeaders).toEqual({
        'HTTP-Referer': 'https://example.com',
        'X-Title': 'MyApp',
      });
    }
  });
});
