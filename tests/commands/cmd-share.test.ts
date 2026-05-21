/**
 * /share slash-command tests.
 *
 * The coordinator is a hand-rolled stub — we don't need real network
 * behaviour for the command surface (which is just text-in / text-out).
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import { createShareCommand } from '@/commands/cmd-share';
import type { ShareCoordinator } from '@/networking';
import type { AppConfig, CommandContext } from '@/types/global';
import { getDefaultConfig } from '@/config/defaults';

interface StubCoordinator {
  startSharingCalls: Array<{ sessionId: string; mode: string }>;
  stoppedSessions: string[];
  peers: Array<{
    instanceId: string;
    displayName: string;
    host: string;
    port: number;
    capabilities: string[];
    version: string;
    addresses: string[];
    seenAt: number;
  }>;
  acceptResult: string | null;
  acceptError: Error | null;
  asCoordinator(): ShareCoordinator;
}

function makeStub(): StubCoordinator {
  const stub: StubCoordinator = {
    startSharingCalls: [],
    stoppedSessions: [],
    peers: [],
    acceptResult: 'remote-session-1',
    acceptError: null,
    asCoordinator(): ShareCoordinator {
      const shape = {
        startSharing: (sessionId: string, mode: string) => {
          stub.startSharingCalls.push({ sessionId, mode });
          return {
            code: '123456',
            peerUrl: 'localcode://stub@127.0.0.1:9999',
            expiresAt: Date.now() + 60_000,
          };
        },
        stopSharing: (sessionId: string): boolean => {
          stub.stoppedSessions.push(sessionId);
          return true;
        },
        listPeers: () => stub.peers,
        acceptShare: async (_id: string, _code: string) => {
          if (stub.acceptError) throw stub.acceptError;
          return { sessionId: stub.acceptResult ?? '' };
        },
      };
      return shape as unknown as ShareCoordinator;
    },
  };
  return stub;
}

function buildCtx(sessionId: string | null = 'sess-1'): {
  ctx: CommandContext;
  out: string[];
} {
  const out: string[] = [];
  const config: AppConfig = getDefaultConfig('ollama');
  config.model.current = 'm';
  config.onboarding.completed = true;
  const ctx: CommandContext = {
    projectRoot: '/tmp',
    sessionId,
    config,
    print: (t) => out.push(t),
    setScreen: () => {
      /* no-op */
    },
  };
  return { ctx, out };
}

describe('/share — coordinator absent', () => {
  test('every subcommand prints the LAN-disabled message', async () => {
    const cmd = createShareCommand({ getCoordinator: () => null });
    for (const sub of ['start', 'stop', 'peers', 'accept x y']) {
      const { ctx, out } = buildCtx();
      await cmd.execute(sub, ctx);
      expect(out.join('\n')).toMatch(/LAN sharing is disabled/);
    }
  });
});

describe('/share start', () => {
  let stub: StubCoordinator;
  beforeEach(() => {
    stub = makeStub();
  });

  test('with no session, prints a friendly error', async () => {
    const cmd = createShareCommand({ getCoordinator: () => stub.asCoordinator() });
    const { ctx, out } = buildCtx(null);
    await cmd.execute('start', ctx);
    expect(out.join('\n')).toMatch(/No active session/);
    expect(stub.startSharingCalls).toHaveLength(0);
  });

  test('defaults to view mode and prints the 6-digit code', async () => {
    const cmd = createShareCommand({ getCoordinator: () => stub.asCoordinator() });
    const { ctx, out } = buildCtx('sess-1');
    await cmd.execute('start', ctx);
    const joined = out.join('\n');
    expect(joined).toMatch(/Pairing code:\s*123456/);
    expect(joined).toMatch(/Mode:\s*view/);
    expect(stub.startSharingCalls).toEqual([{ sessionId: 'sess-1', mode: 'view' }]);
  });

  test('accepts explicit edit mode', async () => {
    const cmd = createShareCommand({ getCoordinator: () => stub.asCoordinator() });
    const { ctx } = buildCtx('sess-2');
    await cmd.execute('start edit', ctx);
    expect(stub.startSharingCalls[0]?.mode).toBe('edit');
  });

  test('rejects unknown mode argument', async () => {
    const cmd = createShareCommand({ getCoordinator: () => stub.asCoordinator() });
    const { ctx, out } = buildCtx('sess-2');
    await cmd.execute('start nuke', ctx);
    expect(out.join('\n')).toMatch(/Unknown share mode/);
    expect(stub.startSharingCalls).toHaveLength(0);
  });
});

describe('/share stop', () => {
  test('calls stopSharing on the active session', async () => {
    const stub = makeStub();
    const cmd = createShareCommand({ getCoordinator: () => stub.asCoordinator() });
    const { ctx, out } = buildCtx('sess-7');
    await cmd.execute('stop', ctx);
    expect(stub.stoppedSessions).toEqual(['sess-7']);
    expect(out.join('\n')).toMatch(/Session sharing stopped/);
  });
});

describe('/share peers', () => {
  test('prints empty-state when no peers found', async () => {
    const stub = makeStub();
    const cmd = createShareCommand({ getCoordinator: () => stub.asCoordinator() });
    const { ctx, out } = buildCtx();
    await cmd.execute('peers', ctx);
    expect(out.join('\n')).toMatch(/No LocalCode peers discovered/);
  });

  test('lists discovered peers', async () => {
    const stub = makeStub();
    stub.peers.push({
      instanceId: 'abcd1234efgh5678ijkl9012',
      displayName: 'alice@laptop',
      host: '192.168.1.10',
      port: 7878,
      capabilities: ['share-session'],
      version: '1',
      addresses: ['192.168.1.10'],
      seenAt: Date.now(),
    });
    const cmd = createShareCommand({ getCoordinator: () => stub.asCoordinator() });
    const { ctx, out } = buildCtx();
    await cmd.execute('peers', ctx);
    const joined = out.join('\n');
    expect(joined).toMatch(/alice@laptop/);
    expect(joined).toMatch(/192.168.1.10:7878/);
    expect(joined).toMatch(/abcd1234efgh/);
  });
});

describe('/share accept', () => {
  test('requires peer-id and code', async () => {
    const stub = makeStub();
    const cmd = createShareCommand({ getCoordinator: () => stub.asCoordinator() });
    const { ctx, out } = buildCtx();
    await cmd.execute('accept', ctx);
    expect(out.join('\n')).toMatch(/Usage: \/share accept/);
  });

  test('prints connected line on success', async () => {
    const stub = makeStub();
    stub.acceptResult = 'remote-sess';
    const cmd = createShareCommand({ getCoordinator: () => stub.asCoordinator() });
    const { ctx, out } = buildCtx();
    await cmd.execute('accept abc123 654321', ctx);
    expect(out.join('\n')).toMatch(/Mirroring remote session: remote-sess/);
  });

  test('surfaces coordinator errors', async () => {
    const stub = makeStub();
    stub.acceptError = new Error('invalid or expired code');
    const cmd = createShareCommand({ getCoordinator: () => stub.asCoordinator() });
    const { ctx, out } = buildCtx();
    await cmd.execute('accept abc123 654321', ctx);
    expect(out.join('\n')).toMatch(/invalid or expired code/);
  });
});

describe('/share help', () => {
  test('prints usage and subcommand list', async () => {
    const stub = makeStub();
    const cmd = createShareCommand({ getCoordinator: () => stub.asCoordinator() });
    const { ctx, out } = buildCtx();
    await cmd.execute('', ctx);
    const joined = out.join('\n');
    expect(joined).toMatch(/Usage: \/share/);
    expect(joined).toMatch(/peers/);
    expect(joined).toMatch(/accept/);
  });
});
