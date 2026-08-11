/**
 * Unsloth Studio — the surfaces that are SILENT when they regress.
 *
 * Every assertion here covers a place where `tsc` is green either way,
 * so a missing `unsloth` branch ships with no build signal:
 *
 *   - `/ctxsize keepalive` calling a localhost llama.cpp server "cloud".
 *   - The sub-agent prompt's shared-inference-slot hint (single-process
 *     local servers must ask workers for concise reasoning).
 *   - The ProviderOverlay's `--disable-tools` warning, which is the ONLY
 *     place the primary TUI switch path can surface the trap. Rendering
 *     is asserted at source level: ink-testing-library is not a
 *     dependency of this repo, and the alternative (no test at all) is
 *     how the warning became unreachable in the first place.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigManager } from '@/config/config-manager';
import { createCtxSizeCommand } from '@/commands/cmd-ctxsize';
import { getDefaultConfig } from '@/config/defaults';
import { buildWorkerAgentPrompt } from '@/llm/agent-prompts';
import type { AppConfig, CommandContext } from '@/types/global';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', 'src');

let tmpDir = '';
let cfgMgr: ConfigManager;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-unsloth-surf-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  cfgMgr = new ConfigManager(path.join(tmpDir, 'config.toml'));
  const cfg = getDefaultConfig('unsloth');
  cfg.backend.baseUrl = 'http://localhost:8888/v1';
  cfg.model.current = 'unsloth/qwen3-coder-GGUF';
  cfg.model.available = [cfg.model.current];
  cfg.onboarding.completed = true;
  cfgMgr.write(cfg);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function buildCtx(): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  const config: AppConfig = cfgMgr.read();
  const ctx: CommandContext = {
    projectRoot: tmpDir,
    sessionId: null,
    config,
    print: (t) => output.push(t),
    setScreen: () => {
      /* no-op */
    },
  };
  return { ctx, output };
}

describe('/ctxsize on unsloth', () => {
  test('the keep-alive hint does not call a localhost server "cloud"', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('keepalive 600', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Unsloth Studio');
    expect(joined).not.toContain('Cloud / custom backend');
  });

  test('the context-window hint names the launch flag that fixes it', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.join('\n')).toContain('--ctx-size');
  });
});

describe('sub-agent prompt — shared inference slots', () => {
  const base = {
    agentId: 'w1',
    task: 'do a thing',
    ownedFiles: ['a.ts'],
    otherAgents: [],
  };

  test('unsloth workers are told inference is shared', () => {
    const p = buildWorkerAgentPrompt({ ...base, runtimeBackend: 'unsloth' });
    expect(p).toContain('Unsloth Studio');
    expect(p).toContain('concise');
  });

  test('lmstudio keeps its own wording', () => {
    const p = buildWorkerAgentPrompt({ ...base, runtimeBackend: 'lmstudio' });
    expect(p).toContain('LM Studio');
  });

  test('cloud workers get no shared-slot hint', () => {
    const p = buildWorkerAgentPrompt({ ...base, runtimeBackend: 'openai' });
    expect(p).not.toContain('shares');
  });
});

describe('ProviderOverlay — the --disable-tools warning is wired', () => {
  test('renders provider.warn.unsloth for the selected OR highlighted row', async () => {
    const src = await readFile(
      path.join(SRC, 'ui', 'components', 'ProviderOverlay.tsx'),
      'utf8',
    );
    expect(src).toContain("t('provider.warn.unsloth')");
    // Highlight (cursor) matters as much as selection: the user must be
    // able to read the trap BEFORE applying.
    expect(src).toMatch(/selected === 'unsloth' \|\| currentRow\.id === 'unsloth'/);
  });
});

describe('sub-agent concurrency', () => {
  test('single-process local servers cap workers below the cloud default', async () => {
    const src = await readFile(path.join(SRC, 'app.tsx'), 'utf8');
    // The old check named lmstudio only, so unsloth — one llama.cpp/MLX
    // process — silently defaulted to 5 parallel streams.
    expect(src).toMatch(
      /isSingleSlotLocal[\s\S]{0,160}'lmstudio'[\s\S]{0,80}'unsloth'/,
    );
    expect(src).toContain('isSingleSlotLocal ? 3 : 5');
  });
});
