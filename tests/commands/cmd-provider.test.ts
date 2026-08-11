/**
 * /provider — switch backend (Ollama, LM Studio, custom URL).
 *
 * Subcommands covered:
 *   /provider                    → opens overlay if showOverlay is wired,
 *                                  otherwise prints current + usage hint.
 *   /provider show               → prints `Backend: <type>  <baseUrl>`.
 *   /provider ollama             → switches to Ollama default URL.
 *   /provider lmstudio           → switches to LM Studio default URL.
 *   /provider custom <url>       → keeps current backend type, updates URL.
 *   /provider custom <bad-url>   → prints usage error, does not mutate.
 *   /provider <unknown>          → prints `Unknown subcommand: …`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import { createProviderCommand } from '@/commands/cmd-provider';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext, OverlayKind } from '@/types/global';

let tmpDir = '';
let configPath = '';
let cfgMgr: ConfigManager;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-providercmd-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
  cfgMgr = new ConfigManager(configPath);
  const base = getDefaultConfig('ollama');
  base.model.current = 'm';
  base.model.available = ['m'];
  base.onboarding.completed = true;
  cfgMgr.write(base);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

interface BuildOpts {
  overlayDispatcher?: (kind: OverlayKind) => void;
}

function buildCtx(opts: BuildOpts = {}): {
  ctx: CommandContext;
  output: string[];
  overlayCalls: OverlayKind[];
} {
  const output: string[] = [];
  const overlayCalls: OverlayKind[] = [];
  const config: AppConfig = cfgMgr.read();
  const showOverlay =
    opts.overlayDispatcher !== undefined
      ? (kind: OverlayKind) => {
          overlayCalls.push(kind);
          opts.overlayDispatcher!(kind);
        }
      : undefined;
  const ctx: CommandContext = {
    projectRoot: tmpDir,
    sessionId: null,
    config,
    print: (t: string) => output.push(t),
    setScreen: () => {
      /* no-op */
    },
    ...(showOverlay !== undefined ? { showOverlay } : {}),
  };
  return { ctx, output, overlayCalls };
}

describe('/provider show', () => {
  test('prints the current backend type and URL', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('show', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Backend');
    expect(joined).toContain('ollama');
    expect(joined).toContain('http://localhost:11434');
  });
});

describe('/provider <type> — switch backend', () => {
  test('lmstudio switches type and URL to LM Studio defaults', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    await cmd.execute('lmstudio', buildCtx().ctx);

    const reread = cfgMgr.read();
    expect(reread.backend.type).toBe('lmstudio');
    expect(reread.backend.baseUrl).toBe('http://localhost:1234/v1');
  });

  test('ollama switches type and URL to Ollama defaults (when on lmstudio)', async () => {
    // First switch to lmstudio so we can check the round-trip.
    cfgMgr.update({
      backend: { type: 'lmstudio', baseUrl: 'http://localhost:1234/v1' },
    });
    const cmd = createProviderCommand({ configManager: cfgMgr });
    await cmd.execute('ollama', buildCtx().ctx);

    const reread = cfgMgr.read();
    expect(reread.backend.type).toBe('ollama');
    expect(reread.backend.baseUrl).toBe('http://localhost:11434');
  });

  test('switching to the same backend preserves the existing URL', async () => {
    // We're already on ollama with a custom URL.
    cfgMgr.update({
      backend: { type: 'ollama', baseUrl: 'http://10.0.0.5:11434' },
    });
    const cmd = createProviderCommand({ configManager: cfgMgr });
    await cmd.execute('ollama', buildCtx().ctx);

    const reread = cfgMgr.read();
    expect(reread.backend.type).toBe('ollama');
    expect(reread.backend.baseUrl).toBe('http://10.0.0.5:11434');
  });

  test('unsloth switches type and URL to Unsloth Studio defaults', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    await cmd.execute('unsloth', buildCtx().ctx);

    const reread = cfgMgr.read();
    expect(reread.backend.type).toBe('unsloth');
    expect(reread.backend.baseUrl).toBe('http://localhost:8888/v1');
  });

  test('unsloth switch warns about the mandatory --disable-tools flag', async () => {
    // Without --disable-tools, Unsloth's own server-side tool loop
    // intercepts tool calls and LocalCode silently does nothing — no
    // error, no 4xx. The switch is the moment the user is looking, so
    // the warning must be printed here. The assertion targets the flag
    // itself, which is identical in every locale.
    const cmd = createProviderCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('unsloth', ctx);
    expect(output.join('\n')).toContain('--disable-tools');
  });

  test('switching to a non-unsloth backend does NOT print the warning', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('lmstudio', ctx);
    expect(output.join('\n')).not.toContain('--disable-tools');
  });

  test('switching unsloth → unsloth preserves a hand-set URL (e.g. port 8000)', async () => {
    // One Unsloth doc page documents port 8000 rather than 8888, so a
    // user may legitimately be on a non-default port. Re-running the
    // switch must not stomp it back to the default.
    cfgMgr.update({
      backend: { type: 'unsloth', baseUrl: 'http://localhost:8000/v1' },
    });
    const cmd = createProviderCommand({ configManager: cfgMgr });
    await cmd.execute('unsloth', buildCtx().ctx);

    const reread = cfgMgr.read();
    expect(reread.backend.type).toBe('unsloth');
    expect(reread.backend.baseUrl).toBe('http://localhost:8000/v1');
  });

  test('after switching, /provider show reflects the new backend', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    await cmd.execute('lmstudio', buildCtx().ctx);
    const { ctx, output } = buildCtx();
    await cmd.execute('show', ctx);
    expect(output.join('\n')).toContain('lmstudio');
  });
});

describe('/provider custom <url>', () => {
  test('updates baseUrl while preserving the current backend type', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    await cmd.execute(
      'custom http://example.com:8080/v1',
      buildCtx().ctx,
    );
    const reread = cfgMgr.read();
    expect(reread.backend.type).toBe('ollama');
    expect(reread.backend.baseUrl).toBe('http://example.com:8080/v1');
  });

  test('rejects malformed URL with a usage error', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('custom not-a-url', ctx);
    expect(output.join('\n')).toMatch(/Usage:.*custom/);
    // Config unchanged.
    const reread = cfgMgr.read();
    expect(reread.backend.baseUrl).toBe('http://localhost:11434');
  });

  test('rejects empty URL with a usage error', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('custom', ctx);
    expect(output.join('\n')).toMatch(/Usage:.*custom/);
  });

  test('https URLs are accepted', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    await cmd.execute('custom https://api.openai.com/v1', buildCtx().ctx);
    const reread = cfgMgr.read();
    expect(reread.backend.baseUrl).toBe('https://api.openai.com/v1');
  });
});

describe('/provider — no args (overlay vs fallback)', () => {
  test('with showOverlay defined → dispatches overlay once, no print', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    const { ctx, output, overlayCalls } = buildCtx({
      overlayDispatcher: () => undefined,
    });
    await cmd.execute('', ctx);
    expect(overlayCalls).toEqual(['provider']);
    expect(output.length).toBe(0);
  });

  test('without showOverlay → prints current backend + usage hint', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Backend');
    expect(joined).toContain('ollama');
    expect(joined).toContain('Use /provider');
  });
});

describe('/provider — unknown subcommand', () => {
  test('prints "Unknown subcommand: …"', async () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('frobnicate', ctx);
    expect(output.join('\n')).toMatch(/Unknown subcommand/);
  });
});

describe('/provider — command metadata', () => {
  test('exposes name, description, and usage strings', () => {
    const cmd = createProviderCommand({ configManager: cfgMgr });
    expect(cmd.name).toBe('provider');
    expect(typeof cmd.description).toBe('string');
    expect(cmd.description.length).toBeGreaterThan(0);
    expect(typeof cmd.usage).toBe('string');
    expect(cmd.usage!.length).toBeGreaterThan(0);
  });

  test('usage string advertises the unsloth verb', () => {
    // Discoverability: `/provider` is where a user goes looking for the
    // provider list, so an unlisted verb is an invisible feature.
    const cmd = createProviderCommand({ configManager: cfgMgr });
    expect(cmd.usage).toContain('unsloth');
  });
});
