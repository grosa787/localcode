/**
 * /settings — view + reset per-project generation overrides (FIX #35).
 *
 * The command surface:
 *   /settings                 → opens the SettingsOverlay when host
 *                               supplies `showOverlay`; otherwise text.
 *   /settings show / source   → prints Source/Effective/Global/Project.
 *   /settings reset-project   → clears the project `generation` block,
 *                               preserves unrelated top-level keys.
 *   /settings reset           → alias of reset-project.
 *
 * These tests exercise the command against a real `ConfigManager` and
 * tmp project root, capturing all `print` calls into a buffer.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdir,
  rm,
  writeFile as fsWriteFile,
  readFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import { createSettingsCommand } from '@/commands/cmd-settings';
import { getDefaultConfig } from '@/config/defaults';
import type {
  AppConfig,
  CommandContext,
  OverlayKind,
} from '@/types/global';

let tmpDir = '';
let projectRoot = '';
let configPath = '';
let cfgMgr: ConfigManager;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-cmdsettings-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  projectRoot = path.join(tmpDir, 'project');
  await mkdir(projectRoot, { recursive: true });
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
  withOverlay?: boolean;
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
    opts.withOverlay === true
      ? (kind: OverlayKind) => overlayCalls.push(kind)
      : undefined;
  const ctx: CommandContext = {
    projectRoot,
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

// ---------- show / source ----------

describe('/settings show', () => {
  test('prints Source / Effective / Global / Project lines', async () => {
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('show', ctx);

    const joined = output.join('\n');
    expect(joined).toContain('Source:');
    expect(joined).toContain('Effective:');
    expect(joined).toContain('Global:');
    expect(joined).toContain('Project:');
  });

  test('source is "global" when no project file exists', async () => {
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('show', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Source: global');
    expect(joined).toContain('(no overrides)');
  });

  test('source becomes "mixed" or "project" when overrides are present', async () => {
    cfgMgr.writeProjectSettings(projectRoot, { temperature: 0.5 });
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('show', ctx);
    const joined = output.join('\n');
    expect(joined).toMatch(/Source: (mixed|project)/);
    // Project line lists the explicit value plus '—' placeholders for
    // fields the user didn't set.
    expect(joined).toContain('temperature=0.5');
    expect(joined).toContain('—');
  });

  test('"source" alias prints the same content as "show"', async () => {
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx: ctxA, output: outA } = buildCtx();
    const { ctx: ctxB, output: outB } = buildCtx();
    await cmd.execute('show', ctxA);
    await cmd.execute('source', ctxB);
    expect(outB.join('\n')).toContain('Source:');
    expect(outB.join('\n')).toContain('Global:');
    expect(outA.length).toBeGreaterThan(0);
  });
});

// ---------- reset-project ----------

describe('/settings reset-project', () => {
  test('clears project-level overrides, leaving global active', async () => {
    cfgMgr.writeProjectSettings(projectRoot, {
      temperature: 0.7,
      topP: 0.5,
    });
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('reset-project', ctx);

    const joined = output.join('\n');
    expect(joined).toContain('cleared');
    expect(joined.toLowerCase()).toContain('global');

    // After reset, readProjectSettings returns null (no generation).
    const after = cfgMgr.readProjectSettings(projectRoot);
    expect(after).toBeNull();

    // resolveGeneration falls back to global.
    const r = cfgMgr.resolveGeneration(projectRoot);
    expect(r.source).toBe('global');
  });

  test('"reset" is an alias of "reset-project"', async () => {
    cfgMgr.writeProjectSettings(projectRoot, { temperature: 0.5 });
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx } = buildCtx();
    await cmd.execute('reset', ctx);
    const after = cfgMgr.readProjectSettings(projectRoot);
    expect(after).toBeNull();
  });

  test('preserves unrelated top-level keys in settings.json', async () => {
    const dir = path.join(projectRoot, '.localcode');
    await mkdir(dir, { recursive: true });
    await fsWriteFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        future_key: { x: 1 },
        another: 'yes',
        generation: { temperature: 0.9 },
      }),
      'utf8',
    );

    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx } = buildCtx();
    await cmd.execute('reset-project', ctx);

    const text = await readFile(path.join(dir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.future_key).toEqual({ x: 1 });
    expect(parsed.another).toBe('yes');
    expect(parsed.generation).toBeUndefined();
  });

  test('no project file exists → "nothing to clear" message', async () => {
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('reset-project', ctx);
    const joined = output.join('\n').toLowerCase();
    expect(joined).toContain('nothing to clear');
  });
});

// ---------- No-arg overlay routing ----------

describe('/settings — no-arg overlay routing', () => {
  test('with showOverlay → calls showOverlay("settings"), no print', async () => {
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('', ctx);
    expect(overlayCalls).toEqual(['settings']);
    expect(output.length).toBe(0);
  });

  test('without showOverlay → falls through to the text path', async () => {
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.length).toBeGreaterThan(0);
    expect(output.join('\n')).toContain('Source:');
  });

  test('imperative "show" does NOT open the overlay', async () => {
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('show', ctx);
    expect(overlayCalls).toEqual([]);
    expect(output.length).toBeGreaterThan(0);
  });

  test('imperative "reset-project" does NOT open the overlay', async () => {
    cfgMgr.writeProjectSettings(projectRoot, { temperature: 0.4 });
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('reset-project', ctx);
    expect(overlayCalls).toEqual([]);
  });
});

// ---------- Unknown verb ----------

describe('/settings — unknown subcommand', () => {
  test('unknown verb prints usage hint', async () => {
    const cmd = createSettingsCommand({
      configManager: cfgMgr,
      projectRoot,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('totally-bogus', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Unknown subcommand');
    expect(joined).toContain('totally-bogus');
    // Usage banner mentions reset-project / show.
    expect(joined.toLowerCase()).toContain('show');
  });
});
