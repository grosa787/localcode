/**
 * FIX #32 — slash commands open local UI overlays instead of emitting
 * text. When the host wires a `showOverlay` dispatcher into the
 * CommandContext, the no-arg invocation of /permissions, /context,
 * /ctxsize, and /resume should call `showOverlay(<kind>)` and return
 * without printing.
 *
 * Imperative subcommands (e.g. `/permissions add ...`, `/ctxsize keepalive`)
 * still bypass the overlay and apply their effects directly.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '@/config/config-manager';
import { ContextManager } from '@/llm/context-manager';
import { SkillsManager } from '@/skills/skills-manager';
import { SessionManager } from '@/sessions/session-manager';
import { openDb } from '@/sessions/db';
import { createPermissionsCommand } from '@/commands/cmd-permissions';
import { createContextCommand } from '@/commands/cmd-context';
import { createCtxSizeCommand } from '@/commands/cmd-ctxsize';
import { createResumeCommand } from '@/commands/cmd-resume';
import { getDefaultConfig } from '@/config/defaults';
import type { AppConfig, CommandContext, OverlayKind } from '@/types/global';

let tmpDir = '';
let configPath = '';
let cfgMgr: ConfigManager;
let db: Database | null = null;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `lc-overlaycmd-${crypto.randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = path.join(tmpDir, 'config.toml');
  cfgMgr = new ConfigManager(configPath);
  const base = getDefaultConfig('ollama');
  base.model.current = 'm';
  base.model.available = ['m'];
  base.onboarding.completed = true;
  cfgMgr.write(base);
  db = openDb(':memory:');
});

afterEach(async () => {
  try {
    db?.close();
  } catch {
    // ignore
  }
  db = null;
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

describe('/permissions — overlay routing', () => {
  test('with showOverlay → calls showOverlay("permissions") and prints nothing', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('', ctx);
    expect(overlayCalls).toEqual(['permissions']);
    expect(output.length).toBe(0);
  });

  test('"list" alias also opens the overlay', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('list', ctx);
    expect(overlayCalls).toEqual(['permissions']);
    expect(output.length).toBe(0);
  });

  test('"ls" alias also opens the overlay', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('ls', ctx);
    expect(overlayCalls).toEqual(['permissions']);
    expect(output.length).toBe(0);
  });

  test('without showOverlay → falls through to text listing', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.length).toBeGreaterThan(0);
    expect(output.join('\n')).toContain('Auto-approved tools:');
  });

  test('imperative `add write_file` does NOT open the overlay', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('add write_file', ctx);
    expect(overlayCalls).toEqual([]);
    // It still printed something (granted message).
    expect(output.length).toBeGreaterThan(0);

    // And actually persisted the change.
    expect(cfgMgr.read().permissions.autoApprove).toEqual(['write_file']);
  });

  test('imperative `remove` does NOT open the overlay', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    // Seed a grant so removal has something to revoke.
    cfgMgr.update({ permissions: { autoApprove: ['write_file'] } });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('remove write_file', ctx);
    expect(overlayCalls).toEqual([]);
    expect(output.length).toBeGreaterThan(0);
    expect(cfgMgr.read().permissions.autoApprove).toEqual([]);
  });

  test('imperative `clear` does NOT open the overlay', async () => {
    const cmd = createPermissionsCommand({ configManager: cfgMgr });
    cfgMgr.update({ permissions: { autoApprove: ['write_file', 'run_command'] } });
    const { ctx, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('clear', ctx);
    expect(overlayCalls).toEqual([]);
    expect(cfgMgr.read().permissions.autoApprove).toEqual([]);
  });
});

describe('/context — overlay routing', () => {
  test('with showOverlay → calls showOverlay("context") and prints nothing', async () => {
    // Build minimal context manager + skills manager just to satisfy the
    // command's deps. They won't be invoked because the overlay path
    // returns early.
    const ctxMgr = new ContextManager();
    const skillsMgr = new SkillsManager(tmpDir);
    const cmd = createContextCommand({
      contextManager: ctxMgr,
      skillsManager: skillsMgr,
      localcodeMdStatus: () => ({ exists: false, path: 'X' }),
      maxTokens: 8192,
    });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('', ctx);
    expect(overlayCalls).toEqual(['context']);
    expect(output.length).toBe(0);
  });

  test('without showOverlay → prints the textual snapshot', async () => {
    const ctxMgr = new ContextManager();
    const skillsMgr = new SkillsManager(tmpDir);
    const cmd = createContextCommand({
      contextManager: ctxMgr,
      skillsManager: skillsMgr,
      localcodeMdStatus: () => ({ exists: false, path: 'X' }),
      maxTokens: 8192,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.length).toBeGreaterThan(0);
    expect(output.join('\n')).toContain('Context:');
  });
});

describe('/ctxsize — overlay routing', () => {
  test('with showOverlay → calls showOverlay("ctxsize") and prints nothing', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('', ctx);
    expect(overlayCalls).toEqual(['ctxsize']);
    expect(output.length).toBe(0);
  });

  test('without showOverlay → prints the current snapshot', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.length).toBeGreaterThan(0);
    expect(output.join('\n')).toContain('Context window');
  });

  test('imperative `<N>` does NOT open the overlay', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('16384', ctx);
    expect(overlayCalls).toEqual([]);
    expect(cfgMgr.read().context.maxTokens).toBe(16384);
  });

  test('imperative `keepalive 600` does NOT open the overlay', async () => {
    const cmd = createCtxSizeCommand({ configManager: cfgMgr });
    const { ctx, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('keepalive 600', ctx);
    expect(overlayCalls).toEqual([]);
    expect(cfgMgr.read().context.keepAliveSeconds).toBe(600);
  });
});

describe('/resume — overlay routing', () => {
  test('no args with showOverlay → calls showOverlay("resume")', async () => {
    if (!db) throw new Error('db not initialised');
    const sm = new SessionManager(db);
    const cmd = createResumeCommand({
      sessionManager: sm,
      setScreen: () => {
        /* no-op */
      },
      loadSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('', ctx);
    expect(overlayCalls).toEqual(['resume']);
    expect(output.length).toBe(0);
  });

  test('"list" alias with showOverlay → also opens the overlay', async () => {
    if (!db) throw new Error('db not initialised');
    const sm = new SessionManager(db);
    const cmd = createResumeCommand({
      sessionManager: sm,
      setScreen: () => {
        /* no-op */
      },
      loadSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute('list', ctx);
    expect(overlayCalls).toEqual(['resume']);
    expect(output.length).toBe(0);
  });

  test('imperative `<idPrefix>` triggers loadSession (does NOT open overlay)', async () => {
    if (!db) throw new Error('db not initialised');
    const sm = new SessionManager(db);
    const session = sm.createSession(tmpDir, 'm', 'ollama');
    const captured: { id: string | null } = { id: null };
    const cmd = createResumeCommand({
      sessionManager: sm,
      setScreen: () => {
        /* no-op */
      },
      loadSession: async (id: string) => {
        captured.id = id;
      },
    });
    const { ctx, overlayCalls } = buildCtx({ withOverlay: true });
    await cmd.execute(session.id.slice(0, 8), ctx);
    expect(overlayCalls).toEqual([]);
    expect(captured.id).toBe(session.id);
  });

  test('without showOverlay → prints the recent-sessions table', async () => {
    if (!db) throw new Error('db not initialised');
    const sm = new SessionManager(db);
    sm.createSession(tmpDir, 'm', 'ollama');
    const cmd = createResumeCommand({
      sessionManager: sm,
      setScreen: () => {
        /* no-op */
      },
      loadSession: async () => {
        /* no-op */
      },
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.length).toBeGreaterThan(0);
    expect(output.join('\n')).toContain('Recent sessions');
  });
});
