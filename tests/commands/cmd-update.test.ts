/**
 * /update — in-session wrapper around the auto-updater singleton.
 *
 * Tests use a stub `UpdaterFacade` so we never touch GitHub. The
 * command is dep-injected with a fake `exit` callback and a tiny
 * `timeoutMs` so the network-timeout branch fires quickly without
 * touching wall-clock time.
 */
import { describe, test, expect } from 'bun:test';
import {
  createUpdateCommand,
  type UpdaterFacade,
} from '@/commands/cmd-update';
import type { CommandContext, AppConfig } from '@/types/global';
import type {
  UpdateState,
  ReleaseInfo,
  PendingUpdate,
} from '@/updater';

// ---------- helpers ----------

function makeRelease(version: string): ReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    htmlUrl: `https://example.invalid/${version}`,
    name: `LocalCode v${version}`,
    body: 'notes',
    prerelease: false,
    publishedAt: 1_700_000_000_000,
    assets: [],
    tarballUrl: `https://example.invalid/${version}.tar.gz`,
  };
}

function makePending(version: string, release: ReleaseInfo): PendingUpdate {
  return {
    version,
    stagedBinaryPath: `/tmp/lc-${version}/cli.js`,
    stagedAt: 1_700_000_001_000,
    digest: null,
    release,
  };
}

interface StubCalls {
  checkNow: number;
  downloadLatest: number;
  applyPending: number;
  skipVersion: string[];
  getState: number;
}

function makeFacade(initial: UpdateState, overrides: Partial<UpdaterFacade> = {}): {
  facade: UpdaterFacade;
  calls: StubCalls;
  setState: (s: UpdateState) => void;
} {
  let state = initial;
  const calls: StubCalls = {
    checkNow: 0,
    downloadLatest: 0,
    applyPending: 0,
    skipVersion: [],
    getState: 0,
  };
  const facade: UpdaterFacade = {
    getState: overrides.getState
      ?? ((): UpdateState => {
        calls.getState++;
        return state;
      }),
    checkNow: overrides.checkNow
      ?? (async (): Promise<UpdateState> => {
        calls.checkNow++;
        return state;
      }),
    downloadLatest: overrides.downloadLatest
      ?? (async (): Promise<{ ok: boolean; error?: string }> => {
        calls.downloadLatest++;
        return { ok: true };
      }),
    applyPending: overrides.applyPending
      ?? (async (): Promise<{ ok: boolean; appliedVersion?: string; error?: string }> => {
        calls.applyPending++;
        return { ok: true, appliedVersion: state.pending?.version };
      }),
    skipVersion: overrides.skipVersion
      ?? (async (v: string): Promise<void> => {
        calls.skipVersion.push(v);
      }),
  };
  return { facade, calls, setState: (s) => { state = s; } };
}

function buildCtx(): { ctx: CommandContext; output: string[] } {
  const output: string[] = [];
  const config = { model: { current: 'm', available: ['m'] } } as unknown as AppConfig;
  const ctx: CommandContext = {
    projectRoot: '/tmp/lc-update-test',
    sessionId: null,
    config,
    print: (t: string) => output.push(t),
    setScreen: () => { /* no-op */ },
  };
  return { ctx, output };
}

const FRESH_STATE: UpdateState = {
  currentVersion: '0.21.0',
  latestRelease: null,
  pending: null,
  lastCheckedAt: null,
  lastError: null,
};

// ---------- /update (no args) ----------

describe('/update (no-args)', () => {
  test('up-to-date — prints the friendly checkmark line', async () => {
    const release = makeRelease('0.21.0');
    const state: UpdateState = {
      currentVersion: '0.21.0',
      latestRelease: release,
      pending: null,
      lastCheckedAt: 1_700_000_000_000,
      lastError: null,
    };
    const { facade } = makeFacade(state);
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.join('\n')).toContain('up-to-date');
    expect(output.join('\n')).toContain('0.21.0');
  });

  test('update available — prints next version + download hint', async () => {
    const release = makeRelease('0.22.0');
    const state: UpdateState = {
      currentVersion: '0.21.0',
      latestRelease: release,
      pending: null,
      lastCheckedAt: 1_700_000_000_000,
      lastError: null,
    };
    const { facade, calls } = makeFacade(state);
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Update available');
    expect(joined).toContain('0.21.0');
    expect(joined).toContain('0.22.0');
    expect(joined).toContain('/update download');
    // cached state — should NOT have run checkNow.
    expect(calls.checkNow).toBe(0);
  });

  test('update available + already downloaded — hints /update apply', async () => {
    const release = makeRelease('0.22.0');
    const state: UpdateState = {
      currentVersion: '0.21.0',
      latestRelease: release,
      pending: makePending('0.22.0', release),
      lastCheckedAt: 1_700_000_000_000,
      lastError: null,
    };
    const { facade } = makeFacade(state);
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('/update apply');
    expect(joined).toContain('downloaded');
  });

  test('not checked yet — runs checkNow', async () => {
    const release = makeRelease('0.22.0');
    let nowCalled = false;
    const facade: UpdaterFacade = {
      getState: () => nowCalled
        ? {
            currentVersion: '0.21.0',
            latestRelease: release,
            pending: null,
            lastCheckedAt: 1,
            lastError: null,
          }
        : FRESH_STATE,
      checkNow: async () => {
        nowCalled = true;
        return {
          currentVersion: '0.21.0',
          latestRelease: release,
          pending: null,
          lastCheckedAt: 1,
          lastError: null,
        };
      },
      downloadLatest: async () => ({ ok: true }),
      applyPending: async () => ({ ok: true, appliedVersion: '0.22.0' }),
      skipVersion: async () => { /* no-op */ },
    };
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(nowCalled).toBe(true);
    expect(output.join('\n')).toContain('Checking for updates');
    expect(output.join('\n')).toContain('Update available');
  });

  test('check timeout — prints friendly timeout line and does not throw', async () => {
    const facade: UpdaterFacade = {
      getState: () => FRESH_STATE,
      checkNow: () => new Promise<UpdateState>(() => { /* never resolves */ }),
      downloadLatest: async () => ({ ok: true }),
      applyPending: async () => ({ ok: true }),
      skipVersion: async () => { /* no-op */ },
    };
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 10,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.join('\n')).toContain('timed out');
  });
});

// ---------- /update apply ----------

describe('/update apply', () => {
  test('staged update — applies, prints upgrade message, calls exit', async () => {
    const release = makeRelease('0.22.0');
    const state: UpdateState = {
      currentVersion: '0.21.0',
      latestRelease: release,
      pending: makePending('0.22.0', release),
      lastCheckedAt: 1,
      lastError: null,
    };
    const { facade, calls } = makeFacade(state);
    let exited = false;
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { exited = true; },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('apply', ctx);
    const joined = output.join('\n');
    expect(joined).toContain('Updating to v0.22.0');
    expect(joined).toContain('Re-run localcode');
    expect(calls.applyPending).toBe(1);
    expect(exited).toBe(true);
  });

  test('no staged update — prints no-op message, does not call exit', async () => {
    const { facade } = makeFacade(FRESH_STATE);
    let exited = false;
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { exited = true; },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('apply', ctx);
    expect(output.join('\n')).toContain('No update staged');
    expect(exited).toBe(false);
  });

  test('apply failure — surfaces error and does not exit', async () => {
    const release = makeRelease('0.22.0');
    const state: UpdateState = {
      currentVersion: '0.21.0',
      latestRelease: release,
      pending: makePending('0.22.0', release),
      lastCheckedAt: 1,
      lastError: null,
    };
    const { facade } = makeFacade(state, {
      applyPending: async () => ({ ok: false, error: 'disk full' }),
    });
    let exited = false;
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { exited = true; },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('apply', ctx);
    expect(output.join('\n')).toContain('Apply failed: disk full');
    expect(exited).toBe(false);
  });
});

// ---------- /update download ----------

describe('/update download', () => {
  test('newer release — downloads + prints next-step hint', async () => {
    const release = makeRelease('0.22.0');
    const state: UpdateState = {
      currentVersion: '0.21.0',
      latestRelease: release,
      pending: null,
      lastCheckedAt: 1,
      lastError: null,
    };
    const { facade, calls } = makeFacade(state);
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('download', ctx);
    expect(calls.downloadLatest).toBe(1);
    expect(output.join('\n')).toContain('Downloading v0.22.0');
    expect(output.join('\n')).toContain('/update apply');
  });

  test('up-to-date — short-circuits without downloading', async () => {
    const release = makeRelease('0.21.0');
    const state: UpdateState = {
      currentVersion: '0.21.0',
      latestRelease: release,
      pending: null,
      lastCheckedAt: 1,
      lastError: null,
    };
    const { facade, calls } = makeFacade(state);
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('download', ctx);
    expect(calls.downloadLatest).toBe(0);
    expect(output.join('\n')).toContain('up-to-date');
  });

  test('download failure — surfaces error', async () => {
    const release = makeRelease('0.22.0');
    const state: UpdateState = {
      currentVersion: '0.21.0',
      latestRelease: release,
      pending: null,
      lastCheckedAt: 1,
      lastError: null,
    };
    const { facade } = makeFacade(state, {
      downloadLatest: async () => ({ ok: false, error: 'network down' }),
    });
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('download', ctx);
    expect(output.join('\n')).toContain('Download failed: network down');
  });
});

// ---------- /update skip ----------

describe('/update skip', () => {
  test('valid version — persists via facade and prints confirmation', async () => {
    const { facade, calls } = makeFacade(FRESH_STATE);
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('skip 0.22.0', ctx);
    expect(calls.skipVersion).toEqual(['0.22.0']);
    expect(output.join('\n')).toContain('Skipped v0.22.0');
  });

  test('strips leading v from displayed version', async () => {
    const { facade } = makeFacade(FRESH_STATE);
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('skip v0.99.0', ctx);
    expect(output.join('\n')).toContain('Skipped v0.99.0');
  });

  test('no argument — prints usage hint', async () => {
    const { facade, calls } = makeFacade(FRESH_STATE);
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('skip', ctx);
    expect(output.join('\n')).toContain('Usage');
    expect(calls.skipVersion.length).toBe(0);
  });
});

// ---------- meta ----------

describe('/update misc', () => {
  test('no updater wired — prints disabled message', async () => {
    const cmd = createUpdateCommand({
      getUpdater: () => null,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('', ctx);
    expect(output.join('\n')).toContain('Auto-update is disabled');
  });

  test('unknown subcommand — prints usage', async () => {
    const { facade } = makeFacade(FRESH_STATE);
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
      timeoutMs: 100,
    });
    const { ctx, output } = buildCtx();
    await cmd.execute('bogus', ctx);
    expect(output.join('\n')).toContain('Unknown subcommand');
    expect(output.join('\n')).toContain('Usage');
  });

  test('exposes stable metadata', () => {
    const { facade } = makeFacade(FRESH_STATE);
    const cmd = createUpdateCommand({
      getUpdater: () => facade,
      exit: () => { /* no-op */ },
    });
    expect(cmd.name).toBe('update');
    expect(cmd.description.length).toBeGreaterThan(0);
    expect(cmd.usage).toBeDefined();
  });
});
