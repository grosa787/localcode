/**
 * R13 (Agent 8) — `/model` slash-command behaviour:
 *   - `/model`                       → opens the model overlay with no
 *                                      filter pre-applied.
 *   - `/model refresh`               → re-fetches the model list (legacy).
 *   - `/model <exact-id>`            → switches the active model directly,
 *                                      no overlay surfaces.
 *   - `/model <query>` (no exact)    → opens the overlay PRE-FILTERED
 *                                      with `<query>` so arrows navigate
 *                                      the narrowed list immediately.
 *
 * The fall-through (no `showOverlay` dispatcher) keeps the legacy
 * "warn + persist" behaviour so headless / non-interactive callers
 * continue to function.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import { createModelCommand } from '@/commands/cmd-model';
import { getDefaultConfig } from '@/config/defaults';
import { LLMAdapter } from '@/llm/adapter';
import type {
  AppConfig,
  CommandContext,
  OverlayKind,
  Screen,
} from '@/types/global';

let tmpDir = '';
let configPath = '';
let cfgMgr: ConfigManager;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-cmdmodel-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
  cfgMgr = new ConfigManager(configPath);
  const base = getDefaultConfig('ollama');
  base.model.current = 'anthropic/claude-3-5-sonnet-20241022';
  base.model.available = [
    'anthropic/claude-3-5-sonnet-20241022',
    'anthropic/claude-3-haiku-20240307',
    'openai/gpt-4o',
    'mistralai/mistral-large',
  ];
  base.onboarding.completed = true;
  cfgMgr.write(base);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

interface OverlayCall {
  readonly kind: OverlayKind;
  readonly data: { filter?: string } | undefined;
}

interface BuiltCtx {
  readonly ctx: CommandContext;
  readonly output: string[];
  readonly overlayCalls: OverlayCall[];
  readonly screenCalls: Screen[];
}

interface BuildOpts {
  readonly withOverlay?: boolean;
}

function buildCtx(opts: BuildOpts = {}): BuiltCtx {
  const output: string[] = [];
  const overlayCalls: OverlayCall[] = [];
  const screenCalls: Screen[] = [];
  const config: AppConfig = cfgMgr.read();
  const showOverlay =
    opts.withOverlay === true
      ? (kind: OverlayKind, data?: { filter?: string }) => {
          overlayCalls.push({ kind, data });
        }
      : undefined;
  const ctx: CommandContext = {
    projectRoot: tmpDir,
    sessionId: null,
    config,
    print: (t: string) => output.push(t),
    setScreen: (s: Screen) => screenCalls.push(s),
    ...(showOverlay !== undefined ? { showOverlay } : {}),
  };
  return { ctx, output, overlayCalls, screenCalls };
}

/**
 * Minimal LLMAdapter stub — `cmd-model.ts` only ever calls `getModels()`
 * on this dep, so we can construct a real adapter (its constructor has
 * no side-effects beyond field assignment) and override that single
 * method on the instance for the `/model refresh` test. For the
 * exact-match / filter / no-arg paths we never call into the adapter,
 * so the field default is fine.
 */
function makeFakeAdapter(modelsToReturn: readonly string[] = []): LLMAdapter {
  const adapter = new LLMAdapter({
    baseUrl: 'http://127.0.0.1:1',
    model: 'placeholder',
    backend: 'ollama',
  });
  Object.defineProperty(adapter, 'getModels', {
    value: async () => [...modelsToReturn],
    writable: true,
  });
  return adapter;
}

describe('/model — no-arg invocation', () => {
  test('with showOverlay → opens model overlay with no filter', async () => {
    const cmd = createModelCommand({
      llm: makeFakeAdapter(),
      configManager: cfgMgr,
      setScreen: () => {
        /* no-op */
      },
    });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('', ctx);
    expect(overlayCalls.length).toBe(1);
    expect(overlayCalls[0]?.kind).toBe('model');
    // No filter passed (undefined data is acceptable; what matters is
    // that the overlay is told to open with no query staged).
    expect(overlayCalls[0]?.data?.filter).toBeUndefined();
    expect(output.length).toBe(0);
  });

  test('without showOverlay → falls back to setScreen("modelSelect")', async () => {
    const screenCalls: Screen[] = [];
    const cmd = createModelCommand({
      llm: makeFakeAdapter(),
      configManager: cfgMgr,
      setScreen: (s) => screenCalls.push(s),
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(screenCalls).toEqual(['modelSelect']);
    expect(output.length).toBe(0);
  });
});

describe('/model — exact-match switch', () => {
  test('exact id with showOverlay → switches model directly, no overlay', async () => {
    const cmd = createModelCommand({
      llm: makeFakeAdapter(),
      configManager: cfgMgr,
      setScreen: () => {
        /* no-op */
      },
    });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('openai/gpt-4o', ctx);
    expect(overlayCalls).toEqual([]);
    expect(cfgMgr.read().model.current).toBe('openai/gpt-4o');
    expect(output.join('\n')).toContain('Model switched to openai/gpt-4o');
  });

  test('exact id without showOverlay → still switches model directly', async () => {
    const cmd = createModelCommand({
      llm: makeFakeAdapter(),
      configManager: cfgMgr,
      setScreen: () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('anthropic/claude-3-haiku-20240307', ctx);
    expect(cfgMgr.read().model.current).toBe('anthropic/claude-3-haiku-20240307');
    expect(output.join('\n')).toContain('Model switched to');
  });
});

describe('/model — non-exact query (R13)', () => {
  test('query with showOverlay → opens overlay pre-filtered, does NOT switch', async () => {
    const cmd = createModelCommand({
      llm: makeFakeAdapter(),
      configManager: cfgMgr,
      setScreen: () => {
        /* no-op */
      },
    });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('claude', ctx);
    // Overlay opened with the query staged as initial filter.
    expect(overlayCalls.length).toBe(1);
    expect(overlayCalls[0]?.kind).toBe('model');
    expect(overlayCalls[0]?.data?.filter).toBe('claude');
    // No model switch, no warning text.
    expect(cfgMgr.read().model.current).toBe(
      'anthropic/claude-3-5-sonnet-20241022',
    );
    expect(output.length).toBe(0);
  });

  test('query without showOverlay → legacy warn-and-persist fall-through', async () => {
    const cmd = createModelCommand({
      llm: makeFakeAdapter(),
      configManager: cfgMgr,
      setScreen: () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('claude', ctx);
    // No overlay dispatcher → behaviour preserved: warn, then persist.
    const joined = output.join('\n');
    expect(joined).toContain("Warning: 'claude'");
    expect(joined).toContain('Model switched to claude');
    expect(cfgMgr.read().model.current).toBe('claude');
  });

  test('query equal to the prefix of an id is still treated as a query', async () => {
    // 'anthropic' is a prefix of two cached ids but is NOT itself a
    // cached id, so it must NOT switch the model — it must open the
    // overlay narrowed to the prefix.
    const cmd = createModelCommand({
      llm: makeFakeAdapter(),
      configManager: cfgMgr,
      setScreen: () => {
        /* no-op */
      },
    });
    const { ctx, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('anthropic', ctx);
    expect(overlayCalls.length).toBe(1);
    expect(overlayCalls[0]?.data?.filter).toBe('anthropic');
    expect(cfgMgr.read().model.current).toBe(
      'anthropic/claude-3-5-sonnet-20241022',
    );
  });

  test('query with surrounding whitespace is trimmed before lookup', async () => {
    const cmd = createModelCommand({
      llm: makeFakeAdapter(),
      configManager: cfgMgr,
      setScreen: () => {
        /* no-op */
      },
    });
    const { ctx, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('   claude   ', ctx);
    expect(overlayCalls.length).toBe(1);
    expect(overlayCalls[0]?.data?.filter).toBe('claude');
  });
});

describe('/model — empty registry edge case', () => {
  test('non-exact query with empty cached list → legacy warn-skip + persist', async () => {
    cfgMgr.update({ model: { available: [] } });
    const cmd = createModelCommand({
      llm: makeFakeAdapter(),
      configManager: cfgMgr,
      setScreen: () => {
        /* no-op */
      },
    });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    // Re-build context so it picks up the empty `available` list.
    const ctx2: CommandContext = { ...ctx, config: cfgMgr.read() };
    await cmd.execute('claude', ctx2);
    // Empty registry → cmd-model trusts the server, no overlay opened.
    expect(overlayCalls).toEqual([]);
    expect(cfgMgr.read().model.current).toBe('claude');
    // No warning text either (the warning only triggers when the
    // cache has entries to validate against).
    expect(output.join('\n')).toContain('Model switched to claude');
    expect(output.join('\n')).not.toContain('Warning:');
  });
});

describe('/model refresh — unchanged by R13', () => {
  test('refresh subcommand still re-fetches and persists', async () => {
    const cmd = createModelCommand({
      llm: makeFakeAdapter(['stub-a', 'stub-b']),
      configManager: cfgMgr,
      setScreen: () => {
        /* no-op */
      },
    });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('refresh', ctx);
    expect(overlayCalls).toEqual([]);
    expect(cfgMgr.read().model.available).toEqual(['stub-a', 'stub-b']);
    expect(output.join('\n')).toContain('Refreshed 2 model(s)');
  });
});
